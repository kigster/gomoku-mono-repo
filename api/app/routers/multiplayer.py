"""Human-vs-human multiplayer router.

See:

- `doc/human-vs-human-plan.md` §4 for the original API surface and §5 for
  the concurrency rules.
- `doc/multiplayer-modal-plan.md` for the host-chooses / guest-chooses
  color flow, the 15-minute invite expiry, and the cancel endpoint.
- `doc/multiplayer-bugs.md` for the issues that this version addresses
  (collision retry on code generation, board-size move validation,
  game_type discriminator on the `games` history table, surfacing of
  cancellation/expiry to the client, etc.).

All endpoints require authentication (`get_current_user`). Codes are
6-char Crockford base32 (`app.multiplayer.codes`). Win detection is
`count == 5` (matches the C engine — see
`gomoku-c/src/gomoku/gomoku.c:180`).
"""

from __future__ import annotations

import json as json_mod
from typing import Any, Literal, cast

from fastapi import APIRouter, Depends, Query, Request, Response, status
from fastapi.responses import JSONResponse

from app.database import get_pool
from app.elo import k_factor
from app.elo import update as elo_update
from app.models.db_tables import (
    ColorChosenBy,
    MultiplayerCreatedVia,
    MultiplayerGameRow,
    MultiplayerGameState,
    MultiplayerGameWithUsersRow,
    StoneColor,
)
from app.models.multiplayer import (
    CancelRequest,
    JoinRequest,
    MoveRequest,
    MultiplayerGamePreview,
    MultiplayerGameView,
    NewMultiplayerGameRequest,
    PlayerInfo,
    ResignRequest,
)
from app.multiplayer import allocate_game, game_invite_url
from app.multiplayer import db as mp_db
from app.multiplayer.exceptions import (
    CannotCancelInState,
    CannotJoinOwnGame,
    ChosenColorNotAllowed,
    ChosenColorRequired,
    FailedToAllocateCode,
    GameAlreadyFull,
    GameCancelled,
    GameNotInProgress,
    GameNotInWaitingState,
    MultiplayerGameNotFound,
    NotAParticipant,
    NotTheHost,
    NotYourTurn,
    OutOfBounds,
    SquareOccupied,
    VersionConflict,
)
from app.multiplayer.win_detector import has_winner
from app.security import get_current_user

