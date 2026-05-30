"""End-to-end tests for the /social/* router.

Exercises follow / unfollow / block, including the side-effect of
terminating an in-flight multiplayer game when a block (or
last-link-severing unfollow) lands.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _start_multiplayer_between(client: AsyncClient, host: dict, guest: dict) -> str:
    """Open a fresh multiplayer game with `host`, have `guest` join, and
    return the game code. Resulting game state is `in_progress` (no moves
    yet — both players are sitting at version=1 waiting for X to move)."""
    new_resp = await client.post(
        "/multiplayer/new",
        headers=host["headers"],
        json={"host_color": "X", "board_size": 15},
    )
    assert new_resp.status_code == 200, new_resp.text
    code = new_resp.json()["code"]
    join_resp = await client.post(
        f"/multiplayer/{code}/join",
        headers=guest["headers"],
        json={},
    )
    assert join_resp.status_code == 200, join_resp.text
    return code


# ---------------------------------------------------------------------------
# /social/follow
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_follow_inserts_friendship(client: AsyncClient, make_user):
    alice = await make_user("alice")
    await make_user("bob")  # exists so /social/follow finds the target
    resp = await client.post(
        "/social/follow",
        headers=alice["headers"],
        json={"target_username": "bob"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"reciprocal": False}


@pytest.mark.asyncio
async def test_follow_is_idempotent(client: AsyncClient, make_user):
    alice = await make_user("alice")
    await make_user("bob")
    for _ in range(3):
        resp = await client.post(
            "/social/follow",
            headers=alice["headers"],
            json={"target_username": "bob"},
        )
        assert resp.status_code == 200
    # No exception, no constraint violation — duplicate follows collapse
    # to a single friendships row.


@pytest.mark.asyncio
async def test_follow_returns_reciprocal_true_when_mutual(client: AsyncClient, make_user):
    alice = await make_user("alice")
    bob = await make_user("bob")
    # First follow direction: not yet reciprocal.
    r1 = await client.post(
        "/social/follow",
        headers=alice["headers"],
        json={"target_username": "bob"},
    )
    assert r1.json() == {"reciprocal": False}
    # Reverse follow makes the pair mutual.
    r2 = await client.post(
        "/social/follow",
        headers=bob["headers"],
        json={"target_username": "alice"},
    )
    assert r2.json() == {"reciprocal": True}


@pytest.mark.asyncio
async def test_follow_unknown_user_404(client: AsyncClient, auth_headers):
    resp = await client.post(
        "/social/follow",
        headers=auth_headers,
        json={"target_username": "nobody-here"},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_follow_self_is_400(client: AsyncClient, registered_user):
    name, token = registered_user
    resp = await client.post(
        "/social/follow",
        headers={"Authorization": f"Bearer {token}"},
        json={"target_username": name},
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# /social/unfollow
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_unfollow_noop_on_missing(client: AsyncClient, make_user):
    alice = await make_user("alice")
    await make_user("bob")
    # Never followed — unfollow is idempotent and returns 200.
    resp = await client.post(
        "/social/unfollow",
        headers=alice["headers"],
        json={"target_username": "bob"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"unfollowed": True}


@pytest.mark.asyncio
async def test_unfollow_does_not_terminate_active_game(client: AsyncClient, make_user):
    """Unfollow MUST NOT cascade into game termination, even when it
    severs the last link between the two players. Only /block (or
    in-game resign / timeout) ends a game.
    """
    alice = await make_user("alice")
    bob = await make_user("bob")
    # Mutual follow + active game.
    await client.post("/social/follow", headers=alice["headers"], json={"target_username": "bob"})
    await client.post("/social/follow", headers=bob["headers"], json={"target_username": "alice"})
    code = await _start_multiplayer_between(client, alice, bob)

    # Both sides unfollow → no link remains.
    r1 = await client.post(
        "/social/unfollow",
        headers=alice["headers"],
        json={"target_username": "bob"},
    )
    assert r1.json() == {"unfollowed": True}
    r2 = await client.post(
        "/social/unfollow",
        headers=bob["headers"],
        json={"target_username": "alice"},
    )
    assert r2.json() == {"unfollowed": True}

    # The game survives — unfollow doesn't touch multiplayer_games.
    state = await client.get(f"/multiplayer/{code}", headers=alice["headers"])
    assert state.json()["state"] == "in_progress"


# ---------------------------------------------------------------------------
# /social/block
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_block_inserts_and_returns_no_game_when_none(client: AsyncClient, make_user):
    alice = await make_user("alice")
    await make_user("bob")
    resp = await client.post(
        "/social/block",
        headers=alice["headers"],
        json={"target_username": "bob"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"game_terminated": False}


@pytest.mark.asyncio
async def test_block_terminates_active_game_and_wipes_friendships(client: AsyncClient, make_user):
    alice = await make_user("alice")
    bob = await make_user("bob")
    # Mutual follow + active game.
    await client.post("/social/follow", headers=alice["headers"], json={"target_username": "bob"})
    await client.post("/social/follow", headers=bob["headers"], json={"target_username": "alice"})
    code = await _start_multiplayer_between(client, alice, bob)

    resp = await client.post(
        "/social/block",
        headers=alice["headers"],
        json={"target_username": "bob"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"game_terminated": True}

    # Game ends. (Either 'cancelled' if it was 'waiting', or 'abandoned'
    # if it was 'in_progress'. _start_multiplayer_between leaves it
    # in_progress, so abandoned is the expected terminal state.)
    state = await client.get(f"/multiplayer/{code}", headers=alice["headers"])
    assert state.json()["state"] == "abandoned"

    # Both directions of the friendship are wiped — re-following Bob
    # should report reciprocal=False even though it was True before
    # the block.
    refollow = await client.post(
        "/social/follow",
        headers=alice["headers"],
        json={"target_username": "bob"},
    )
    assert refollow.json() == {"reciprocal": False}


@pytest.mark.asyncio
async def test_block_terminates_waiting_game(client: AsyncClient, make_user):
    alice = await make_user("alice")
    await make_user("bob")
    # Alice opens a game but Bob never joins — state stays 'waiting'.
    new_resp = await client.post(
        "/multiplayer/new",
        headers=alice["headers"],
        json={"host_color": "X", "board_size": 15},
    )
    assert new_resp.status_code == 200
    # Block doesn't terminate this game because Bob isn't a participant
    # yet — there's no game *between* the two.
    resp = await client.post(
        "/social/block",
        headers=alice["headers"],
        json={"target_username": "bob"},
    )
    assert resp.json() == {"game_terminated": False}


# ---------------------------------------------------------------------------
# /social/who
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_who_lists_active_users_excluding_caller(client: AsyncClient, make_user):
    alice = await make_user("alice")
    await make_user("bob")
    await make_user("carol")
    resp = await client.get("/social/who", headers=alice["headers"])
    assert resp.status_code == 200
    usernames = {u["username"] for u in resp.json()["users"]}
    assert usernames == {"bob", "carol"}  # caller excluded


@pytest.mark.asyncio
async def test_who_marks_mutual_followers_as_friends(client: AsyncClient, make_user):
    alice = await make_user("alice")
    bob = await make_user("bob")
    await make_user("carol")
    await client.post("/social/follow", headers=alice["headers"], json={"target_username": "bob"})
    await client.post("/social/follow", headers=bob["headers"], json={"target_username": "alice"})
    resp = await client.get("/social/who", headers=alice["headers"])
    by_name = {u["username"]: u for u in resp.json()["users"]}
    assert by_name["bob"]["is_friend"] is True
    assert by_name["carol"]["is_friend"] is False


@pytest.mark.asyncio
async def test_who_excludes_blocked_pair(client: AsyncClient, make_user):
    alice = await make_user("alice")
    await make_user("bob")
    await make_user("carol")
    await client.post("/social/block", headers=alice["headers"], json={"target_username": "bob"})
    resp = await client.get("/social/who", headers=alice["headers"])
    usernames = {u["username"] for u in resp.json()["users"]}
    assert "bob" not in usernames
    assert "carol" in usernames


@pytest.mark.asyncio
async def test_who_excludes_users_outside_window(client: AsyncClient, make_user):
    """Backdate bob's last_seen_at so he's stale — he should drop out
    of the default-window /who response."""
    import asyncpg

    from tests.conftest import TEST_DSN

    alice = await make_user("alice")
    await make_user("bob")
    conn = await asyncpg.connect(TEST_DSN)
    try:
        await conn.execute(
            """
            UPDATE users SET last_seen_at = NOW() - INTERVAL '10 minutes'
            WHERE username = 'bob'
            """
        )
    finally:
        await conn.close()
    resp = await client.get("/social/who", headers=alice["headers"])
    usernames = {u["username"] for u in resp.json()["users"]}
    assert "bob" not in usernames
