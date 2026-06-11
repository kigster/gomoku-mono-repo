"""Tests for the online_users view + GET /social/online + the
games.status lifecycle bookended by /game/start and /game/save.
"""

from __future__ import annotations

import asyncpg
import pytest
from httpx import AsyncClient

from tests.conftest import TEST_DSN

# ---------------------------------------------------------------------------
# games.status lifecycle (insert at /start, update at /save)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_game_start_inserts_in_progress_row(client: AsyncClient, auth_headers):
    resp = await client.post(
        "/game/start",
        headers=auth_headers,
        json={"board_size": 19, "depth": 4, "radius": 3, "human_player": "O"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "game_id" in body
    game_id = body["game_id"]

    conn = await asyncpg.connect(TEST_DSN)
    try:
        row = await conn.fetchrow(
            """SELECT game_type, status, board_size, depth, radius, human_player,
                      total_moves, winner
               FROM games WHERE id = $1::uuid""",
            game_id,
        )
    finally:
        await conn.close()
    assert row is not None
    assert row["game_type"] == "ai"
    assert row["status"] == "in_progress"
    assert row["board_size"] == 19
    assert row["depth"] == 4
    assert row["radius"] == 3
    assert row["human_player"] == "O"
    assert row["total_moves"] == 0
    assert row["winner"] is None  # the relaxed NOT NULL takes effect here


@pytest.mark.asyncio
async def test_game_start_abandons_previous_in_progress(client: AsyncClient, auth_headers):
    """A user who starts a fresh AI game while one is already pending has
    the older row flipped to `abandoned` automatically. Keeps the
    `online_users` ai-battle classification unambiguous."""
    first = (await client.post("/game/start", headers=auth_headers, json={})).json()
    second = (await client.post("/game/start", headers=auth_headers, json={})).json()

    conn = await asyncpg.connect(TEST_DSN)
    try:
        first_row = await conn.fetchrow(
            "SELECT status FROM games WHERE id = $1::uuid", first["game_id"]
        )
        second_row = await conn.fetchrow(
            "SELECT status FROM games WHERE id = $1::uuid", second["game_id"]
        )
    finally:
        await conn.close()
    assert first_row["status"] == "abandoned"
    assert second_row["status"] == "in_progress"


@pytest.mark.asyncio
async def test_game_save_with_game_id_updates_in_place(client: AsyncClient, auth_headers):
    """`/game/save` carrying the `game_id` returned by `/game/start`
    UPDATEs the existing row instead of inserting a new one — exactly
    one row per AI session."""
    started = (await client.post("/game/start", headers=auth_headers, json={})).json()
    game_id = started["game_id"]

    # Minimal finished-game JSON: human X won in 1 move (good enough for
    # the save endpoint's scoring math; the model lookups read X/O.player
    # and moves[].time_ms).
    game_json = {
        "X": {"player": "human", "depth": 0},
        "O": {"player": "AI", "depth": 3},
        "board_size": 15,
        "radius": 2,
        "timeout": "30",
        "winner": "X",
        "board_state": [],
        "moves": [{"X (human)": [7, 7], "time_ms": 500}],
    }
    saved = await client.post(
        "/game/save",
        headers=auth_headers,
        json={"game_json": game_json, "game_id": game_id},
    )
    assert saved.status_code == 200, saved.text
    # Same id round-trips — proof we updated, didn't insert a new row.
    assert saved.json()["id"] == game_id

    conn = await asyncpg.connect(TEST_DSN)
    try:
        count = await conn.fetchval(
            "SELECT COUNT(*) FROM games WHERE user_id = (SELECT id FROM users WHERE username = $1)",
            "testplayer",
        )
        row = await conn.fetchrow("SELECT status, winner FROM games WHERE id = $1::uuid", game_id)
    finally:
        await conn.close()
    assert count == 1
    assert row["status"] == "completed"
    assert row["winner"] == "X"


@pytest.mark.asyncio
async def test_game_save_without_game_id_inserts_new_row(client: AsyncClient, auth_headers):
    """Backward-compat — a save with no `game_id` still INSERTs (legacy
    clients that never called /start, or skipped the response capture)."""
    game_json = {
        "X": {"player": "human", "depth": 0},
        "O": {"player": "AI", "depth": 3},
        "board_size": 15,
        "radius": 2,
        "timeout": "30",
        "winner": "X",
        "board_state": [],
        "moves": [{"X (human)": [7, 7], "time_ms": 500}],
    }
    saved = await client.post("/game/save", headers=auth_headers, json={"game_json": game_json})
    assert saved.status_code == 200, saved.text
    new_id = saved.json()["id"]

    conn = await asyncpg.connect(TEST_DSN)
    try:
        row = await conn.fetchrow("SELECT status FROM games WHERE id = $1::uuid", new_id)
    finally:
        await conn.close()
    assert row["status"] == "completed"


# ---------------------------------------------------------------------------
# online_users view + GET /social/online
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_online_view_classifies_idle(client: AsyncClient, auth_headers):
    """A user who's just authenticated (last_seen_at is fresh) but
    isn't in any game shows up as 'idle'."""
    resp = await client.get("/social/online", headers=auth_headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    me = next((u for u in body["users"] if u["username"] == "testplayer"), None)
    assert me is not None
    assert me["state"] == "idle"
    assert me["active_game_id"] is None


@pytest.mark.asyncio
async def test_online_view_classifies_ai_battle(client: AsyncClient, auth_headers):
    """Starting an AI game flips state to 'ai-battle' with the games.id
    populated as `active_game_id`."""
    started = (await client.post("/game/start", headers=auth_headers, json={})).json()
    resp = await client.get("/social/online", headers=auth_headers)
    body = resp.json()
    me = next(u for u in body["users"] if u["username"] == "testplayer")
    assert me["state"] == "ai-battle"
    assert me["active_game_id"] == started["game_id"]


@pytest.mark.asyncio
async def test_online_view_classifies_human_battle(
    client: AsyncClient, auth_headers, second_registered_user
):
    """Joining a multiplayer game flips both participants to
    'human-battle' with the same multiplayer_games.id."""
    created = (await client.post("/multiplayer/new", headers=auth_headers, json={})).json()
    code = created["code"]
    join_resp = await client.post(
        f"/multiplayer/{code}/join",
        headers=second_registered_user["headers"],
        json={},
    )
    assert join_resp.status_code == 200, join_resp.text
    mp_game_uuid = None
    conn = await asyncpg.connect(TEST_DSN)
    try:
        mp_game_uuid = str(
            await conn.fetchval("SELECT id FROM multiplayer_games WHERE code = $1", code)
        )
    finally:
        await conn.close()

    resp = await client.get("/social/online", headers=auth_headers)
    body = resp.json()
    host_row = next(u for u in body["users"] if u["username"] == "testplayer")
    guest_row = next(
        u for u in body["users"] if u["username"] == second_registered_user["username"]
    )
    assert host_row["state"] == "human-battle"
    assert guest_row["state"] == "human-battle"
    assert host_row["active_game_id"] == mp_game_uuid
    assert guest_row["active_game_id"] == mp_game_uuid
    # Each side sees the other in `opponent_username` so the chat
    # panel can render "playing @<peer>" without another fetch.
    assert host_row["opponent_username"] == second_registered_user["username"]
    assert guest_row["opponent_username"] == "testplayer"


@pytest.mark.asyncio
async def test_online_endpoint_omits_opponent_for_non_human_battle(
    client: AsyncClient, auth_headers
):
    """`opponent_username` is None for ai-battle and idle states."""
    await client.post("/game/start", headers=auth_headers, json={})
    body = (await client.get("/social/online", headers=auth_headers)).json()
    me = next(u for u in body["users"] if u["username"] == "testplayer")
    assert me["state"] == "ai-battle"
    assert me["opponent_username"] is None


@pytest.mark.asyncio
async def test_online_endpoint_respects_15min_window(client: AsyncClient, auth_headers, make_user):
    """`/social/online` filters down to 15 minutes even though the
    underlying view keeps an 8h window — older logins shouldn't
    pollute the chat-panel /who list. We can't backdate the caller
    (`get_current_user` resets their `last_seen_at` to NOW()), so we
    seed a second user, backdate them, and assert they fall out of
    the response while remaining in the view."""
    await make_user("stale_user")
    conn = await asyncpg.connect(TEST_DSN)
    try:
        await conn.execute(
            "UPDATE users SET last_seen_at = NOW() - INTERVAL '20 minutes' "
            "WHERE username = 'stale_user'"
        )
        view_row = await conn.fetchrow("SELECT 1 FROM online_users WHERE username = 'stale_user'")
    finally:
        await conn.close()
    assert view_row is not None, "view should still surface 20-min-old user"

    resp = await client.get("/social/online?limit=100", headers=auth_headers)
    body = resp.json()
    names = {u["username"] for u in body["users"]}
    assert "stale_user" not in names


@pytest.mark.asyncio
async def test_online_view_human_battle_beats_ai_battle(
    client: AsyncClient, auth_headers, second_registered_user
):
    """When a user is in BOTH (somehow — e.g. an in_progress AI game
    leftover plus a fresh multiplayer game), the multiplayer state
    wins. That's the documented priority order in the view."""
    # Start an AI game so an `in_progress` games row exists.
    await client.post("/game/start", headers=auth_headers, json={})
    # Then start a multiplayer game and have the second user join.
    created = (await client.post("/multiplayer/new", headers=auth_headers, json={})).json()
    await client.post(
        f"/multiplayer/{created['code']}/join",
        headers=second_registered_user["headers"],
        json={},
    )
    resp = await client.get("/social/online", headers=auth_headers)
    me = next(u for u in resp.json()["users"] if u["username"] == "testplayer")
    assert me["state"] == "human-battle"


@pytest.mark.asyncio
async def test_online_view_respects_8h_window(client: AsyncClient, auth_headers):
    """Users not seen within the 8h window are excluded — we backdate
    last_seen_at past the cutoff and check that the testplayer falls
    out of the view."""
    conn = await asyncpg.connect(TEST_DSN)
    try:
        await conn.execute(
            "UPDATE users SET last_seen_at = NOW() - INTERVAL '9 hours' "
            "WHERE username = 'testplayer'"
        )
    finally:
        await conn.close()
    # Hit the view directly to avoid the get_current_user dependency
    # bumping last_seen_at back to NOW().
    conn = await asyncpg.connect(TEST_DSN)
    try:
        row = await conn.fetchrow("SELECT * FROM online_users WHERE username = 'testplayer'")
    finally:
        await conn.close()
    assert row is None


@pytest.mark.asyncio
async def test_human_battle_drops_when_opponent_goes_offline(
    client: AsyncClient, auth_headers, second_registered_user
):
    """Bug fix: an `in_progress` multiplayer game whose opponent has
    fallen out of the presence window must no longer classify the
    caller as `human-battle` in /who. Previously the view only checked
    that the game existed, which kept stale "playing @<opponent>"
    rows alive after the opponent abandoned the tab without resigning.

    Set-up: host (testplayer) creates a game and second_registered_user
    joins, so the row reaches `state='in_progress'`. We then backdate
    the guest's `last_seen_at` past the 8h window. The host should
    fall back to `idle` (no in_progress AI game, no recent chat); the
    guest themselves drops out of the `/who` list entirely because
    their own row is past the same window."""
    created = (await client.post("/multiplayer/new", headers=auth_headers, json={})).json()
    join_resp = await client.post(
        f"/multiplayer/{created['code']}/join",
        headers=second_registered_user["headers"],
        json={},
    )
    assert join_resp.status_code == 200, join_resp.text

    conn = await asyncpg.connect(TEST_DSN)
    try:
        # Backdate the guest only — host stays current.
        await conn.execute(
            "UPDATE users SET last_seen_at = NOW() - INTERVAL '9 hours' WHERE username = $1",
            second_registered_user["username"],
        )
    finally:
        await conn.close()

    resp = await client.get("/social/online", headers=auth_headers)
    body = resp.json()
    host_row = next((u for u in body["users"] if u["username"] == "testplayer"), None)
    assert host_row is not None, "host should still be visible"
    assert host_row["state"] == "idle", (
        "host should no longer be classified as human-battle once the "
        "opponent has fallen out of the presence window"
    )
    assert host_row["opponent_username"] is None
    # Guest's own row is filtered out by the 8h presence window.
    assert second_registered_user["username"] not in {u["username"] for u in body["users"]}


@pytest.mark.asyncio
async def test_human_battle_waiting_game_exempt_from_opponent_presence(
    client: AsyncClient, auth_headers
):
    """A `waiting` multiplayer game has `guest_user_id IS NULL` until
    someone joins. The opponent-presence guard in the view must not
    drop the host from `human-battle` for waiting games — those are
    already self-correcting via the 15-minute lazy expiry, and the
    host is legitimately waiting on a real game."""
    created = (await client.post("/multiplayer/new", headers=auth_headers, json={})).json()
    assert created["state"] == "waiting", created

    resp = await client.get("/social/online", headers=auth_headers)
    me = next(u for u in resp.json()["users"] if u["username"] == "testplayer")
    assert me["state"] == "human-battle", (
        "host of a waiting game should remain in human-battle; opponent "
        "presence is only checked once the game reaches in_progress"
    )
    # No opponent yet, so the router's LATERAL returns NULL — the
    # frontend renders this as 'inactive' rather than 'playing @null'.
    assert me["opponent_username"] is None


@pytest.mark.asyncio
async def test_online_endpoint_pagination(client: AsyncClient, auth_headers, make_user):
    """`limit` + `offset` pagination round-trips, and `total` counts
    rows in the view regardless of page size."""
    # Create extra users so there are >10 in the view.
    for i in range(12):
        await make_user(f"crowd_{i}")
    page1 = (await client.get("/social/online?limit=10&offset=0", headers=auth_headers)).json()
    page2 = (await client.get("/social/online?limit=10&offset=10", headers=auth_headers)).json()
    assert len(page1["users"]) == 10
    assert page2["total"] == page1["total"]
    assert page1["total"] >= 13  # 12 + testplayer at minimum
    page1_names = {u["username"] for u in page1["users"]}
    page2_names = {u["username"] for u in page2["users"]}
    assert page1_names.isdisjoint(page2_names)


# ---------------------------------------------------------------------------
# Who's Online modal enrichment: elo, session start, relationship flags,
# champion crown (GET /social/online additions).
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_online_includes_elo_session_and_default_flags(client: AsyncClient, auth_headers):
    """Every row carries Elo + session start, and a user with no social
    edges has all relationship flags false. `caller_elo` is echoed once
    at the top level."""
    body = (await client.get("/social/online", headers=auth_headers)).json()
    assert body["caller_elo"] == 1500
    me = next(u for u in body["users"] if u["username"] == "testplayer")
    assert me["elo_rating"] == 1500
    assert me["session_started_at"] is not None
    assert me["is_friend"] is False
    assert me["is_follower"] is False
    assert me["is_following"] is False
    assert me["is_blocked"] is False
    assert me["is_champion"] is False


@pytest.mark.asyncio
async def test_online_mutual_follow_is_friend(
    client: AsyncClient, auth_headers, second_registered_user
):
    """A mutual follow surfaces as `is_friend` (and both directional
    flags) on the other user's row."""
    bob = second_registered_user["username"]
    await client.post("/social/follow", headers=auth_headers, json={"target_username": bob})
    await client.post(
        "/social/follow",
        headers=second_registered_user["headers"],
        json={"target_username": "testplayer"},
    )
    body = (await client.get("/social/online", headers=auth_headers)).json()
    bob_row = next(u for u in body["users"] if u["username"] == bob)
    assert bob_row["is_friend"] is True
    assert bob_row["is_follower"] is True
    assert bob_row["is_following"] is True


@pytest.mark.asyncio
async def test_online_one_directional_follow_is_follower_only(
    client: AsyncClient, auth_headers, second_registered_user
):
    """When bob follows the caller but the caller doesn't follow back,
    bob is a `follower`, not a `friend`, and the caller is not
    `following` him."""
    await client.post(
        "/social/follow",
        headers=second_registered_user["headers"],
        json={"target_username": "testplayer"},
    )
    body = (await client.get("/social/online", headers=auth_headers)).json()
    bob_row = next(u for u in body["users"] if u["username"] == second_registered_user["username"])
    assert bob_row["is_follower"] is True
    assert bob_row["is_friend"] is False
    assert bob_row["is_following"] is False


@pytest.mark.asyncio
async def test_online_block_sets_is_blocked(
    client: AsyncClient, auth_headers, second_registered_user
):
    """A caller-initiated block marks the blocked user's row, and the
    blocked user stays visible (the modal colours them, not hides
    them)."""
    bob = second_registered_user["username"]
    await client.post("/social/block", headers=auth_headers, json={"target_username": bob})
    body = (await client.get("/social/online", headers=auth_headers)).json()
    bob_row = next(u for u in body["users"] if u["username"] == bob)
    assert bob_row["is_blocked"] is True


@pytest.mark.asyncio
async def test_online_marks_single_champion(
    client: AsyncClient, auth_headers, second_registered_user
):
    """The top-ranked user (highest Elo among those who've played a
    ranked game) gets `is_champion`; nobody else does."""
    bob = second_registered_user["username"]
    conn = await asyncpg.connect(TEST_DSN)
    try:
        await conn.execute(
            "UPDATE users SET elo_rating = 1800, elo_games_count = 5 WHERE username = $1",
            bob,
        )
    finally:
        await conn.close()
    body = (await client.get("/social/online", headers=auth_headers)).json()
    bob_row = next(u for u in body["users"] if u["username"] == bob)
    me_row = next(u for u in body["users"] if u["username"] == "testplayer")
    assert bob_row["is_champion"] is True
    assert me_row["is_champion"] is False


@pytest.mark.asyncio
async def test_online_champion_tiebreak_on_games_count(
    client: AsyncClient, auth_headers, second_registered_user
):
    """When two ranked players share the top Elo, exactly one is crowned.
    The tie breaks on `elo_games_count DESC` (then `created_at ASC`), so
    the higher-volume player wins. Guards the "at most one crown per
    page" promise on the equal-Elo path the single-champion test skips."""
    bob = second_registered_user["username"]
    conn = await asyncpg.connect(TEST_DSN)
    try:
        await conn.execute(
            "UPDATE users SET elo_rating = 1800, elo_games_count = 5 WHERE username = $1",
            bob,
        )
        await conn.execute(
            "UPDATE users SET elo_rating = 1800, elo_games_count = 3 "
            "WHERE username = 'testplayer'"
        )
    finally:
        await conn.close()
    body = (await client.get("/social/online", headers=auth_headers)).json()
    champions = [u["username"] for u in body["users"] if u["is_champion"]]
    assert champions == [bob], champions


@pytest.mark.asyncio
async def test_online_unranked_high_elo_not_champion(
    client: AsyncClient, auth_headers, second_registered_user
):
    """A user with a high Elo but zero ranked games is NOT champion —
    the CTE requires `elo_games_count > 0`. With nobody qualifying, no
    row carries the crown."""
    bob = second_registered_user["username"]
    conn = await asyncpg.connect(TEST_DSN)
    try:
        await conn.execute(
            "UPDATE users SET elo_rating = 3000, elo_games_count = 0 WHERE username = $1",
            bob,
        )
    finally:
        await conn.close()
    body = (await client.get("/social/online", headers=auth_headers)).json()
    champions = [u["username"] for u in body["users"] if u["is_champion"]]
    assert champions == [], champions
