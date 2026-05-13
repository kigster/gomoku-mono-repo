"""Tests for /chat/invite — the only chat endpoint that ships in this
PR. Covers presence detection (in_game vs idle), code allocation,
self-target rejection, blocked-target rejection, and 404 on unknown
target.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_invite_idle_target_returns_idle_state_and_code(client: AsyncClient, make_user):
    alice = await make_user("alice")
    await make_user("bob")
    resp = await client.post(
        "/chat/invite",
        headers=alice["headers"],
        json={"target_username": "bob"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["target_state"] == "idle"
    # bob just signed up (last_seen_at fresh), so he's not offline →
    # the invite is treated as delivered to a polling client.
    assert body["delivered"] is True
    assert len(body["invited_code"]) == 6
    assert body["invite_url"].endswith(f"/play/{body['invited_code']}")


@pytest.mark.asyncio
async def test_invite_in_game_target_returns_in_game(client: AsyncClient, make_user):
    alice = await make_user("alice")
    bob = await make_user("bob")
    carol = await make_user("carol")

    # Bob is already busy in a game with Carol.
    new_resp = await client.post(
        "/multiplayer/new",
        headers=bob["headers"],
        json={"host_color": "X", "board_size": 15},
    )
    assert new_resp.status_code == 200
    code = new_resp.json()["code"]
    join_resp = await client.post(
        f"/multiplayer/{code}/join",
        headers=carol["headers"],
        json={},
    )
    assert join_resp.status_code == 200

    # Alice tries to invite Bob — server reports he's in_game.
    resp = await client.post(
        "/chat/invite",
        headers=alice["headers"],
        json={"target_username": "bob"},
    )
    assert resp.status_code == 200
    assert resp.json()["target_state"] == "in_game"


@pytest.mark.asyncio
async def test_invite_unknown_target_404(client: AsyncClient, auth_headers):
    resp = await client.post(
        "/chat/invite",
        headers=auth_headers,
        json={"target_username": "ghost-user"},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_invite_self_400(client: AsyncClient, registered_user):
    name, token = registered_user
    resp = await client.post(
        "/chat/invite",
        headers={"Authorization": f"Bearer {token}"},
        json={"target_username": name},
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_invite_when_blocked_returns_403(client: AsyncClient, make_user):
    alice = await make_user("alice")
    bob = await make_user("bob")
    # Bob blocks Alice → Alice can no longer invite Bob.
    block_resp = await client.post(
        "/social/block",
        headers=bob["headers"],
        json={"target_username": "alice"},
    )
    assert block_resp.status_code == 200
    invite_resp = await client.post(
        "/chat/invite",
        headers=alice["headers"],
        json={"target_username": "bob"},
    )
    assert invite_resp.status_code == 403


@pytest.mark.asyncio
async def test_invite_creates_real_game_target_can_join(client: AsyncClient, make_user):
    alice = await make_user("alice")
    bob = await make_user("bob")
    invite_resp = await client.post(
        "/chat/invite",
        headers=alice["headers"],
        json={"target_username": "bob"},
    )
    assert invite_resp.status_code == 200
    code = invite_resp.json()["invited_code"]

    # Bob should be able to walk up to that code and join — proving the
    # invite isn't a fake/placeholder.
    join_resp = await client.post(
        f"/multiplayer/{code}/join",
        headers=bob["headers"],
        json={},
    )
    assert join_resp.status_code == 200
    assert join_resp.json()["state"] == "in_progress"


# ---------------------------------------------------------------------------
# Rolling-window rate limit (INVITE_HOURLY_CAP / INVITE_DAILY_CAP)
# ---------------------------------------------------------------------------


async def _backdate_invites(host_username: str, minutes: int) -> None:
    """Push every invite-created game by `host_username` back by N minutes.

    Lets us simulate the passage of time without freezegun: send a
    burst of invites, then age them so the next batch is "in a new
    window." Touches only invite rows so modal-created games (if any)
    are untouched.
    """
    import asyncpg

    from app.config import settings

    conn = await asyncpg.connect(settings.database_url)
    try:
        await conn.execute(
            """
            UPDATE multiplayer_games mg
            SET created_at = mg.created_at - ($1 || ' minutes')::interval
            FROM users u
            WHERE u.id = mg.host_user_id
              AND u.username = $2
              AND mg.created_via = 'invite'
            """,
            str(minutes),
            host_username,
        )
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_invite_under_hourly_cap_succeeds(client: AsyncClient, make_user):
    """The first INVITE_HOURLY_CAP invites in a fresh window all 200."""
    from app.routers.chat import INVITE_HOURLY_CAP

    alice = await make_user("alice")
    targets = [await make_user(f"target{i}") for i in range(INVITE_HOURLY_CAP)]
    for t in targets:
        resp = await client.post(
            "/chat/invite",
            headers=alice["headers"],
            json={"target_username": t["username"]},
        )
        assert resp.status_code == 200, resp.text


@pytest.mark.asyncio
async def test_invite_at_hourly_cap_returns_429(client: AsyncClient, make_user):
    """The (HOURLY_CAP+1)th invite within an hour returns 429 with the
    required error string and a parseable retry_at."""
    from app.routers.chat import INVITE_HOURLY_CAP, RATE_LIMIT_ERROR

    alice = await make_user("alice")
    targets = [await make_user(f"target{i}") for i in range(INVITE_HOURLY_CAP + 1)]
    for t in targets[:INVITE_HOURLY_CAP]:
        ok = await client.post(
            "/chat/invite",
            headers=alice["headers"],
            json={"target_username": t["username"]},
        )
        assert ok.status_code == 200

    over = await client.post(
        "/chat/invite",
        headers=alice["headers"],
        json={"target_username": targets[-1]["username"]},
    )
    assert over.status_code == 429
    detail = over.json()["detail"]
    assert detail["error"] == RATE_LIMIT_ERROR
    # retry_at must be a valid ISO timestamp in the near future.
    from datetime import datetime

    parsed = datetime.fromisoformat(detail["retry_at"])
    assert parsed is not None


@pytest.mark.asyncio
async def test_invite_count_includes_joined_invites(client: AsyncClient, make_user):
    """Joining an invite does NOT free a quota slot — the rolling
    window is purely time-based, not state-based."""
    from app.routers.chat import INVITE_HOURLY_CAP

    alice = await make_user("alice")
    others = [await make_user(f"other{i}") for i in range(INVITE_HOURLY_CAP + 1)]
    codes: list[str] = []
    for t in others[:INVITE_HOURLY_CAP]:
        r = await client.post(
            "/chat/invite",
            headers=alice["headers"],
            json={"target_username": t["username"]},
        )
        codes.append(r.json()["invited_code"])
    # The first invitee joins — the row goes from `waiting` to
    # `in_progress`, but the rate-limit count is state-blind.
    join = await client.post(
        f"/multiplayer/{codes[0]}/join",
        headers=others[0]["headers"],
        json={},
    )
    assert join.status_code == 200
    # Alice is still capped — joining doesn't free a slot.
    over = await client.post(
        "/chat/invite",
        headers=alice["headers"],
        json={"target_username": others[-1]["username"]},
    )
    assert over.status_code == 429


@pytest.mark.asyncio
async def test_invite_count_excludes_modal_rooms(client: AsyncClient, make_user):
    """Modal-created games (POST /multiplayer/new) do NOT consume invite
    quota — only created_via='invite' rows count."""
    from app.routers.chat import INVITE_HOURLY_CAP

    alice = await make_user("alice")
    bob = await make_user("bob")
    # Open INVITE_HOURLY_CAP+1 modal games — none should consume quota.
    for _ in range(INVITE_HOURLY_CAP + 1):
        r = await client.post(
            "/multiplayer/new",
            headers=alice["headers"],
            json={"host_color": "X", "board_size": 15},
        )
        assert r.status_code == 200, r.text
    # Invite still works — the invite count saw zero invite rows.
    invite_resp = await client.post(
        "/chat/invite",
        headers=alice["headers"],
        json={"target_username": bob["username"]},
    )
    assert invite_resp.status_code == 200, invite_resp.text


@pytest.mark.asyncio
async def test_invite_recovers_after_hourly_window_passes(client: AsyncClient, make_user):
    """Once an invite ages out of the 1-hour window, a new invite lands."""
    from app.routers.chat import INVITE_HOURLY_CAP

    alice = await make_user("alice")
    targets = [await make_user(f"target{i}") for i in range(INVITE_HOURLY_CAP + 1)]
    for t in targets[:INVITE_HOURLY_CAP]:
        r = await client.post(
            "/chat/invite",
            headers=alice["headers"],
            json={"target_username": t["username"]},
        )
        assert r.status_code == 200
    # Push every invite back 61 minutes — they're now outside the
    # hourly window but still inside the 24h window.
    await _backdate_invites(alice["username"], 61)
    again = await client.post(
        "/chat/invite",
        headers=alice["headers"],
        json={"target_username": targets[-1]["username"]},
    )
    assert again.status_code == 200, again.text


@pytest.mark.asyncio
async def test_invite_at_daily_cap_returns_429(client: AsyncClient, make_user):
    """With invites spread across 24h such that the hourly cap doesn't
    fire, the daily cap still does."""
    from app.routers.chat import (
        INVITE_DAILY_CAP,
        INVITE_HOURLY_CAP,
        RATE_LIMIT_ERROR,
    )

    alice = await make_user("alice")
    n_targets = INVITE_DAILY_CAP + 1
    targets = [await make_user(f"target{i}") for i in range(n_targets)]
    # Send INVITE_DAILY_CAP invites in batches of INVITE_HOURLY_CAP,
    # backdating between batches so the hourly cap never fires.
    sent = 0
    while sent < INVITE_DAILY_CAP:
        batch_end = min(sent + INVITE_HOURLY_CAP, INVITE_DAILY_CAP)
        for t in targets[sent:batch_end]:
            r = await client.post(
                "/chat/invite",
                headers=alice["headers"],
                json={"target_username": t["username"]},
            )
            assert r.status_code == 200, r.text
        sent = batch_end
        # Back up everything sent so far past the hourly window. The
        # final batch isn't backdated; it sits in the current hour.
        if sent < INVITE_DAILY_CAP:
            await _backdate_invites(alice["username"], 61)
    # We're at INVITE_DAILY_CAP rows in the 24h window; one more 429s.
    over = await client.post(
        "/chat/invite",
        headers=alice["headers"],
        json={"target_username": targets[-1]["username"]},
    )
    assert over.status_code == 429
    assert over.json()["detail"]["error"] == RATE_LIMIT_ERROR


# ---------------------------------------------------------------------------
# GET /chat/incoming — pending invites addressed to the caller
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_incoming_lists_invite_for_target(client: AsyncClient, make_user):
    """Alice invites bob → bob's /chat/incoming surfaces the invite
    with the invite URL and host username."""
    alice = await make_user("alice")
    bob = await make_user("bob")
    inv = await client.post(
        "/chat/invite",
        headers=alice["headers"],
        json={"target_username": "bob"},
    )
    assert inv.status_code == 200
    code = inv.json()["invited_code"]

    inbox = await client.get("/chat/incoming", headers=bob["headers"])
    assert inbox.status_code == 200
    invites = inbox.json()["invites"]
    assert len(invites) == 1
    assert invites[0]["code"] == code
    assert invites[0]["host_username"] == "alice"
    assert invites[0]["invite_url"].endswith(f"/play/{code}")


@pytest.mark.asyncio
async def test_incoming_excludes_invites_to_other_users(client: AsyncClient, make_user):
    """Alice's invite to carol must not appear in bob's inbox."""
    alice = await make_user("alice")
    bob = await make_user("bob")
    await make_user("carol")
    await client.post(
        "/chat/invite",
        headers=alice["headers"],
        json={"target_username": "carol"},
    )
    inbox = await client.get("/chat/incoming", headers=bob["headers"])
    assert inbox.json()["invites"] == []


@pytest.mark.asyncio
async def test_incoming_excludes_modal_games(client: AsyncClient, make_user):
    """Modal-created games (no intended_guest_id) never appear in any
    inbox, even if there are tons of them."""
    alice = await make_user("alice")
    bob = await make_user("bob")
    for _ in range(3):
        r = await client.post(
            "/multiplayer/new",
            headers=alice["headers"],
            json={"host_color": "X", "board_size": 15},
        )
        assert r.status_code == 200
    inbox = await client.get("/chat/incoming", headers=bob["headers"])
    assert inbox.json()["invites"] == []


@pytest.mark.asyncio
async def test_incoming_excludes_joined_invites(client: AsyncClient, make_user):
    """Once bob joins the invite, it's no longer 'waiting' and drops
    out of his inbox."""
    alice = await make_user("alice")
    bob = await make_user("bob")
    inv = await client.post(
        "/chat/invite",
        headers=alice["headers"],
        json={"target_username": "bob"},
    )
    code = inv.json()["invited_code"]
    join = await client.post(
        f"/multiplayer/{code}/join",
        headers=bob["headers"],
        json={},
    )
    assert join.status_code == 200
    inbox = await client.get("/chat/incoming", headers=bob["headers"])
    assert inbox.json()["invites"] == []


# ---------------------------------------------------------------------------
# Invite-with-message + decline endpoint
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_invite_with_message_surfaces_in_incoming(
    client: AsyncClient, make_user
):
    """`/chat/invite` with a `message` field stores it as a chat_messages
    row from the host; `/chat/incoming` surfaces it back to the
    invitee on the new `message` field."""
    alice = await make_user("alice")
    bob = await make_user("bob")
    inv = await client.post(
        "/chat/invite",
        headers=alice["headers"],
        json={"target_username": "bob", "message": "hey wanna play?"},
    )
    assert inv.status_code == 200, inv.text
    inbox = await client.get("/chat/incoming", headers=bob["headers"])
    assert inbox.status_code == 200
    body = inbox.json()
    assert len(body["invites"]) == 1
    assert body["invites"][0]["host_username"] == "alice"
    assert body["invites"][0]["message"] == "hey wanna play?"


@pytest.mark.asyncio
async def test_invite_without_message_returns_null_message(
    client: AsyncClient, make_user
):
    alice = await make_user("alice")
    bob = await make_user("bob")
    await client.post(
        "/chat/invite",
        headers=alice["headers"],
        json={"target_username": "bob"},
    )
    inbox = await client.get("/chat/incoming", headers=bob["headers"])
    assert inbox.json()["invites"][0]["message"] is None


@pytest.mark.asyncio
async def test_decline_invite_cancels_game_and_posts_apology(
    client: AsyncClient, make_user
):
    """Happy path: invitee declines, server flips the game to
    'cancelled' and inserts the apology chat message from the invitee."""
    alice = await make_user("alice")
    bob = await make_user("bob")
    inv = await client.post(
        "/chat/invite",
        headers=alice["headers"],
        json={"target_username": "bob"},
    )
    code = inv.json()["invited_code"]
    decline = await client.post(
        f"/chat/incoming/{code}/decline", headers=bob["headers"]
    )
    assert decline.status_code == 200, decline.text
    assert decline.json() == {"declined": True}

    # The inviter sees the apology in the game's chat log. /chat/{code}/messages
    # requires the caller to be a participant — alice is the host, so allowed.
    msgs = await client.get(
        f"/chat/{code}/messages", headers=alice["headers"]
    )
    assert msgs.status_code == 200
    bodies = [m["message"] for m in msgs.json()["messages"]]
    assert "Apologies, but I can't play or chat at the moment." in bodies

    # The game's lobby state is no longer pollable for joining — joining
    # a cancelled invite must surface a clear failure rather than silently
    # work.
    join = await client.post(
        f"/multiplayer/{code}/join", headers=bob["headers"], json={}
    )
    assert join.status_code in (400, 409, 410)


@pytest.mark.asyncio
async def test_decline_unknown_code_returns_404(
    client: AsyncClient, make_user
):
    bob = await make_user("bob")
    resp = await client.post(
        "/chat/incoming/ZZZZZZ/decline", headers=bob["headers"]
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_decline_by_non_invitee_returns_403(
    client: AsyncClient, make_user
):
    alice = await make_user("alice")
    await make_user("bob")
    carol = await make_user("carol")
    inv = await client.post(
        "/chat/invite",
        headers=alice["headers"],
        json={"target_username": "bob"},
    )
    code = inv.json()["invited_code"]
    # Carol tries to decline an invite that was never offered to her.
    resp = await client.post(
        f"/chat/incoming/{code}/decline", headers=carol["headers"]
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_decline_after_join_returns_409(
    client: AsyncClient, make_user
):
    """Once the invitee has already joined the game it's in_progress,
    not waiting — a late decline must 409 rather than retroactively
    cancel an active game."""
    alice = await make_user("alice")
    bob = await make_user("bob")
    inv = await client.post(
        "/chat/invite",
        headers=alice["headers"],
        json={"target_username": "bob"},
    )
    code = inv.json()["invited_code"]
    join = await client.post(
        f"/multiplayer/{code}/join", headers=bob["headers"], json={}
    )
    assert join.status_code == 200
    resp = await client.post(
        f"/chat/incoming/{code}/decline", headers=bob["headers"]
    )
    assert resp.status_code == 409
