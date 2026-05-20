import os
import subprocess
import sys
from pathlib import Path

import asyncpg
import httpx
import pytest
from httpx import ASGITransport, AsyncClient

# === Test-environment isolation ===
# Force ENVIRONMENT to "test" (or "ci" on CI) before any app import so
# Pydantic loads api/.env.test instead of .env.development. Direct assign
# (not setdefault) because api/.envrc exports ENVIRONMENT=development by
# default and would otherwise win.
#
# Production secrets in the root .env are named PRODUCTION_DATABASE_URL /
# PRODUCTION_JWT_SECRET specifically so they cannot shadow runtime config
# here even if `just dotenv-load` walks up to the root .env.
_api_dir = Path(__file__).resolve().parent.parent
os.environ["ENVIRONMENT"] = "ci" if os.environ.get("CI") else "test"

# Email isolation — the repo-root .env (consumed by .envrc's `dotenv`)
# can set EMAIL_PROVIDER=sendgrid + SENDGRID_API_KEY for local password-
# reset testing. Pydantic reads process env, so without this scrub the
# tests would actually POST to SendGrid (and fail with 401 against a
# revoked dev key). Force stdout mode regardless of shell state.
os.environ["EMAIL_PROVIDER"] = "stdout"
os.environ.pop("SENDGRID_API_KEY", None)

from app.config import settings  # noqa: E402
from app.database import create_pool  # noqa: E402
from app.main import app, fastapi_app  # noqa: E402

# Per-worker DB suffix for pytest-xdist. With `pytest -n auto`, each worker
# (`gw0`, `gw1`, ...) gets its own database (`gomoku_test_gw0`, ...). Without
# this, parallel runs collide on the per-test TRUNCATE in the client fixture.
# Sequential runs (no PYTEST_XDIST_WORKER) keep using the plain DB name.
_WORKER = os.environ.get("PYTEST_XDIST_WORKER")
if _WORKER:
    _base = settings.database_url or "postgresql://postgres@localhost:5432/gomoku_test"
    _head, _db = _base.rsplit("/", 1)
    _name, _, _query = _db.partition("?")
    _suffixed = f"{_head}/{_name}_{_WORKER}" + (f"?{_query}" if _query else "")
    settings.database_url = _suffixed
    os.environ["DATABASE_URL"] = _suffixed  # alembic subprocess inherits this

TEST_DSN = settings.database_dsn

# Admin DSN — same host/credentials, but connect to "postgres" DB so we can
# CREATE DATABASE if the test DB doesn't exist yet.
_dsn_head, _dsn_db_part = TEST_DSN.rsplit("/", 1)
_test_db = _dsn_db_part.split("?")[0]
_admin_dsn = f"{_dsn_head}/postgres"


def _redact(dsn: str) -> str:
    """Drop password if present so it doesn't leak into pytest output."""
    # postgresql://user:pass@host/db → postgresql://user:***@host/db
    if "@" not in dsn or "://" not in dsn:
        return dsn
    scheme, rest = dsn.split("://", 1)
    creds, host = rest.split("@", 1)
    if ":" in creds:
        user = creds.split(":", 1)[0]
        return f"{scheme}://{user}:***@{host}"
    return dsn


print(
    f"\n[conftest] ENVIRONMENT={settings.environment} TEST_DSN={_redact(TEST_DSN)}",
    file=sys.stderr,
    flush=True,
)

# Safety guard: if the resolved DSN is not pointing at localhost, fail loudly.
# Override with PYTEST_ALLOW_REMOTE_DB=1 if you really know what you're doing.
_dsn_lower = TEST_DSN.lower()
if (
    not any(local in _dsn_lower for local in ("@localhost", "@127.0.0.1", "@/"))
    and os.environ.get("PYTEST_ALLOW_REMOTE_DB") != "1"
):
    raise SystemExit(
        f"\n[conftest] REFUSING to run tests against non-local DB:\n"
        f"  TEST_DSN={_redact(TEST_DSN)}\n"
        f"  ENVIRONMENT={settings.environment}\n"
        f"  Expected api/.env.test to point at localhost. Likely cause: "
        f"DATABASE_URL is exported in your shell or .envrc, leaking past Pydantic. "
        f"Set PYTEST_ALLOW_REMOTE_DB=1 to bypass this check.\n"
    )

_initialized = False


