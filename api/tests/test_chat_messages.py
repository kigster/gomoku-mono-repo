"""Tests for POST/GET /chat/{code}/messages + abandoned_by_user_id.

The chat-message persistence layer assumes every multiplayer_games row
has a paired chats row from birth — that contract lives in
`app.multiplayer.allocate.allocate_game`, exercised end-to-end here by
creating real games and sending real messages.
"""

from __future__ import annotations

import asyncpg
import pytest
from httpx import AsyncClient

from tests.conftest import TEST_DSN


async def _create_in_progress_game(
    client: AsyncClient, host_headers: dict, guest_headers: dict
) -> str:
    """Create a multiplayer game and have the guest join, returning the code."""
    created = (await client.post("/multiplayer/new", headers=host_headers, json={})).json()
    code = created["code"]
    joined = await client.post(f"/multiplayer/{code}/join", headers=guest_headers, json={})
    assert joined.status_code == 200, joined.text
    return code


# ---------------------------------------------------------------------------
# Chats row is created eagerly with the multiplayer_games row
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_chats_row_created_with_multiplayer_game(
    client: AsyncClient, auth_headers
):
    """`allocate_game` creates a chats row in the same transaction as the
    multiplayer_games row. POST /multiplayer/new is enough to trigger it
    — no guest, no messages, no endpoint hit on the chat side."""
    created = (await client.post("/multiplayer/new", headers=auth_headers, json={})).json()
    code = created["code"]
    conn = await asyncpg.connect(TEST_DSN)
    try:
        row = await conn.fetchrow(
            """
            SELECT c.id FROM chats c
            JOIN multiplayer_games mg ON mg.id = c.multiplayer_game_id
            WHERE mg.code = $1
            """,
            code,
        )
    finally:
        await conn.close()
    assert row is not None, "chats row should be created with the game"