router = APIRouter(prefix="/multiplayer", tags=["multiplayer"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _coerce_moves(raw: Any) -> list[tuple[int, int]]:
    """Convert the JSONB `moves` column to list[tuple[int,int]].

    asyncpg may hand us either a Python list (if a JSONB type codec is in use)
    or a JSON string. Normalise both.
    """
    if raw is None:
        return []
    if isinstance(raw, str):
        raw = json_mod.loads(raw)
    return [(int(m[0]), int(m[1])) for m in raw]


def _opposite_color(color: StoneColor | str) -> Literal["X", "O"]:
    return "O" if color == "X" else "X"


def _participant_color(row: MultiplayerGameRow, user_id: str) -> Literal["X", "O"] | None:
    """Return 'X' / 'O' if `user_id` is host/guest, else None.

    When `host_color is None` (host let the guest pick and they haven't
    joined yet), we still need to identify the host as a participant —
    fall back to the role rather than the colour."""
    if str(row.host_user_id) == user_id:
        return cast('Literal["X", "O"] | None', row.host_color.value if row.host_color else None)
    if row.guest_user_id is not None and str(row.guest_user_id) == user_id:
        host_color = row.host_color.value if row.host_color else None
        return _opposite_color(host_color) if host_color else None
    return None


def _build_view(
    row: MultiplayerGameRow,
    *,
    host_username: str,
    guest_username: str | None,
    your_color: str | None,
) -> MultiplayerGameView:
    """Assemble the full participant view from a DB row."""
    moves = _coerce_moves(row.moves)
    host_color = row.host_color.value if row.host_color else None
    next_to_move = cast(Literal["X", "O"], row.next_to_move.value)
    your_turn = (
        your_color is not None
        and row.state == MultiplayerGameState.IN_PROGRESS
        and your_color == next_to_move
    )
    guest_color = _opposite_color(host_color) if (host_color and guest_username) else None
    return MultiplayerGameView(
        code=row.code,
        state=row.state.value,
        board_size=row.board_size,
        rule_set=row.rule_set,
        host=PlayerInfo(username=host_username, color=cast('Literal["X", "O"] | None', host_color)),
        guest=(
            PlayerInfo(username=guest_username, color=cast('Literal["X", "O"] | None', guest_color))
            if guest_username
            else None
        ),
        moves=moves,
        next_to_move=next_to_move,
        winner=row.winner.value if row.winner else None,
        your_color=cast('Literal["X", "O"] | None', your_color),
        your_turn=your_turn,
        version=row.version,
        color_chosen_by=row.color_chosen_by.value,
        expires_at=row.expires_at,
        created_at=row.created_at,
        finished_at=row.finished_at,
        invite_url=game_invite_url(row.code),
    )


def _build_preview(
    row: MultiplayerGameWithUsersRow,
    *,
    host_username: str,
    guest_username: str | None,
) -> MultiplayerGamePreview:
    host_color = row.host_color.value if row.host_color else None
    guest_color = _opposite_color(host_color) if (host_color and guest_username) else None
    return MultiplayerGamePreview(
        code=row.code,
        state=row.state.value,
        board_size=row.board_size,
        rule_set=row.rule_set,
        host=PlayerInfo(username=host_username, color=cast('Literal["X", "O"] | None', host_color)),
        guest=(
            PlayerInfo(username=guest_username, color=cast('Literal["X", "O"] | None', guest_color))
            if guest_username
            else None
        ),
        next_to_move=row.next_to_move.value,
        winner=row.winner.value if row.winner else None,
        version=row.version,
        color_chosen_by=row.color_chosen_by.value,
        expires_at=row.expires_at,
        created_at=row.created_at,
        finished_at=row.finished_at,
    )


async def _expire_if_stale(conn, code: str) -> None:
    """Lazy expiry: if a `waiting` game is past its TTL, mark it `cancelled`.

    The expiry-bumps-version semantics mean polling clients will see the
    state change on their next poll. Per `doc/multiplayer-modal-plan.md`
    §3 — no background sweeper required for the modal flow.
    """
    await mp_db.expire_waiting_if_stale(conn, code)


async def _fetch_with_usernames(conn, code: str) -> MultiplayerGameWithUsersRow | None:
    """Return a typed row with all multiplayer_games columns plus
    `host_username` and `guest_username`, or None if missing."""
    return await mp_db.fetch_game_with_usernames_by_code(conn, code)


async def _write_finished_games_rows(
    conn,
    *,
    mp_row: MultiplayerGameRow,
    host_username: str,
    guest_username: str,
    winner: str,
    moves: list[tuple[int, int]],
) -> None:
    """Write two `games` rows, one per participant, when a multiplayer game ends.

    `game_type='multiplayer'` admits the depth/radius/total_moves zero
    sentinels (see migration 0006 + `doc/multiplayer-bugs.md` item #1).
    """
    assert mp_row.guest_user_id is not None, (
        "_write_finished_games_rows must only be called once a guest has joined"
    )
    host_color = mp_row.host_color.value if mp_row.host_color else "X"
    guest_color_for_json = _opposite_color(host_color)
    winner_username = (
        host_username
        if winner == host_color
        else (guest_username if winner == guest_color_for_json else None)
    )
    loser_username = (
        guest_username
        if winner_username == host_username
        else (host_username if winner_username == guest_username else None)
    )
    game_json = json_mod.dumps(
        {
            "multiplayer_game_id": str(mp_row.id),
            "game_type": "multiplayer",
            "host": {"username": host_username, "color": host_color},
            "guest": {"username": guest_username, "color": guest_color_for_json},
            # Convenience: ('X' or 'O') -> username, so reading the JSON
            # answers "who plays X?" without thinking about host/guest.
            "players_by_color": {
                host_color: host_username,
                guest_color_for_json: guest_username,
            },
            "winner_color": winner,
            "winner_username": winner_username,
            "loser_username": loser_username,
            "moves": [list(m) for m in moves],
            "rule_set": mp_row.rule_set,
            "board_size": mp_row.board_size,
            # Legacy convenience field — duplicate of winner_color for tools
            # already keying off `winner`.
            "winner": winner,
            # Legacy convenience fields preserved for backward compat.
            "host_username": host_username,
            "guest_username": guest_username,
        }
    )
    total_moves = len(moves)
    host_color = mp_row.host_color.value if mp_row.host_color else "X"
    guest_color = _opposite_color(host_color)
    host_user_id = str(mp_row.host_user_id)
    guest_user_id = str(mp_row.guest_user_id)

    # Live Elo update for both players. Host's score is 1.0 if host_color
    # won, 0.5 on draw, 0.0 on loss; guest's is the symmetric value.
    host_row = await mp_db.fetch_user_elo_snapshot(conn, host_user_id)
    guest_row = await mp_db.fetch_user_elo_snapshot(conn, guest_user_id)
    host_elo_before = int(host_row.elo_rating)
    guest_elo_before = int(guest_row.elo_rating)
    if winner == "draw":
        host_score, guest_score = 0.5, 0.5
    elif winner == host_color:
        host_score, guest_score = 1.0, 0.0
    else:
        host_score, guest_score = 0.0, 1.0
    host_k = k_factor(int(host_row.elo_games_count), host_elo_before)
    guest_k = k_factor(int(guest_row.elo_games_count), guest_elo_before)
    host_elo_after = elo_update(host_elo_before, guest_elo_before, host_score, host_k)
    guest_elo_after = elo_update(guest_elo_before, host_elo_before, guest_score, guest_k)

    # Host row — opponent is the guest.
    await mp_db.insert_finished_game_history_row(
        conn,
        username=host_username,
        user_id=host_user_id,
        winner=winner,
        human_player=host_color,
        board_size=mp_row.board_size,
        total_moves=total_moves,
        game_json=game_json,
        opponent_id=guest_user_id,
        elo_before=host_elo_before,
        elo_after=host_elo_after,
        opponent_elo_before=guest_elo_before,
    )
    # Guest row — opponent is the host.
    await mp_db.insert_finished_game_history_row(
        conn,
        username=guest_username,
        user_id=guest_user_id,
        winner=winner,
        human_player=guest_color,
        board_size=mp_row.board_size,
        total_moves=total_moves,
        game_json=game_json,
        opponent_id=host_user_id,
        elo_before=guest_elo_before,
        elo_after=guest_elo_after,
        opponent_elo_before=host_elo_before,
    )

    # Roll the new ratings forward on the users table.
    await mp_db.update_user_elo(conn, user_id=host_user_id, elo_after=host_elo_after)
    await mp_db.update_user_elo(conn, user_id=guest_user_id, elo_after=guest_elo_after)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/new", response_model=MultiplayerGameView)
async def new_game(
    body: NewMultiplayerGameRequest,
    user: dict = Depends(get_current_user),
    pool=Depends(get_pool),
):
    color_chosen_by = ColorChosenBy.HOST if body.host_color is not None else ColorChosenBy.GUEST
    async with pool.acquire() as conn:
        async with conn.transaction():
            try:
                row = await allocate_game(
                    conn,
                    host_user_id=str(user["id"]),
                    host_color=body.host_color,
                    color_chosen_by=color_chosen_by.value,
                    board_size=body.board_size,
                    created_via=MultiplayerCreatedVia.MODAL,
                )
            except RuntimeError:
                raise FailedToAllocateCode()
    your_color = body.host_color  # may be None when guest chooses
    return _build_view(
        row,
        host_username=user["username"],
        guest_username=None,
        your_color=your_color,
    )


@router.get("/mine")
async def my_games(
    limit: int = Query(default=50, ge=1, le=200),
    user: dict = Depends(get_current_user),
    pool=Depends(get_pool),
):
    """Return the caller's recent multiplayer games (host or guest), DESC by created_at."""
    user_id = str(user["id"])
    async with pool.acquire() as conn:
        rows = await mp_db.list_games_with_usernames_for_user(conn, user_id, limit)
    out: list[dict] = []
    for row in rows:
        your_color = _participant_color(row, user_id)
        view = _build_view(
            row,
            host_username=row.host_username,
            guest_username=row.guest_username,
            your_color=your_color,
        )
        out.append(view.model_dump(mode="json"))
    return out


@router.post("/{code}/join", response_model=MultiplayerGameView)
async def join_game(
    code: str,
    body: JoinRequest,
    user: dict = Depends(get_current_user),
    pool=Depends(get_pool),
):
    user_id = str(user["id"])
    async with pool.acquire() as conn:
        async with conn.transaction():
            await _expire_if_stale(conn, code)

            existing = await mp_db.fetch_game_by_code_for_update(conn, code)
            if existing is None:
                raise MultiplayerGameNotFound()

            # Pre-flight checks before mutating.
            if str(existing.host_user_id) == user_id:
                raise CannotJoinOwnGame()
            if existing.state == MultiplayerGameState.CANCELLED:
                raise GameCancelled()
            if existing.guest_user_id is not None:
                raise GameAlreadyFull()
            if existing.state != MultiplayerGameState.WAITING:
                raise GameNotInWaitingState()

            color_chosen_by = existing.color_chosen_by
            chosen = body.chosen_color
            if color_chosen_by == ColorChosenBy.GUEST:
                if chosen is None:
                    raise ChosenColorRequired()
                # Guest picks their colour; host gets the opposite.
                new_host_color = _opposite_color(chosen)
            else:
                if chosen is not None:
                    raise ChosenColorNotAllowed()
                new_host_color = existing.host_color.value if existing.host_color else "X"

            row = await mp_db.update_join_game(conn, code, user_id, new_host_color)
            # `host_user_id` is a NOT NULL FK to `users`, so the lookup
            # never legitimately returns None — the `or '?'` only narrows
            # the static type for `_build_view(host_username: str)`.
            host_username = (
                await mp_db.fetch_username_by_id(conn, str(row.host_user_id))
            ) or "?"

    your_color = _opposite_color(row.host_color.value if row.host_color else "X")
    return _build_view(
        row,
        host_username=host_username,
        guest_username=user["username"],
        your_color=your_color,
    )


@router.post("/{code}/cancel", response_model=MultiplayerGameView)
async def cancel_game(
    code: str,
    body: CancelRequest,  # noqa: ARG001
    user: dict = Depends(get_current_user),
    pool=Depends(get_pool),
):
    """Host-only: cancel a `waiting` game. Marks it `cancelled` in the DB."""
    user_id = str(user["id"])
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await mp_db.fetch_game_with_usernames_by_code_for_update(conn, code)
            if row is None:
                raise MultiplayerGameNotFound()

            if str(row.host_user_id) != user_id:
                raise NotTheHost()
            if row.state != MultiplayerGameState.WAITING:
                raise CannotCancelInState(row.state.value)

            row = await mp_db.update_cancel_game_by_id(conn, str(row.id))

    your_color = _participant_color(row, user_id)
    return _build_view(
        row,
        host_username=user["username"],
        guest_username=None,
        your_color=your_color,
    )


@router.get("/{code}")
async def get_game(
    code: str,
    request: Request,
    response: Response,  # noqa: ARG001
    since_version: int | None = Query(default=None, ge=0),
    user: dict = Depends(get_current_user),
    pool=Depends(get_pool),
):
    async with pool.acquire() as conn:
        await _expire_if_stale(conn, code)
        row = await _fetch_with_usernames(conn, code)
    if row is None:
        raise MultiplayerGameNotFound()

    if since_version is not None and row.version <= since_version:
        # Two response shapes for the "no change since `since_version`"
        # branch, chosen by an opt-in request header so the backend can be
        # rolled out ahead of the frontend without breaking deployed clients:
        #
        #   - Default (no header): HTTP 304 with an empty body. Legacy
        #     contract. Chrome logs a "Fetch failed loading" protocol
        #     error once per poll because the request didn't carry a
        #     conditional validator (the browser cache layer normally
        #     adds those, but we don't go through it). The fetch promise
        #     still resolves with status 304 so JS reads it cleanly.
        #
        #   - With `X-Accept-No-Change: 1`: HTTP 200 with a small JSON
        #     sentinel `{no_change: true, version: N}`. Modern clients
        #     send this header so the polling loop is silent in devtools.
        if request.headers.get("x-accept-no-change") == "1":
            return JSONResponse(content={"no_change": True, "version": row.version})
        return Response(status_code=status.HTTP_304_NOT_MODIFIED)

    user_id = str(user["id"])
    is_host = str(row.host_user_id) == user_id
    is_guest = row.guest_user_id is not None and str(row.guest_user_id) == user_id

    if not (is_host or is_guest):
        preview = _build_preview(
            row,
            host_username=row.host_username,
            guest_username=row.guest_username,
        )
        return JSONResponse(content=preview.model_dump(mode="json"))

    your_color = _participant_color(row, user_id)
    view = _build_view(
        row,
        host_username=row.host_username,
        guest_username=row.guest_username,
        your_color=your_color,
    )
    return JSONResponse(content=view.model_dump(mode="json"))


@router.post("/{code}/move", response_model=MultiplayerGameView)
async def make_move(
    code: str,
    body: MoveRequest,
    user: dict = Depends(get_current_user),
    pool=Depends(get_pool),
):
    user_id = str(user["id"])
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await mp_db.fetch_game_with_usernames_by_code_for_update(conn, code)
            if row is None:
                raise MultiplayerGameNotFound()

            your_color = _participant_color(row, user_id)
            if your_color is None:
                raise NotAParticipant()

            if row.state != MultiplayerGameState.IN_PROGRESS:
                raise GameNotInProgress()

            x, y = int(body.x), int(body.y)
            board_size = row.board_size
            # Single canonical OOB check — keeps the wire contract on a
            # consistent 400 regardless of which axis or whether the value
            # would also fail a Pydantic upper bound (see
            # doc/multiplayer-bugs.md item #7).
            if not (0 <= x < board_size and 0 <= y < board_size):
                raise OutOfBounds()

            if body.expected_version != row.version:
                raise VersionConflict()

            if your_color != row.next_to_move.value:
                raise NotYourTurn()

            moves = _coerce_moves(row.moves)
            if (x, y) in {(mx, my) for mx, my in moves}:
                raise SquareOccupied()

            moves.append((x, y))

            won = has_winner(moves, x, y, your_color, board_size)
            new_state = "finished" if won else "in_progress"
            new_winner = your_color if won else None
            next_to_move = (
                row.next_to_move.value if won else _opposite_color(row.next_to_move.value)
            )

            updated_row = await mp_db.update_game_after_move(
                conn,
                game_id=str(row.id),
                moves=moves,
                next_to_move=next_to_move,
                new_state=new_state,
                new_winner=new_winner,
            )

            if won:
                # `won` implies `new_winner is not None` — narrow for the
                # type checker which can't see across the conditional.
                assert new_winner is not None
                await _write_finished_games_rows(
                    conn,
                    mp_row=updated_row,
                    host_username=row.host_username,
                    guest_username=cast(str, row.guest_username),
                    winner=new_winner,
                    moves=moves,
                )

    return _build_view(
        updated_row,
        host_username=row.host_username,
        guest_username=row.guest_username,
        your_color=your_color,
    )


@router.post("/{code}/resign", response_model=MultiplayerGameView)
async def resign_game(
    code: str,
    body: ResignRequest,  # noqa: ARG001
    user: dict = Depends(get_current_user),
    pool=Depends(get_pool),
):
    user_id = str(user["id"])
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await mp_db.fetch_game_with_usernames_by_code_for_update(conn, code)
            if row is None:
                raise MultiplayerGameNotFound()

            your_color = _participant_color(row, user_id)
            if your_color is None:
                raise NotAParticipant()
            if row.state != MultiplayerGameState.IN_PROGRESS:
                raise GameNotInProgress()

            winner = _opposite_color(your_color)
            updated_row = await mp_db.update_game_after_resign(
                conn, game_id=str(row.id), winner=winner
            )

            moves = _coerce_moves(updated_row.moves)
            await _write_finished_games_rows(
                conn,
                mp_row=updated_row,
                host_username=row.host_username,
                guest_username=cast(str, row.guest_username),
                winner=winner,
                moves=moves,
            )

    return _build_view(
        updated_row,
        host_username=row.host_username,
        guest_username=row.guest_username,
        your_color=your_color,
    )
