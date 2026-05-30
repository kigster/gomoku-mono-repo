from datetime import UTC, datetime, timedelta

import asyncpg
import pytest
from httpx import AsyncClient

from tests.conftest import SAMPLE_GAME_JSON, TEST_DSN


@pytest.mark.asyncio
async def test_user_me_authenticated(client: AsyncClient, auth_headers, registered_user):
    username, _ = registered_user
    resp = await client.get("/user/me", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert data["username"] == username
    assert data["email"] == "test@example.com"
    assert len(data["id"]) == 36  # UUID
    assert data["personal_best"] is None


@pytest.mark.asyncio
async def test_user_me_unauthenticated(client: AsyncClient):
    resp = await client.get("/user/me")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_user_me_invalid_token(client: AsyncClient):
    resp = await client.get("/user/me", headers={"Authorization": "Bearer invalid.token.here"})
    assert resp.status_code == 401


async def _read_last_seen(username: str):
    conn = await asyncpg.connect(TEST_DSN)
    try:
        return await conn.fetchval(
            "SELECT last_seen_at FROM users WHERE username = $1", username
        )
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_seen_advances_last_seen_when_incoming_is_newer(
    client: AsyncClient, auth_headers
):
    """Posting a fresh timestamp moves users.last_seen_at forward."""
    fresh = datetime.now(UTC) + timedelta(seconds=5)
    resp = await client.post(
        "/users/me/seen",
        headers=auth_headers,
        json={"last_seen_at": fresh.isoformat()},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert datetime.fromisoformat(body["last_seen_at"]).replace(
        microsecond=0
    ) == fresh.replace(microsecond=0)
    stored = await _read_last_seen("testplayer")
    assert stored is not None
    assert stored.replace(microsecond=0) == fresh.replace(microsecond=0)


@pytest.mark.asyncio
async def test_seen_is_no_op_when_incoming_is_stale(
    client: AsyncClient, auth_headers
):
    """A timestamp older than the stored value is silently rejected
    (the stored value remains, and the response echoes it back)."""
    # Park last_seen_at near "now" so any reasonable backdate is older.
    await _read_last_seen("testplayer")  # warm-up; ignore result
    fresh = datetime.now(UTC) + timedelta(seconds=10)
    await client.post(
        "/users/me/seen",
        headers=auth_headers,
        json={"last_seen_at": fresh.isoformat()},
    )
    stale = datetime.now(UTC) - timedelta(hours=1)
    resp = await client.post(
        "/users/me/seen",
        headers=auth_headers,
        json={"last_seen_at": stale.isoformat()},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    echoed = datetime.fromisoformat(body["last_seen_at"])
    assert echoed.replace(microsecond=0) == fresh.replace(microsecond=0)
    stored = await _read_last_seen("testplayer")
    assert stored.replace(microsecond=0) == fresh.replace(microsecond=0)


@pytest.mark.asyncio
async def test_seen_rejects_missing_body(client: AsyncClient, auth_headers):
    resp = await client.post("/users/me/seen", headers=auth_headers, json={})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_seen_requires_authentication(client: AsyncClient):
    resp = await client.post(
        "/users/me/seen",
        json={"last_seen_at": datetime.now(UTC).isoformat()},
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_get_current_user_does_not_bump_last_seen(
    client: AsyncClient, auth_headers
):
    """The auth dependency is read-only now — calling an authed endpoint
    no longer advances users.last_seen_at on its own. Backdate it and
    verify a /user/me call leaves it alone."""
    backdated = datetime.now(UTC) - timedelta(minutes=30)
    conn = await asyncpg.connect(TEST_DSN)
    try:
        await conn.execute(
            "UPDATE users SET last_seen_at = $1 WHERE username = $2",
            backdated,
            "testplayer",
        )
    finally:
        await conn.close()
    resp = await client.get("/user/me", headers=auth_headers)
    assert resp.status_code == 200
    after = await _read_last_seen("testplayer")
    # Exact equality, modulo Postgres' microsecond rounding noise.
    assert after.replace(microsecond=0) == backdated.replace(microsecond=0)


@pytest.mark.asyncio
async def test_user_me_with_personal_best(client: AsyncClient, auth_headers):
    # Save a winning game
    await client.post(
        "/game/save",
        headers=auth_headers,
        json={
            "game_json": SAMPLE_GAME_JSON,
        },
    )

    resp = await client.get("/user/me", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    best = data["personal_best"]
    assert best is not None
    assert best["score"] > 0
    assert best["depth"] == 5
    assert best["radius"] == 3