# ---------------------------------------------------------------------------
# POST /chat/{code}/messages
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_message_happy_path(
    client: AsyncClient, auth_headers, registered_user, second_registered_user
):
    code = await _create_in_progress_game(
        client, auth_headers, second_registered_user["headers"]
    )
    resp = await client.post(
        f"/chat/{code}/messages",
        headers=auth_headers,
        json={"message": "hello opponent"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["message"] == "hello opponent"
    assert body["speaker_username"] == registered_user[0]
    assert body["speaker_is_me"] is True
    assert "id" in body
    assert "created_at" in body


@pytest.mark.asyncio
async def test_post_message_non_participant_returns_403(
    client: AsyncClient, auth_headers, second_registered_user, make_user
):
    """Only host or guest can post into the chat — a third party is 403."""
    code = await _create_in_progress_game(
        client, auth_headers, second_registered_user["headers"]
    )
    eve = await make_user("eve")
    resp = await client.post(
        f"/chat/{code}/messages",
        headers=eve["headers"],
        json={"message": "lurking"},
    )
    assert resp.status_code == 403
    assert "not_a_participant" in resp.text


@pytest.mark.asyncio
async def test_post_message_unknown_code_returns_404(
    client: AsyncClient, auth_headers
):
    resp = await client.post(
        "/chat/ZZZZZZ/messages", headers=auth_headers, json={"message": "hi"}
    )
    assert resp.status_code == 404
    assert "multiplayer_game_not_found" in resp.text


@pytest.mark.asyncio
async def test_post_message_length_rejected(
    client: AsyncClient, auth_headers, second_registered_user
):
    """Pydantic rejects > 500-char messages with a 422 before they hit the DB."""
    code = await _create_in_progress_game(
        client, auth_headers, second_registered_user["headers"]
    )
    too_long = "x" * 501
    resp = await client.post(
        f"/chat/{code}/messages",
        headers=auth_headers,
        json={"message": too_long},
    )
    assert resp.status_code == 422

    empty = await client.post(
        f"/chat/{code}/messages", headers=auth_headers, json={"message": ""}
    )
    assert empty.status_code == 422


@pytest.mark.asyncio
async def test_post_message_stores_slash_command_verbatim(
    client: AsyncClient, auth_headers, second_registered_user
):
    """Slash-command bodies are stored verbatim — "store first, post-process
    later". The endpoint does NOT dispatch the side effect; the client does
    that after the POST returns."""
    code = await _create_in_progress_game(
        client, auth_headers, second_registered_user["headers"]
    )
    resp = await client.post(
        f"/chat/{code}/messages",
        headers=auth_headers,
        json={"message": "/follow @somebody"},
    )
    assert resp.status_code == 200
    assert resp.json()["message"] == "/follow @somebody"


# ---------------------------------------------------------------------------
# GET /chat/{code}/messages
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_messages_returns_all_in_order(
    client: AsyncClient, auth_headers, second_registered_user
):
    code = await _create_in_progress_game(
        client, auth_headers, second_registered_user["headers"]
    )
    # Host posts two, then guest posts one.
    await client.post(
        f"/chat/{code}/messages", headers=auth_headers, json={"message": "one"}
    )
    await client.post(
        f"/chat/{code}/messages", headers=auth_headers, json={"message": "two"}
    )
    await client.post(
        f"/chat/{code}/messages",
        headers=second_registered_user["headers"],
        json={"message": "three"},
    )
    resp = await client.get(f"/chat/{code}/messages", headers=auth_headers)
    assert resp.status_code == 200
    bodies = [m["message"] for m in resp.json()["messages"]]
    assert bodies == ["one", "two", "three"]


@pytest.mark.asyncio
async def test_get_messages_speaker_is_me_is_caller_relative(
    client: AsyncClient, auth_headers, second_registered_user
):
    """The same row should report `speaker_is_me=True` for the speaker and
    `False` for the other participant. This is what lets the frontend
    render bubbles on the right side for the local user without an extra
    lookup."""
    code = await _create_in_progress_game(
        client, auth_headers, second_registered_user["headers"]
    )
    await client.post(
        f"/chat/{code}/messages", headers=auth_headers, json={"message": "from host"}
    )
    # Host sees their own message as "me".
    host_view = (await client.get(f"/chat/{code}/messages", headers=auth_headers)).json()
    assert host_view["messages"][0]["speaker_is_me"] is True
    # Guest sees the same row as not-me.
    guest_view = (
        await client.get(
            f"/chat/{code}/messages", headers=second_registered_user["headers"]
        )
    ).json()
    assert guest_view["messages"][0]["speaker_is_me"] is False


@pytest.mark.asyncio
async def test_get_messages_with_since_returns_only_new(
    client: AsyncClient, auth_headers, second_registered_user
):
    code = await _create_in_progress_game(
        client, auth_headers, second_registered_user["headers"]
    )
    await client.post(
        f"/chat/{code}/messages", headers=auth_headers, json={"message": "old"}
    )
    await client.post(
        f"/chat/{code}/messages", headers=auth_headers, json={"message": "new"}
    )
    # since=1 skips the first message; since=2 yields nothing.
    after_one = (
        await client.get(f"/chat/{code}/messages?since=1", headers=auth_headers)
    ).json()
    assert [m["message"] for m in after_one["messages"]] == ["new"]
    after_two = (
        await client.get(f"/chat/{code}/messages?since=2", headers=auth_headers)
    ).json()
    assert after_two["messages"] == []


@pytest.mark.asyncio
async def test_get_messages_non_participant_returns_403(
    client: AsyncClient, auth_headers, second_registered_user, make_user
):
    code = await _create_in_progress_game(
        client, auth_headers, second_registered_user["headers"]
    )
    eve = await make_user("eve_lurker")
    resp = await client.get(f"/chat/{code}/messages", headers=eve["headers"])
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# abandoned_by_user_id (block-cascade path)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_block_cascade_records_abandoned_by(
    client: AsyncClient, auth_headers, registered_user, second_registered_user
):
    """When /social/block terminates an in_progress game, the blocker is
    recorded as `abandoned_by_user_id` and `abandoned_at` is stamped."""
    host_name = registered_user[0]
    code = await _create_in_progress_game(
        client, auth_headers, second_registered_user["headers"]
    )
    # The host blocks the guest — terminates the active game as abandoned.
    blocked = await client.post(
        "/social/block",
        headers=auth_headers,
        json={"target_username": second_registered_user["username"]},
    )
    assert blocked.status_code == 200, blocked.text
    assert blocked.json()["game_terminated"] is True

    conn = await asyncpg.connect(TEST_DSN)
    try:
        row = await conn.fetchrow(
            """
            SELECT mg.state,
                   mg.abandoned_by_user_id,
                   mg.abandoned_at,
                   u.username AS abandoned_by_username
            FROM   multiplayer_games mg
            LEFT JOIN users u ON u.id = mg.abandoned_by_user_id
            WHERE  mg.code = $1
            """,
            code,
        )
    finally:
        await conn.close()
    assert row is not None
    assert row["state"] == "abandoned"
    assert row["abandoned_by_user_id"] is not None
    assert row["abandoned_at"] is not None
    assert row["abandoned_by_username"] == host_name
