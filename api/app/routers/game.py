import json as json_mod
import time

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse
from httpx import AsyncClient

from app.database import get_pool
from app.elo import ai_tier_rating, k_factor
from app.elo import update as elo_update
from app.logger import get_logger
from app.models.game import (
    GameHistoryEntry,
    GameHistoryResponse,
    GameSaveRequest,
    GameSaveResponse,
    GameStartRequest,
    GameStartResponse,
)
from app.scoring import game_score, rating
from app.security import get_current_user

router = APIRouter(prefix="/game", tags=["game"])
log = get_logger("gomoku.game")


def log_game_request(
    request: Request, start_time: float, status_code: int, payload_bytes: int
) -> None:
    latency_ms = (time.monotonic() - start_time) * 1000
    log.info(
        "game_route",
        method=request.method,
        path=request.url.path,
        status=status_code,
        payload_bytes=payload_bytes,
        latency_ms=round(latency_ms, 1),
    )


@router.post("/play")
async def play(request: Request):
    """Proxy game state to gomoku-httpd and return the AI's response."""
    start_time = time.monotonic()
    body = await request.body()
    client: AsyncClient = request.app.state.httpx_client
    try:
        resp = await client.post(
            "/gomoku/play",
            content=body,
            headers={"Content-Type": "application/json"},
        )
    except Exception as exc:
        log.error("engine_request_failed", error=str(exc), error_type=type(exc).__name__)
        log_game_request(request, start_time, status.HTTP_503_SERVICE_UNAVAILABLE, len(body))
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Game engine unavailable, please retry",
        )
    log_game_request(request, start_time, resp.status_code, len(body))

    if resp.status_code != 200:
        # Surface the engine's actual response so we can debug auth / routing
        # issues without the JSON-decode crash that previously masked the cause.
        log.error(
            "engine_non_200",
            status=resp.status_code,
            content_type=resp.headers.get("content-type", "(none)"),
            body_preview=resp.text[:500] if resp.text else "(empty)",
        )
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"Game engine returned HTTP {resp.status_code}",
        )

    return resp.json()


@router.post("/start", response_model=GameStartResponse)
async def start(
    request: Request,
    user: dict = Depends(get_current_user),
    pool=Depends(get_pool),
    body: GameStartRequest | None = None,
) -> GameStartResponse:
    """
    Body is optional so legacy clients (no body) still work; missing
    fields fall back to the defaults defined on GameStartRequest.

    Insert a games row in `in_progress` state and return its id.

    The frontend stores `game_id` in the local game JSON and sends it
    back on `/game/save`, which allows the backend to UPDATEs the game
    row instead of inserting a new one. That means one AI session =
    one `games` row, visible from the moment it starts (so
    `online_users` can derive an "ai-battle" state from
    `games.status = 'in_progress'`).

    NOTE: Any prior `in_progress` AI rows for this user are flipped to
    `abandoned` first — a user who never finished a previous game (tab
    close, crash) gets the unfinished row tidied automatically when
    they start a new one. The leftover stale rows that nobody ever
    follows up on are handled by a future cleanup pass.
    """
    if body is None:
        body = GameStartRequest()
    start_time = time.monotonic()
    user_id = str(user["id"])
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "UPDATE users SET games_started = games_started + 1 WHERE id = $1::uuid",
                user_id,
            )
            # Abandon any prior in-flight AI games for this user before
            # we start a new one. Keeps `online_users.state` unambiguous
            # (one current game per player) and prevents the partial
            # `games_in_progress_idx` from growing unbounded with stale
            # rows. The CHECK on status='completed'→invariants doesn't
            # trip because we're not transitioning to 'completed'.
            await conn.execute(
                """
                UPDATE games
                SET    status = 'abandoned'
                WHERE  user_id = $1::uuid
                  AND  game_type = 'ai'
                  AND  status = 'in_progress'
                """,
                user_id,
            )
            row = await conn.fetchrow(
                """
                INSERT INTO games (
                    username, user_id, game_type, status,
                    board_size, depth, radius, total_moves,
                    human_player, human_time_s, ai_time_s, score, game_json
                ) VALUES (
                    $1, $2::uuid, 'ai', 'in_progress',
                    $3, $4, $5, 0,
                    $6, 0, 0, 0, '{}'::jsonb
                )
                RETURNING id
                """,
                user["username"],
                user_id,
                body.board_size,
                body.depth,
                body.radius,
                body.human_player,
            )
    log_game_request(request, start_time, status.HTTP_200_OK, 0)
    return GameStartResponse(game_id=str(row["id"]))