async def _ensure_initialized():
    global _initialized
    if _initialized:
        return
    _initialized = True

    # Create test database if it doesn't exist
    conn = await asyncpg.connect(_admin_dsn)
    try:
        exists = await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", _test_db)
        if not exists:
            await conn.execute(f'CREATE DATABASE "{_test_db}"')
    finally:
        await conn.close()

    # Run Alembic migrations (upgrade to head)
    env = {**os.environ, "DATABASE_URL": TEST_DSN}
    subprocess.run(
        ["uv", "run", "alembic", "upgrade", "head"],
        cwd=str(_api_dir),
        env=env,
        check=True,
        capture_output=True,
    )

    # Initialize app state on the FastAPI instance (not the ASGI wrapper)
    fastapi_app.state.db_pool = await create_pool()
    fastapi_app.state.httpx_client = httpx.AsyncClient(
        base_url="http://localhost:1",
        timeout=httpx.Timeout(5.0),
    )


@pytest.fixture(scope="session", autouse=True)
async def _close_app_resources():
    """Close pool/client at end of session, drop per-worker DBs on xdist runs.

    Without the close, the pytest process hangs ~5-10s on exit per worker
    while asyncio waits for asyncpg's idle-connection draining and httpx's
    anyio threadpool teardown. Especially noticeable with pytest-xdist
    where each worker holds its own pool.

    The worker-DB drop keeps the local Postgres tidy: only `gomoku` and
    `gomoku_test` remain after a parallel run. Sequential runs use the
    shared `gomoku_test` and we leave it intact for fast re-runs.
    """
    yield
    pool = getattr(fastapi_app.state, "db_pool", None)
    if pool is not None:
        await pool.close()
    client = getattr(fastapi_app.state, "httpx_client", None)
    if client is not None:
        await client.aclose()

    if _WORKER:
        admin = await asyncpg.connect(_admin_dsn)
        try:
            # WITH (FORCE) terminates any straggling connections (Postgres ≥ 13).
            await admin.execute(f'DROP DATABASE IF EXISTS "{_test_db}" WITH (FORCE)')
        finally:
            await admin.close()


@pytest.fixture
async def client():
    """Async HTTP client wired to the FastAPI app."""
    await _ensure_initialized()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    conn = await asyncpg.connect(TEST_DSN)
    try:
        await conn.execute("TRUNCATE games, password_reset_tokens, users CASCADE")
    finally:
        await conn.close()


@pytest.fixture
async def registered_user(client: AsyncClient):
    """Create a user and return (username, token)."""
    resp = await client.post(
        "/auth/signup",
        json={
            "username": "testplayer",
            "password": "testpass123",
            "email": "test@example.com",
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    return data["username"], data["access_token"]


@pytest.fixture
def auth_headers(registered_user):
    """Authorization headers for authenticated requests."""
    _, token = registered_user
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
async def make_user(client: AsyncClient):
    """Factory: create a fresh user with a unique username, return (username, token, headers).

    Usage:
        async def test_x(make_user):
            host = await make_user("alice")
            guest = await make_user("bob")
            await client.post("/foo", headers=host["headers"])
    """

    async def _factory(name: str, *, password: str = "pass1234", email: str | None = None):
        if email is None:
            email = f"{name}@example.com"
        resp = await client.post(
            "/auth/signup",
            json={"username": name, "password": password, "email": email},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        return {
            "username": data["username"],
            "token": data["access_token"],
            "headers": {"Authorization": f"Bearer {data['access_token']}"},
        }

    return _factory


@pytest.fixture
async def second_registered_user(make_user):
    """A second authenticated user, distinct from `registered_user` ('testplayer').

    Returns a dict with keys `username`, `token`, `headers` so multiplayer tests
    can address the two participants by name without re-deriving headers each
    time. Mirrors the `registered_user` pattern but doesn't break it: the
    usernames/emails are different so the per-test TRUNCATE keeps both rows
    isolated.
    """
    return await make_user("secondplayer", email="second@example.com")


SAMPLE_GAME_JSON = {
    "X": {"player": "human", "depth": 3, "time_ms": 5000},
    "O": {"player": "AI", "depth": 5, "time_ms": 3000},
    "board_size": 19,
    "radius": 3,
    "timeout": "none",
    "winner": "X",
    "board_state": [],
    "moves": [
        {"X (human)": "J10", "time_ms": 1000},
        {"O (AI)": "K11", "time_ms": 500},
        {"X (human)": "J9", "time_ms": 2000},
        {"O (AI)": "K10", "time_ms": 500},
        {"X (human)": "J8", "time_ms": 1500},
        {"O (AI)": "K9", "time_ms": 500},
        {"X (human)": "J7", "time_ms": 800},
        {"O (AI)": "K8", "time_ms": 500},
        {"X (human)": "J6", "time_ms": 700, "winner": True},
    ],
}
