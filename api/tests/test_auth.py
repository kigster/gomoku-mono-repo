from datetime import UTC, datetime, timedelta

import asyncpg
import pytest
from httpx import AsyncClient

from tests.conftest import TEST_DSN


@pytest.mark.asyncio
async def test_signup_success(client: AsyncClient):
    resp = await client.post(
        "/auth/signup",
        json={
            "username": "newuser",
            "password": "pass1234",
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["username"] == "newuser"
    assert "access_token" in data
    assert data["token_type"] == "bearer"


@pytest.mark.asyncio
async def test_signup_with_email(client: AsyncClient):
    resp = await client.post(
        "/auth/signup",
        json={
            "username": "emailuser",
            "password": "pass1234",
            "email": "user@example.com",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["username"] == "emailuser"


@pytest.mark.asyncio
async def test_signup_duplicate_username(client: AsyncClient):
    await client.post(
        "/auth/signup",
        json={
            "username": "taken",
            "password": "pass1234",
        },
    )
    resp = await client.post(
        "/auth/signup",
        json={
            "username": "taken",
            "password": "different",
        },
    )
    assert resp.status_code == 409
    assert "already taken" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_signup_short_password(client: AsyncClient):
    resp = await client.post(
        "/auth/signup",
        json={
            "username": "shortpw",
            "password": "abc",
        },
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_signup_short_username(client: AsyncClient):
    resp = await client.post(
        "/auth/signup",
        json={
            "username": "a",
            "password": "pass1234",
        },
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_login_success(client: AsyncClient):
    await client.post(
        "/auth/signup",
        json={
            "username": "logintest",
            "password": "pass1234",
        },
    )
    resp = await client.post(
        "/auth/login",
        json={
            "username": "logintest",
            "password": "pass1234",
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["username"] == "logintest"
    assert "access_token" in data


@pytest.mark.asyncio
async def test_login_stamps_session_started_at(client: AsyncClient):
    """A successful login (re)stamps session_started_at to now, so the
    Who's Online "Since" column reflects the fresh session rather than a
    day-old heartbeat or the signup default."""
    await client.post(
        "/auth/signup",
        json={"username": "sessionstamp", "password": "pass1234"},
    )
    long_ago = datetime.now(UTC) - timedelta(days=1)
    conn = await asyncpg.connect(TEST_DSN)
    try:
        await conn.execute(
            "UPDATE users SET session_started_at = $1 WHERE username = 'sessionstamp'",
            long_ago,
        )
    finally:
        await conn.close()
    resp = await client.post(
        "/auth/login",
        json={"username": "sessionstamp", "password": "pass1234"},
    )
    assert resp.status_code == 200, resp.text
    conn = await asyncpg.connect(TEST_DSN)
    try:
        session = await conn.fetchval(
            "SELECT session_started_at FROM users WHERE username = 'sessionstamp'"
        )
    finally:
        await conn.close()
    assert session is not None
    # Jumped forward to ~now, not the backdated day-old value.
    assert (datetime.now(UTC) - session).total_seconds() < 60


@pytest.mark.asyncio
async def test_login_case_insensitive_username(client: AsyncClient):
    await client.post(
        "/auth/signup",
        json={
            "username": "CaseUser",
            "password": "pass1234",
        },
    )
    resp = await client.post(
        "/auth/login",
        json={
            "username": "caseuser",
            "password": "pass1234",
        },
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_login_wrong_password(client: AsyncClient):
    await client.post(
        "/auth/signup",
        json={
            "username": "wrongpw",
            "password": "pass1234",
        },
    )
    resp = await client.post(
        "/auth/login",
        json={
            "username": "wrongpw",
            "password": "wrongpass",
        },
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_login_nonexistent_user(client: AsyncClient):
    resp = await client.post(
        "/auth/login",
        json={
            "username": "ghost",
            "password": "pass1234",
        },
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_password_reset_request(client: AsyncClient):
    await client.post(
        "/auth/signup",
        json={
            "username": "resetuser",
            "password": "pass1234",
            "email": "reset@example.com",
        },
    )
    resp = await client.post(
        "/auth/password-reset",
        json={
            "email": "reset@example.com",
        },
    )
    assert resp.status_code == 200
    # Always returns success (no email enumeration)
    assert "email" in resp.json()["message"].lower() or "sent" in resp.json()["message"].lower()


@pytest.mark.asyncio
async def test_password_reset_nonexistent_email(client: AsyncClient):
    resp = await client.post(
        "/auth/password-reset",
        json={
            "email": "nobody@example.com",
        },
    )
    # Should still return 200 (no enumeration)
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_password_reset_confirm_invalid_token(client: AsyncClient):
    resp = await client.post(
        "/auth/password-reset/confirm",
        json={
            "token": "invalid-token",
            "new_password": "newpass123",
        },
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_password_reset_full_flow(client: AsyncClient):
    """Full flow: signup, request reset, grab token from DB, confirm, login with new password."""
    await client.post(
        "/auth/signup",
        json={"username": "resetflow", "password": "oldpass123", "email": "flow@example.com"},
    )

    await client.post("/auth/password-reset", json={"email": "flow@example.com"})

    # Grab the token directly from DB
    conn = await asyncpg.connect(TEST_DSN)
    try:
        token = await conn.fetchval(
            "SELECT token FROM password_reset_tokens ORDER BY created_at DESC LIMIT 1"
        )
    finally:
        await conn.close()
    assert token is not None

    resp = await client.post(
        "/auth/password-reset/confirm",
        json={"token": token, "new_password": "newpass456"},
    )
    assert resp.status_code == 200
    assert "updated" in resp.json()["message"].lower()

    # Login with the new password
    resp = await client.post(
        "/auth/login", json={"username": "resetflow", "password": "newpass456"}
    )
    assert resp.status_code == 200
    assert "access_token" in resp.json()

    # Old password should fail
    resp = await client.post(
        "/auth/login", json={"username": "resetflow", "password": "oldpass123"}
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_password_reset_confirm_short_password(client: AsyncClient):
    """Short new_password on confirm should fail validation."""
    resp = await client.post(
        "/auth/password-reset/confirm",
        json={"token": "any-token", "new_password": "abc"},
    )
    assert resp.status_code == 422