@router.post("/save", response_model=GameSaveResponse)
async def save(
    body: GameSaveRequest,
    request: Request,
    user: dict = Depends(get_current_user),
    pool=Depends(get_pool),
):
    """Save a completed game with score calculation."""
    start_time = time.monotonic()
    raw_body = await request.body()
    gj = body.game_json
    winner = gj.get("winner", "none")
    if winner == "none":
        log_game_request(request, start_time, status.HTTP_400_BAD_REQUEST, len(raw_body))
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Game is not finished")

    # Determine which side is human
    x_conf = gj.get("X", {})
    o_conf = gj.get("O", {})
    if x_conf.get("player") == "human":
        human_player = "X"
        ai_depth = o_conf.get("depth", 3)
    elif o_conf.get("player") == "human":
        human_player = "O"
        ai_depth = x_conf.get("depth", 3)
    else:
        human_player = "X"
        ai_depth = max(x_conf.get("depth", 3), o_conf.get("depth", 3))

    moves = gj.get("moves", [])
    human_time_s = 0.0
    ai_time_s = 0.0
    for m in moves:
        ms = m.get("time_ms", 0)
        secs = ms / 1000.0
        if f"{human_player} (human)" in m:
            human_time_s += secs
        else:
            ai_time_s += secs

    human_won = winner == human_player
    radius = gj.get("radius", 2)
    score = game_score(human_won, ai_depth, radius, human_time_s)

    client_ip = getattr(request.state, "client_ip", None) if hasattr(request, "state") else None
    user_id = str(user["id"])

    # Elo update against the AI tier the human chose. Draws are rare in
    # Gomoku (eloDraw=0.01 in BayesElo), but we treat anything that isn't
    # a clear human win as a loss for now — the engine never resigns and
    # the C side never reports 'draw' yet.
    score_a = 1.0 if human_won else 0.0
    opponent_rating = ai_tier_rating(ai_depth, radius)

    async with pool.acquire() as conn:
        async with conn.transaction():
            user_row = await conn.fetchrow(
                "SELECT elo_rating, elo_peak, elo_games_count FROM users WHERE id = $1::uuid",
                user_id,
            )
            elo_before = int(user_row["elo_rating"])
            games_before = int(user_row["elo_games_count"])
            peak_before = int(user_row["elo_peak"])
            k = k_factor(games_before, elo_before)
            elo_after = elo_update(elo_before, opponent_rating, score_a, k)
            peak_after = max(peak_before, elo_after)

            # Prefer UPDATE-by-id when the client sends a `game_id`
            # captured from `/game/start` — that path keeps a single row
            # per AI session (no duplicate rows for the same game).
            # The UPDATE is scoped to `user_id` so a misbehaving client
            # can't overwrite somebody else's game. Falls back to
            # INSERT when no game_id is provided (legacy clients).
            row = None
            if body.game_id:
                row = await conn.fetchrow(
                    """UPDATE games
                          SET status        = 'completed',
                              winner        = $3,
                              human_player  = $4,
                              board_size    = $5,
                              depth         = $6,
                              radius        = $7,
                              total_moves   = $8,
                              human_time_s  = $9,
                              ai_time_s     = $10,
                              score         = $11,
                              game_json     = $12::jsonb,
                              client_ip     = $13::inet,
                              elo_before    = $14,
                              elo_after     = $15,
                              opponent_elo_before = $16
                        WHERE id = $1::uuid
                          AND user_id = $2::uuid
                        RETURNING id""",
                    body.game_id,
                    user_id,
                    winner,
                    human_player,
                    gj.get("board_size", 19),
                    ai_depth,
                    radius,
                    len(moves),
                    human_time_s,
                    ai_time_s,
                    score,
                    json_mod.dumps(gj),
                    client_ip,
                    elo_before,
                    elo_after,
                    opponent_rating,
                )
            if row is None:
                row = await conn.fetchrow(
                    """INSERT INTO games
                       (username, user_id, winner, human_player, board_size, depth, radius,
                        total_moves, human_time_s, ai_time_s, score, game_json, client_ip,
                        elo_before, elo_after, opponent_elo_before, status)
                       VALUES ($1, $2::uuid, $3, $4, $5, $6, $7,
                               $8, $9, $10, $11, $12::jsonb, $13::inet,
                               $14, $15, $16, 'completed')
                       RETURNING id""",
                    user["username"],
                    user_id,
                    winner,
                    human_player,
                    gj.get("board_size", 19),
                    ai_depth,
                    radius,
                    len(moves),
                    human_time_s,
                    ai_time_s,
                    score,
                    json_mod.dumps(gj),
                    client_ip,
                    elo_before,
                    elo_after,
                    opponent_rating,
                )
            await conn.execute(
                """UPDATE users
                       SET games_finished = games_finished + 1,
                           elo_rating = $2,
                           elo_peak = $3,
                           elo_games_count = elo_games_count + 1,
                           updated_at = now()
                     WHERE id = $1::uuid""",
                user_id,
                elo_after,
                peak_after,
            )

    log_game_request(request, start_time, status.HTTP_200_OK, len(raw_body))
    return GameSaveResponse(
        id=str(row["id"]),
        score=score,
        rating=rating(score),
        elo_before=elo_before,
        elo_after=elo_after,
        elo_delta=elo_after - elo_before,
    )


