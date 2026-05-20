"""Failing test suite for the human-vs-human multiplayer API.

Stage 2 of the four-stage agent workflow per
`doc/human-vs-human-plan.md` §9. These tests are intentionally red right now
because Stage 3 has not yet implemented the routes/migration. Once Stage 3
makes them green, do not modify them.

Coverage matrix (cross-checked against plan §4 + §5):

  POST /multiplayer/new        - happy path, validation, host_color default & override
  POST /multiplayer/{c}/join   - happy path, 404, 409 cannot_join_own_game,
                                 409 game_already_full, 409 game_not_in_waiting_state
  GET  /multiplayer/{c}        - participant view, non-participant preview,
                                 304 since_version, 404
  POST /multiplayer/{c}/move   - happy path, version bump, turn flip,
                                 409 not_your_turn, 409 version_conflict,
                                 409 square_occupied, 400 out_of_bounds,
                                 403 not_a_participant, 409 game_not_in_progress
  POST /multiplayer/{c}/resign - happy, double-resign 409
  GET  /multiplayer/mine       - lists host+guest games, ordered DESC
  Move race                    - asyncio.gather; one wins, one 409
  Join race                    - asyncio.gather; one joins, one 409
  Win flow                     - 5-in-a-row → state=finished, two `games` rows
"""

import asyncio

import asyncpg
import pytest
from httpx import AsyncClient