@router.get("/history", response_model=GameHistoryResponse)
async def game_history(
    request: Request,
    limit: int = Query(default=50, ge=1, le=200),
    user: dict = Depends(get_current_user),
    pool=Depends(get_pool),
):
    """Return the authenticated user's games in reverse chronological order."""
    start_time = time.monotonic()
    rows = await pool.fetch(
        """SELECT g.id, g.username, g.winner, g.human_player, g.score, g.depth,
                  round(g.human_time_s::numeric, 1) AS human_time_s,
                  round(g.ai_time_s::numeric, 1) AS ai_time_s,
                  g.played_at, g.game_type,
                  g.elo_before, g.elo_after, g.opponent_elo_before,
                  opp.username AS opponent_username
           FROM games g
           LEFT JOIN users opp ON opp.id = g.opponent_id
           WHERE g.user_id = $1::uuid
           ORDER BY g.played_at DESC
           LIMIT $2""",
        str(user["id"]),
        limit,
    )
    response = GameHistoryResponse(
        games=[
            GameHistoryEntry(
                id=str(r["id"]),
                username=r["username"],
                won=r["winner"] == r["human_player"],
                score=r["score"],
                depth=r["depth"],
                human_time_s=float(r["human_time_s"]),
                ai_time_s=float(r["ai_time_s"]),
                played_at=r["played_at"],
                game_type=r["game_type"],
                opponent_username=r["opponent_username"] or "AI",
                elo_before=r["elo_before"],
                elo_after=r["elo_after"],
                opponent_elo_before=r["opponent_elo_before"],
            )
            for r in rows
        ]
    )
    log_game_request(request, start_time, status.HTTP_200_OK, 0)
    return response


@router.get("/{game_id}/json")
async def download_game_json(
    request: Request,
    game_id: str,
    user: dict = Depends(get_current_user),
    pool=Depends(get_pool),
):
    """Return the full game JSON for a single game (for download)."""
    start_time = time.monotonic()
    row = await pool.fetchrow(
        "SELECT game_json FROM games WHERE id = $1::uuid AND user_id = $2::uuid",
        game_id,
        str(user["id"]),
    )
    if row is None:
        log_game_request(request, start_time, status.HTTP_404_NOT_FOUND, 0)
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Game not found")
    data = row["game_json"]
    if isinstance(data, str):
        data = json_mod.loads(data)
    log_game_request(request, start_time, status.HTTP_200_OK, 0)
    return JSONResponse(content=data)