from app.exceptions import HTTPResponseException
from app.routers import multiplayer as multiplayer_router
from tests.conftest import TEST_DSN

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _create_game(
    client: AsyncClient,
    headers: dict,
    *,
    board_size: int | None = None,
    host_color: str | None = None,
) -> dict:
    """POST /multiplayer/new and return the response JSON."""
    body: dict = {}
    if board_size is not None:
        body["board_size"] = board_size
    if host_color is not None:
        body["host_color"] = host_color
    resp = await client.post("/multiplayer/new", headers=headers, json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _join(client: AsyncClient, code: str, headers: dict) -> "tuple[int, dict]":
    resp = await client.post(f"/multiplayer/{code}/join", headers=headers, json={})
    return resp.status_code, (resp.json() if resp.content else {})


async def _move(
    client: AsyncClient,
    code: str,
    headers: dict,
    x: int,
    y: int,
    expected_version: int,
):
    return await client.post(
        f"/multiplayer/{code}/move",
        headers=headers,
        json={"x": x, "y": y, "expected_version": expected_version},
    )


async def _start_in_progress_game(
    client: AsyncClient,
    host_headers: dict,
    guest_headers: dict,
    *,
    host_color: str = "X",
    board_size: int = 15,
) -> dict:
    """Create a game and join it, returning the joined game view (in_progress)."""
    created = await _create_game(client, host_headers, host_color=host_color, board_size=board_size)
    code = created["code"]
    status, body = await _join(client, code, guest_headers)
    assert status == 200, body
    assert body["state"] == "in_progress"
    return body


# ---------------------------------------------------------------------------
# POST /multiplayer/new
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_new_game_happy_path(client: AsyncClient, auth_headers):
    resp = await client.post("/multiplayer/new", headers=auth_headers, json={})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    # Code is a 6-char Crockford base32 string.
    assert isinstance(data["code"], str)
    assert len(data["code"]) == 6
    assert data["code"] == data["code"].upper()
    assert all(c not in data["code"] for c in "ILOU01")

    assert data["state"] == "waiting"
    assert data["version"] == 0
    assert data["board_size"] == 15  # plan §4 default
    assert data["next_to_move"] == "X"
    assert data["winner"] is None
    assert data["moves"] == []
    assert data["guest"] is None
    # Host is identified.
    assert data["host"]["username"] == "testplayer"
    # The creator is the host, so their color is host_color.
    assert data["your_color"] in ("X", "O")
    assert data["your_turn"] is False  # state == waiting → not your turn yet


@pytest.mark.asyncio
async def test_new_game_unauthenticated(client: AsyncClient):
    resp = await client.post("/multiplayer/new", json={})
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_new_game_default_host_color(client: AsyncClient, auth_headers):
    """When host_color is omitted, plan §4 / schema default = 'X'."""
    data = await _create_game(client, auth_headers)
    assert data["host"]["color"] == "X"
    assert data["your_color"] == "X"


@pytest.mark.asyncio
async def test_new_game_host_color_override(client: AsyncClient, auth_headers):
    data = await _create_game(client, auth_headers, host_color="O")
    assert data["host"]["color"] == "O"
    assert data["your_color"] == "O"
    # next_to_move is always X regardless of host color (X moves first in gomoku).
    assert data["next_to_move"] == "X"


@pytest.mark.asyncio
async def test_new_game_host_color_invalid(client: AsyncClient, auth_headers):
    resp = await client.post("/multiplayer/new", headers=auth_headers, json={"host_color": "Z"})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_new_game_board_size_19(client: AsyncClient, auth_headers):
    data = await _create_game(client, auth_headers, board_size=19)
    assert data["board_size"] == 19


@pytest.mark.asyncio
async def test_new_game_board_size_invalid(client: AsyncClient, auth_headers):
    """Plan §3 schema CHECK: board_size IN (15, 19)."""
    resp = await client.post("/multiplayer/new", headers=auth_headers, json={"board_size": 13})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_new_game_codes_are_unique(client: AsyncClient, auth_headers):
    a = await _create_game(client, auth_headers)
    b = await _create_game(client, auth_headers)
    assert a["code"] != b["code"]


@pytest.mark.asyncio
async def test_middleware_converts_http_response_exception(
    client: AsyncClient, auth_headers, monkeypatch
):
    async def _boom(*_args: object, **_kwargs: object) -> dict:
        raise HTTPResponseException(418, "middleware_translation_ok")

    monkeypatch.setattr(multiplayer_router, "allocate_game", _boom)
    resp = await client.post("/multiplayer/new", headers=auth_headers, json={})
    assert resp.status_code == 418
    assert resp.json()["detail"] == "middleware_translation_ok"


# ---------------------------------------------------------------------------
# POST /multiplayer/{code}/join
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_join_happy_path(client: AsyncClient, auth_headers, second_registered_user):
    created = await _create_game(client, auth_headers, host_color="X")
    code = created["code"]
    assert created["state"] == "waiting"
    assert created["version"] == 0

    resp = await client.post(
        f"/multiplayer/{code}/join", headers=second_registered_user["headers"], json={}
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["state"] == "in_progress"
    assert data["version"] == 1  # bumped on join (plan §5)
    assert data["guest"]["username"] == second_registered_user["username"]
    # Guest's color is the opposite of host_color.
    assert data["guest"]["color"] == "O"
    assert data["host"]["color"] == "X"
    # The joiner's `your_color` perspective is the guest's color.
    assert data["your_color"] == "O"


@pytest.mark.asyncio
async def test_join_unknown_code(client: AsyncClient, second_registered_user):
    resp = await client.post(
        "/multiplayer/AAAAAA/join",
        headers=second_registered_user["headers"],
        json={},
    )
    assert resp.status_code == 404
    assert "multiplayer_game_not_found" in resp.text


@pytest.mark.asyncio
async def test_join_own_game_rejected(client: AsyncClient, auth_headers):
    """Plan §4: 409 cannot_join_own_game when host == joiner."""
    created = await _create_game(client, auth_headers)
    resp = await client.post(f"/multiplayer/{created['code']}/join", headers=auth_headers, json={})
    assert resp.status_code == 409
    assert "cannot_join_own_game" in resp.text


@pytest.mark.asyncio
async def test_join_already_full(
    client: AsyncClient, auth_headers, second_registered_user, make_user
):
    """Plan §4: 409 game_already_full once a guest is set."""
    created = await _create_game(client, auth_headers)
    code = created["code"]
    first = await client.post(
        f"/multiplayer/{code}/join",
        headers=second_registered_user["headers"],
        json={},
    )
    assert first.status_code == 200, first.text

    third = await make_user("thirdplayer", email="third@example.com")
    resp = await client.post(f"/multiplayer/{code}/join", headers=third["headers"], json={})
    assert resp.status_code == 409
    assert "game_already_full" in resp.text


@pytest.mark.asyncio
async def test_join_finished_game_rejected(
    client: AsyncClient, auth_headers, second_registered_user, make_user
):
    """Plan §4 / §5: trying to join when state != 'waiting' is a 409.

    The verifier note (§10 #6) says the conditional UPDATE returns no row when
    `guest_user_id IS NULL` is false; the implementer must distinguish this
    from `game_already_full`. After the host resigns the state moves to
    `finished` (still has a guest only if joined; here we test post-resign
    where the game went straight to finished from waiting).
    """
    # Set up a game that has already finished (guest joined, host resigned).
    created = await _create_game(client, auth_headers)
    code = created["code"]
    join_resp = await client.post(
        f"/multiplayer/{code}/join",
        headers=second_registered_user["headers"],
        json={},
    )
    assert join_resp.status_code == 200
    resign = await client.post(f"/multiplayer/{code}/resign", headers=auth_headers, json={})
    assert resign.status_code == 200

    third = await make_user("late", email="late@example.com")
    resp = await client.post(f"/multiplayer/{code}/join", headers=third["headers"], json={})
    # Implementer can return either game_already_full (because guest_user_id
    # is set) or game_not_in_waiting_state. Both are 409 per §4. We assert the
    # status code and one of the two stable error codes.
    assert resp.status_code == 409
    assert ("game_already_full" in resp.text) or ("game_not_in_waiting_state" in resp.text)


@pytest.mark.asyncio
async def test_join_unauthenticated(client: AsyncClient, auth_headers):
    created = await _create_game(client, auth_headers)
    resp = await client.post(f"/multiplayer/{created['code']}/join", json={})
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# GET /multiplayer/{code}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_game_full_view_for_host(client: AsyncClient, auth_headers):
    created = await _create_game(client, auth_headers)
    resp = await client.get(f"/multiplayer/{created['code']}", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    # Full view exposes the moves array (preview-only does not include it
    # per the verifier note in §10 #9).
    assert "moves" in data
    assert "next_to_move" in data
    assert data["your_color"] is not None  # host is a participant


@pytest.mark.asyncio
async def test_get_game_preview_for_non_participant(client: AsyncClient, auth_headers, make_user):
    """Plan §4 + verifier #9: non-participant gets a slim preview only.

    The preview must include code/state/board_size/rule_set/host so the join
    screen can render. `your_color` must be null. `moves` must NOT be exposed
    to non-participants (otherwise they'd be effectively spectators, which is
    explicitly out of scope per §8).
    """
    created = await _create_game(client, auth_headers, host_color="X", board_size=15)
    code = created["code"]

    outsider = await make_user("outsider", email="outsider@example.com")
    resp = await client.get(f"/multiplayer/{code}", headers=outsider["headers"])
    assert resp.status_code == 200
    data = resp.json()
    assert data["code"] == code
    assert data["state"] == "waiting"
    assert data["board_size"] == 15
    assert data["host"]["username"] == "testplayer"
    # Preview-only: caller is not a participant.
    assert data["your_color"] is None
    assert data["your_turn"] is False
    # Moves list must be empty or absent; the spec says "preview-only fields"
    # so spectator-style move replay is forbidden.
    assert data.get("moves", []) == []


@pytest.mark.asyncio
async def test_get_game_unknown_code_returns_404(client: AsyncClient, auth_headers):
    resp = await client.get("/multiplayer/ZZZZZZ", headers=auth_headers)
    assert resp.status_code == 404
    assert "multiplayer_game_not_found" in resp.text


@pytest.mark.asyncio
async def test_get_game_since_version_returns_304_by_default(client: AsyncClient, auth_headers):
    """Legacy contract — when no opt-in header is sent, the server returns
    HTTP 304 for `since_version >= current.version`. Deployed clients
    predate the no-change sentinel and depend on this behaviour."""
    created = await _create_game(client, auth_headers)
    code = created["code"]
    current_version = created["version"]  # 0 for a fresh game

    resp = await client.get(
        f"/multiplayer/{code}?since_version={current_version}", headers=auth_headers
    )
    assert resp.status_code == 304
    assert resp.content in (b"", None)


@pytest.mark.asyncio
async def test_get_game_since_version_returns_no_change_sentinel_when_opted_in(
    client: AsyncClient, auth_headers
):
    """When the client sends `X-Accept-No-Change: 1`, the server replies 200
    with the `{no_change: true, version: N}` sentinel instead of HTTP 304.

    This avoids the Chrome "Fetch failed loading" protocol-error spam that a
    304 produces when the request didn't carry conditional-request
    validators. The two response shapes coexist so the backend can be rolled
    out independently of the frontend.
    """
    created = await _create_game(client, auth_headers)
    code = created["code"]
    current_version = created["version"]  # 0 for a fresh game

    headers = {**auth_headers, "X-Accept-No-Change": "1"}
    resp = await client.get(f"/multiplayer/{code}?since_version={current_version}", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"no_change": True, "version": current_version}


@pytest.mark.asyncio
async def test_get_game_since_version_lower_returns_full_body(
    client: AsyncClient, auth_headers, second_registered_user
):
    """When since_version < current.version, the server returns the full state."""
    created = await _create_game(client, auth_headers)
    code = created["code"]

    # Bump the version by joining.
    join = await client.post(
        f"/multiplayer/{code}/join",
        headers=second_registered_user["headers"],
        json={},
    )
    assert join.status_code == 200

    resp = await client.get(f"/multiplayer/{code}?since_version=0", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert data["version"] >= 1
    assert data["state"] == "in_progress"


@pytest.mark.asyncio
async def test_get_game_unauthenticated(client: AsyncClient, auth_headers):
    created = await _create_game(client, auth_headers)
    resp = await client.get(f"/multiplayer/{created['code']}")
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# POST /multiplayer/{code}/move
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_move_happy_path_bumps_version_and_flips_turn(
    client: AsyncClient, auth_headers, second_registered_user
):
    game = await _start_in_progress_game(
        client, auth_headers, second_registered_user["headers"], host_color="X"
    )
    code = game["code"]
    v = game["version"]
    assert game["next_to_move"] == "X"

    resp = await _move(client, code, auth_headers, x=7, y=7, expected_version=v)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["version"] == v + 1
    assert data["next_to_move"] == "O"  # flipped
    assert [7, 7] in [list(m) for m in data["moves"]]
    assert data["state"] == "in_progress"
    assert data["winner"] is None


@pytest.mark.asyncio
async def test_move_not_your_turn(client: AsyncClient, auth_headers, second_registered_user):
    game = await _start_in_progress_game(
        client, auth_headers, second_registered_user["headers"], host_color="X"
    )
    code = game["code"]
    # It's X's (host's) turn. Guest tries to move first.
    resp = await _move(
        client,
        code,
        second_registered_user["headers"],
        x=7,
        y=7,
        expected_version=game["version"],
    )
    assert resp.status_code == 409
    assert "not_your_turn" in resp.text


@pytest.mark.asyncio
async def test_move_version_conflict(client: AsyncClient, auth_headers, second_registered_user):
    game = await _start_in_progress_game(
        client, auth_headers, second_registered_user["headers"], host_color="X"
    )
    code = game["code"]
    # Send a stale expected_version (one less than current).
    resp = await _move(client, code, auth_headers, x=7, y=7, expected_version=game["version"] - 1)
    assert resp.status_code == 409
    assert "version_conflict" in resp.text


@pytest.mark.asyncio
async def test_move_square_occupied(client: AsyncClient, auth_headers, second_registered_user):
    game = await _start_in_progress_game(
        client, auth_headers, second_registered_user["headers"], host_color="X"
    )
    code = game["code"]

    # Host plays (7,7).
    r1 = await _move(client, code, auth_headers, x=7, y=7, expected_version=game["version"])
    assert r1.status_code == 200, r1.text
    v1 = r1.json()["version"]

    # Guest tries to play the same square.
    resp = await _move(
        client,
        code,
        second_registered_user["headers"],
        x=7,
        y=7,
        expected_version=v1,
    )
    assert resp.status_code == 409
    assert "square_occupied" in resp.text


@pytest.mark.asyncio
async def test_move_out_of_bounds(client: AsyncClient, auth_headers, second_registered_user):
    game = await _start_in_progress_game(
        client, auth_headers, second_registered_user["headers"], host_color="X", board_size=15
    )
    code = game["code"]
    # board_size 15 → valid coords are 0..14. (15, 0) is out of bounds.
    resp = await _move(client, code, auth_headers, x=15, y=0, expected_version=game["version"])
    assert resp.status_code == 400
    assert "out_of_bounds" in resp.text


@pytest.mark.asyncio
async def test_move_negative_out_of_bounds(
    client: AsyncClient, auth_headers, second_registered_user
):
    game = await _start_in_progress_game(
        client, auth_headers, second_registered_user["headers"], host_color="X"
    )
    code = game["code"]
    resp = await _move(client, code, auth_headers, x=-1, y=0, expected_version=game["version"])
    # Pydantic may reject negative ints with 422 OR the route may return 400 out_of_bounds.
    # Either is acceptable as long as the move doesn't land. Plan §4 says 400 out_of_bounds.
    assert resp.status_code in (400, 422)


@pytest.mark.asyncio
async def test_move_not_a_participant(
    client: AsyncClient, auth_headers, second_registered_user, make_user
):
    """Plan §4: 403 not_a_participant for an unrelated user."""
    game = await _start_in_progress_game(
        client, auth_headers, second_registered_user["headers"], host_color="X"
    )
    code = game["code"]

    outsider = await make_user("intruder", email="intruder@example.com")
    resp = await _move(
        client, code, outsider["headers"], x=7, y=7, expected_version=game["version"]
    )
    assert resp.status_code == 403
    assert "not_a_participant" in resp.text


@pytest.mark.asyncio
async def test_move_game_not_in_progress(client: AsyncClient, auth_headers, second_registered_user):
    """Plan §4: 409 game_not_in_progress when state == waiting."""
    created = await _create_game(client, auth_headers, host_color="X")
    code = created["code"]
    # state is 'waiting' here — no guest has joined yet.
    resp = await _move(client, code, auth_headers, x=7, y=7, expected_version=created["version"])
    assert resp.status_code == 409
    assert "game_not_in_progress" in resp.text


@pytest.mark.asyncio
async def test_move_unauthenticated(client: AsyncClient, auth_headers, second_registered_user):
    game = await _start_in_progress_game(
        client, auth_headers, second_registered_user["headers"], host_color="X"
    )
    code = game["code"]
    resp = await client.post(
        f"/multiplayer/{code}/move",
        json={"x": 7, "y": 7, "expected_version": game["version"]},
    )
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# POST /multiplayer/{code}/resign
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resign_sets_finished_and_winner_to_opponent(
    client: AsyncClient, auth_headers, second_registered_user
):
    game = await _start_in_progress_game(
        client, auth_headers, second_registered_user["headers"], host_color="X"
    )
    code = game["code"]
    pre_version = game["version"]

    # Host (X) resigns → winner should be O.
    resp = await client.post(f"/multiplayer/{code}/resign", headers=auth_headers, json={})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["state"] == "finished"
    assert data["winner"] == "O"
    assert data["version"] > pre_version


@pytest.mark.asyncio
async def test_resign_guest_makes_host_winner(
    client: AsyncClient, auth_headers, second_registered_user
):
    game = await _start_in_progress_game(
        client, auth_headers, second_registered_user["headers"], host_color="X"
    )
    code = game["code"]

    resp = await client.post(
        f"/multiplayer/{code}/resign",
        headers=second_registered_user["headers"],
        json={},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["state"] == "finished"
    assert data["winner"] == "X"


@pytest.mark.asyncio
async def test_double_resign_is_409(client: AsyncClient, auth_headers, second_registered_user):
    game = await _start_in_progress_game(
        client, auth_headers, second_registered_user["headers"], host_color="X"
    )
    code = game["code"]
    first = await client.post(f"/multiplayer/{code}/resign", headers=auth_headers, json={})
    assert first.status_code == 200

    second = await client.post(f"/multiplayer/{code}/resign", headers=auth_headers, json={})
    assert second.status_code == 409
    # Either error code is acceptable — both signal the same thing.
    assert ("game_not_in_progress" in second.text) or ("already_finished" in second.text)


@pytest.mark.asyncio
async def test_resign_by_non_participant_is_403(
    client: AsyncClient, auth_headers, second_registered_user, make_user
):
    game = await _start_in_progress_game(
        client, auth_headers, second_registered_user["headers"], host_color="X"
    )
    code = game["code"]
    outsider = await make_user("nope", email="nope@example.com")
    resp = await client.post(f"/multiplayer/{code}/resign", headers=outsider["headers"], json={})
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_resign_unauthenticated(client: AsyncClient, auth_headers, second_registered_user):
    game = await _start_in_progress_game(
        client, auth_headers, second_registered_user["headers"], host_color="X"
    )
    code = game["code"]
    resp = await client.post(f"/multiplayer/{code}/resign", json={})
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# GET /multiplayer/mine
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mine_returns_host_and_guest_games_desc(
    client: AsyncClient, auth_headers, second_registered_user
):
    """`/multiplayer/mine` lists games the caller hosts OR has joined as guest,
    ordered by created_at DESC."""

    # 1. testplayer hosts a game.
    a = await _create_game(client, auth_headers)

    # 2. testplayer joins another player's game as guest.
    other_created = await client.post(
        "/multiplayer/new", headers=second_registered_user["headers"], json={}
    )
    assert other_created.status_code == 200
    other_code = other_created.json()["code"]
    join = await client.post(f"/multiplayer/{other_code}/join", headers=auth_headers, json={})
    assert join.status_code == 200

    # 3. /mine should return both, in DESC order by created_at.
    resp = await client.get("/multiplayer/mine", headers=auth_headers)
    assert resp.status_code == 200, resp.text
    data = resp.json()

    # Response shape: either a bare list or `{"games": [...]}`. Accept both,
    # but pin it down to the games list for assertion.
    games = data["games"] if isinstance(data, dict) and "games" in data else data
    assert isinstance(games, list)
    codes = [g["code"] for g in games]
    assert a["code"] in codes
    assert other_code in codes

    # The most recently created should come first. The guest-join (other_code)
    # was created after `a`, so it should be first in the list.
    if codes.index(other_code) < codes.index(a["code"]):
        pass  # correct ordering
    else:
        pytest.fail(f"Expected /multiplayer/mine to be ordered by created_at DESC, got: {codes}")


@pytest.mark.asyncio
async def test_mine_excludes_other_users_games(
    client: AsyncClient, auth_headers, second_registered_user
):
    # second user creates a game — testplayer is not involved.
    other = await client.post(
        "/multiplayer/new", headers=second_registered_user["headers"], json={}
    )
    assert other.status_code == 200
    other_code = other.json()["code"]

    resp = await client.get("/multiplayer/mine", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    games = data["games"] if isinstance(data, dict) and "games" in data else data
    codes = [g["code"] for g in games]
    assert other_code not in codes


@pytest.mark.asyncio
async def test_mine_unauthenticated(client: AsyncClient):
    resp = await client.get("/multiplayer/mine")
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Concurrency: move race
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_move_race_only_one_succeeds(
    client: AsyncClient, auth_headers, second_registered_user
):
    """Plan §5 move race: two clients submit a move at the same expected_version.

    Per the FOR UPDATE row lock + version bump, exactly one must succeed; the
    other must get 409. The plan lists `version_conflict` as the canonical code
    for that, but in practice the loser may also see `not_your_turn` (because
    the winning move flipped `next_to_move` first) or `square_occupied`. All
    three are acceptable losing-side outcomes.
    """
    game = await _start_in_progress_game(
        client, auth_headers, second_registered_user["headers"], host_color="X"
    )
    code = game["code"]
    v = game["version"]

    # Host (X) tries to move at (7,7); guest (O) tries to move at (8,8) using the
    # SAME expected_version. Only one can win because one of them isn't the
    # `next_to_move` at v, but more importantly the row is locked.
    # To force a true race, we have BOTH players try to play (one at a time of
    # course is the protocol, but here we deliberately race them).
    #
    # We use the host firing two moves at the same square with the same version
    # — that is the classic "double-submit" the FOR UPDATE lock must prevent.
    r1, r2 = await asyncio.gather(
        _move(client, code, auth_headers, x=7, y=7, expected_version=v),
        _move(client, code, auth_headers, x=8, y=8, expected_version=v),
    )

    statuses = sorted([r1.status_code, r2.status_code])
    # Exactly one 200 + one 409.
    assert statuses == [200, 409], (
        f"expected one success and one conflict, got {statuses}: "
        f"r1={r1.status_code} {r1.text!r}; r2={r2.status_code} {r2.text!r}"
    )

    loser_text = r1.text if r1.status_code == 409 else r2.text
    assert any(
        code_ in loser_text for code_ in ("version_conflict", "not_your_turn", "square_occupied")
    ), f"unexpected loser detail: {loser_text}"


# ---------------------------------------------------------------------------
# Concurrency: join race
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_join_race_only_one_succeeds(client: AsyncClient, auth_headers, make_user):
    """Plan §5 join race: two distinct users hit /join at the same instant.

    Conditional UPDATE pattern (plan §5) — the second to land sees
    `guest_user_id IS NULL` is now false and gets a 409 game_already_full.
    """
    created = await _create_game(client, auth_headers)
    code = created["code"]

    a = await make_user("racer_a", email="racer_a@example.com")
    b = await make_user("racer_b", email="racer_b@example.com")

    r1, r2 = await asyncio.gather(
        client.post(f"/multiplayer/{code}/join", headers=a["headers"], json={}),
        client.post(f"/multiplayer/{code}/join", headers=b["headers"], json={}),
    )

    statuses = sorted([r1.status_code, r2.status_code])
    assert statuses == [200, 409], (
        f"expected exactly one join to succeed, got {statuses}: "
        f"r1={r1.status_code} {r1.text!r}; r2={r2.status_code} {r2.text!r}"
    )
    loser_text = r1.text if r1.status_code == 409 else r2.text
    assert "game_already_full" in loser_text


# ---------------------------------------------------------------------------
# Win flow — 5-in-a-row, two `games` rows, version bump
# ---------------------------------------------------------------------------


def _alternating(host_moves: list[tuple[int, int]], guest_moves: list[tuple[int, int]]):
    """Yield (player_index, x, y) where 0 = host, 1 = guest, alternating."""
    for i in range(max(len(host_moves), len(guest_moves))):
        if i < len(host_moves):
            yield 0, host_moves[i][0], host_moves[i][1]
        if i < len(guest_moves):
            yield 1, guest_moves[i][0], guest_moves[i][1]


@pytest.mark.asyncio
async def test_win_flow_five_in_a_row(client: AsyncClient, auth_headers, second_registered_user):
    """Play through a full 5-in-a-row: host (X) wins on the 9th move.

    Move sequence (X = host, O = guest):
      X (0,0) - O (1,0) - X (0,1) - O (1,1) - X (0,2) - O (1,2)
      X (0,3) - O (1,3) - X (0,4) → X wins (column 0, rows 0-4).

    After the winning move the response must have:
      - state == 'finished'
      - winner == 'X' (host's color)
      - version bumped past pre-move version
    And two rows must be written to the existing `games` table per plan §3
    — one per participant.
    """
    game = await _start_in_progress_game(
        client, auth_headers, second_registered_user["headers"], host_color="X"
    )
    code = game["code"]
    version = game["version"]

    host_moves = [(0, 0), (0, 1), (0, 2), (0, 3), (0, 4)]
    guest_moves = [(1, 0), (1, 1), (1, 2), (1, 3)]

    last_resp = None
    for player_idx, x, y in _alternating(host_moves, guest_moves):
        headers = auth_headers if player_idx == 0 else second_registered_user["headers"]
        resp = await _move(client, code, headers, x=x, y=y, expected_version=version)
        assert resp.status_code == 200, (
            f"move failed at ({x},{y}) by player {player_idx}: {resp.status_code} {resp.text}"
        )
        body = resp.json()
        version = body["version"]
        last_resp = body

    assert last_resp is not None
    assert last_resp["state"] == "finished"
    assert last_resp["winner"] == "X"
    assert last_resp["version"] > game["version"]
    assert last_resp["finished_at"] is not None

    # Verify two rows exist in the `games` table — one per participant
    # (plan §3 + verifier #10).
    conn = await asyncpg.connect(TEST_DSN)
    try:
        rows = await conn.fetch(
            """
            SELECT username, human_player, winner, depth, radius
            FROM games
            WHERE game_json::jsonb ? 'multiplayer_game_id'
            ORDER BY username
            """
        )
    finally:
        await conn.close()

    assert len(rows) == 2, f"expected 2 game rows (one per participant), got {len(rows)}"
    usernames = sorted(r["username"] for r in rows)
    assert usernames == sorted(["testplayer", second_registered_user["username"]])
    # Both rows must record X as the winner.
    for r in rows:
        assert r["winner"] == "X"
        # Plan §3: depth=0 / radius=0 signals "human opponent, not AI".
        assert r["depth"] == 0
        assert r["radius"] == 0
    # Each participant's row records that participant's color as their human_player.
    by_user = {r["username"]: r for r in rows}
    assert by_user["testplayer"]["human_player"] == "X"
    assert by_user[second_registered_user["username"]]["human_player"] == "O"


@pytest.mark.asyncio
async def test_move_after_finished_is_409(
    client: AsyncClient, auth_headers, second_registered_user
):
    """After someone resigns, further moves are 409 game_not_in_progress."""
    game = await _start_in_progress_game(
        client, auth_headers, second_registered_user["headers"], host_color="X"
    )
    code = game["code"]
    pre_version = game["version"]
    resign = await client.post(f"/multiplayer/{code}/resign", headers=auth_headers, json={})
    assert resign.status_code == 200
    new_v = resign.json()["version"]
    assert new_v > pre_version

    resp = await _move(
        client,
        code,
        second_registered_user["headers"],
        x=0,
        y=0,
        expected_version=new_v,
    )
    assert resp.status_code == 409
    assert "game_not_in_progress" in resp.text


# ---------------------------------------------------------------------------
# Modal/invite flow — host_color=null (guest chooses), cancel, expiry
# (see doc/multiplayer-modal-plan.md)
# ---------------------------------------------------------------------------


async def _set_expires_at(code: str, when_offset_sql: str) -> None:
    """Manually move a game's expires_at by a SQL interval string.

    `when_offset_sql` is interpolated as `NOW() + <interval>` — pass for
    instance `"-INTERVAL '1 minute'"` to push it into the past.
    """
    conn = await asyncpg.connect(TEST_DSN)
    try:
        await conn.execute(
            f"UPDATE multiplayer_games SET expires_at = NOW() + {when_offset_sql} WHERE code = $1",
            code,
        )
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_new_game_with_host_color_null_marks_guest_chooses(client: AsyncClient, auth_headers):
    """Posting host_color=null records color_chosen_by='guest' and host_color is unset."""
    resp = await client.post("/multiplayer/new", headers=auth_headers, json={"host_color": None})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["color_chosen_by"] == "guest"
    # Host's color is unresolved — the host's PlayerInfo.color is None until guest joins.
    assert data["host"]["color"] is None
    assert data["your_color"] is None


@pytest.mark.asyncio
async def test_new_game_with_host_color_set_marks_host_chose(client: AsyncClient, auth_headers):
    """Posting host_color='O' records color_chosen_by='host'."""
    data = await _create_game(client, auth_headers, host_color="O")
    assert data["color_chosen_by"] == "host"
    assert data["host"]["color"] == "O"


@pytest.mark.asyncio
async def test_new_game_response_includes_invite_url_and_expires_at(
    client: AsyncClient, auth_headers
):
    data = await _create_game(client, auth_headers)
    assert data["invite_url"].endswith(f"/play/{data['code']}")
    assert "expires_at" in data and data["expires_at"]  # ISO datetime string


@pytest.mark.asyncio
async def test_join_when_guest_chooses_picks_color(
    client: AsyncClient, auth_headers, second_registered_user
):
    """When color_chosen_by='guest', guest's chosen_color drives both colors."""
    created = await client.post("/multiplayer/new", headers=auth_headers, json={"host_color": None})
    code = created.json()["code"]

    join = await client.post(
        f"/multiplayer/{code}/join",
        headers=second_registered_user["headers"],
        json={"chosen_color": "O"},
    )
    assert join.status_code == 200, join.text
    body = join.json()
    assert body["state"] == "in_progress"
    # Guest picked O → host gets X.
    assert body["guest"]["color"] == "O"
    assert body["host"]["color"] == "X"
    assert body["your_color"] == "O"


@pytest.mark.asyncio
async def test_join_when_guest_chooses_missing_color_is_422(
    client: AsyncClient, auth_headers, second_registered_user
):
    created = await client.post("/multiplayer/new", headers=auth_headers, json={"host_color": None})
    code = created.json()["code"]
    join = await client.post(
        f"/multiplayer/{code}/join",
        headers=second_registered_user["headers"],
        json={},
    )
    assert join.status_code == 422
    assert "chosen_color_required" in join.text


@pytest.mark.asyncio
async def test_join_when_host_chose_with_chosen_color_is_422(
    client: AsyncClient, auth_headers, second_registered_user
):
    """If host already picked, guest sending chosen_color is rejected."""
    created = await _create_game(client, auth_headers, host_color="X")
    code = created["code"]
    join = await client.post(
        f"/multiplayer/{code}/join",
        headers=second_registered_user["headers"],
        json={"chosen_color": "O"},
    )
    assert join.status_code == 422
    assert "chosen_color_not_allowed" in join.text


@pytest.mark.asyncio
async def test_cancel_marks_state_cancelled_and_bumps_version(client: AsyncClient, auth_headers):
    created = await _create_game(client, auth_headers)
    code = created["code"]
    pre_version = created["version"]

    resp = await client.post(f"/multiplayer/{code}/cancel", headers=auth_headers, json={})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["state"] == "cancelled"
    assert body["version"] > pre_version


@pytest.mark.asyncio
async def test_cancel_by_non_host_returns_403(
    client: AsyncClient, auth_headers, second_registered_user
):
    created = await _create_game(client, auth_headers)
    code = created["code"]
    resp = await client.post(
        f"/multiplayer/{code}/cancel",
        headers=second_registered_user["headers"],
        json={},
    )
    assert resp.status_code == 403
    assert "not_the_host" in resp.text


@pytest.mark.asyncio
async def test_cancel_in_progress_returns_409(
    client: AsyncClient, auth_headers, second_registered_user
):
    game = await _start_in_progress_game(client, auth_headers, second_registered_user["headers"])
    code = game["code"]
    resp = await client.post(f"/multiplayer/{code}/cancel", headers=auth_headers, json={})
    assert resp.status_code == 409
    assert "cannot_cancel_in_state_in_progress" in resp.text


@pytest.mark.asyncio
async def test_join_after_cancel_returns_409_game_cancelled(
    client: AsyncClient, auth_headers, second_registered_user
):
    created = await _create_game(client, auth_headers)
    code = created["code"]
    cancel = await client.post(f"/multiplayer/{code}/cancel", headers=auth_headers, json={})
    assert cancel.status_code == 200

    join = await client.post(
        f"/multiplayer/{code}/join",
        headers=second_registered_user["headers"],
        json={},
    )
    assert join.status_code == 409
    assert "game_cancelled" in join.text


@pytest.mark.asyncio
async def test_get_after_expiry_lazily_cancels(client: AsyncClient, auth_headers):
    """A waiting game past expires_at is auto-cancelled on next read."""
    created = await _create_game(client, auth_headers)
    code = created["code"]
    await _set_expires_at(code, "-INTERVAL '1 minute'")

    resp = await client.get(f"/multiplayer/{code}", headers=auth_headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["state"] == "cancelled"


@pytest.mark.asyncio
async def test_join_after_expiry_returns_409_game_cancelled(
    client: AsyncClient, auth_headers, second_registered_user
):
    created = await _create_game(client, auth_headers)
    code = created["code"]
    await _set_expires_at(code, "-INTERVAL '1 minute'")

    join = await client.post(
        f"/multiplayer/{code}/join",
        headers=second_registered_user["headers"],
        json={},
    )
    assert join.status_code == 409
    # Expiry is reified as state='cancelled' by the lazy-expire path.
    assert "game_cancelled" in join.text


@pytest.mark.asyncio
async def test_new_code_collision_retries_until_unique(
    client: AsyncClient, auth_headers, monkeypatch
):
    """Mock new_code() to return a colliding value once, then a fresh one.

    The shared `allocate_game` helper must retry on
    UniqueViolationError without raising 500.
    """
    from app.multiplayer import allocate as allocate_mod

    real_codes = ["AAAAAA", "AAAAAA", "BBBBBB"]

    def fake_new_code() -> str:
        return real_codes.pop(0)

    monkeypatch.setattr(allocate_mod, "new_code", fake_new_code)

    first = await client.post("/multiplayer/new", headers=auth_headers, json={})
    second = await client.post("/multiplayer/new", headers=auth_headers, json={})
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["code"] == "AAAAAA"
    assert second.json()["code"] == "BBBBBB"


@pytest.mark.asyncio
async def test_move_oob_uses_400_not_422_for_high_coords(
    client: AsyncClient, auth_headers, second_registered_user
):
    """A 15-board move at x=15 must come back as 400 out_of_bounds, not 422.

    Per doc/multiplayer-bugs.md item #7 — the wire contract is one
    consistent OOB status, not a mix of Pydantic 422 / handler 400.
    """
    game = await _start_in_progress_game(
        client, auth_headers, second_registered_user["headers"], board_size=15
    )
    code = game["code"]
    resp = await _move(client, code, auth_headers, x=15, y=7, expected_version=game["version"])
    assert resp.status_code == 400
    assert "out_of_bounds" in resp.text


@pytest.mark.asyncio
async def test_finished_games_have_game_type_multiplayer(
    client: AsyncClient, auth_headers, second_registered_user
):
    """When a multiplayer game ends, both `games` rows are tagged game_type='multiplayer'."""
    game = await _start_in_progress_game(
        client, auth_headers, second_registered_user["headers"], host_color="X"
    )
    code = game["code"]

    resign = await client.post(f"/multiplayer/{code}/resign", headers=auth_headers, json={})
    assert resign.status_code == 200

    conn = await asyncpg.connect(TEST_DSN)
    try:
        rows = await conn.fetch(
            "SELECT game_type, depth, radius FROM games WHERE game_json::jsonb ? "
            "'multiplayer_game_id' AND (game_json::jsonb ->> 'multiplayer_game_id')::uuid "
            "= (SELECT id FROM multiplayer_games WHERE code = $1)",
            code,
        )
    finally:
        await conn.close()
    assert len(rows) == 2
    assert all(r["game_type"] == "multiplayer" for r in rows)
    assert all(r["depth"] == 0 and r["radius"] == 0 for r in rows)
