from fastapi import APIRouter, Depends, HTTPException, status

from app.database import get_pool
from app.logger import get_logger
from app.models.user import (
    PersonalBest,
    PresenceSeenRequest,
    PresenceSeenResponse,
    UserOut,
)
from app.scoring import rating
from app.security import get_current_user

router = APIRouter(prefix="/user", tags=["user"])

# Separate router so the plural "/users/me/seen" path documented in
# AGENT.md doesn't collide with the legacy singular "/user/me" endpoints
# above. Both routers live in this module because they target the same
# resource (the authenticated user).
seen_router = APIRouter(prefix="/users", tags=["user"])

log = get_logger("gomoku.presence")


@router.get("/me", response_model=UserOut)
async def get_me(user: dict = Depends(get_current_user), pool=Depends(get_pool)) -> UserOut:
    best = await pool.fetchrow(
        """SELECT score, depth, radius, played_at
           FROM games
           WHERE user_id = $1::uuid AND score > 0
           ORDER BY score DESC
           LIMIT 1""",
        str(user["id"]),
    )
    personal_best = None
    if best:
        personal_best = PersonalBest(
            score=best["score"],
            rating=rating(best["score"]),
            depth=best["depth"],
            radius=best["radius"],
            played_at=best["played_at"],
        )

    wl = await pool.fetchrow(
        """SELECT
               COUNT(*) FILTER (WHERE winner = human_player) AS won,
               COUNT(*) FILTER (WHERE winner != human_player AND winner != 'draw') AS lost
           FROM games
           WHERE user_id = $1::uuid""",
        str(user["id"]),
    )

    elo = await pool.fetchrow(
        "SELECT elo_rating, elo_peak, elo_games_count FROM users WHERE id = $1::uuid",
        str(user["id"]),
    )

    return UserOut(
        id=user["id"],
        username=user["username"],
        email=user.get("email"),
        first_name=user.get("first_name"),
        last_name=user.get("last_name"),
        created_at=user["created_at"],
        last_logged_in_at=user.get("last_logged_in_at"),
        logins_count=user.get("logins_count", 0),
        games_won=wl["won"] if wl else 0,
        games_lost=wl["lost"] if wl else 0,
        personal_best=personal_best,
        elo_rating=int(elo["elo_rating"]) if elo else 1500,
        elo_peak=int(elo["elo_peak"]) if elo else 1500,
        elo_games_count=int(elo["elo_games_count"]) if elo else 0,
    )


@seen_router.post("/me/seen", response_model=PresenceSeenResponse)
async def update_seen(
    body: PresenceSeenRequest,
    user: dict = Depends(get_current_user),
    pool=Depends(get_pool),
) -> PresenceSeenResponse:
    """Client-driven presence update. See PresenceSeenRequest for the
    debounce/scheduler contract on the frontend.

    The UPDATE is guarded by `last_seen_at < $1` so a late-arriving
    POST from a tab that was offline for a while can't roll back the
    timestamp set by a fresher submission from another tab. The
    RETURNING clause echoes whichever value won, so the client can
    sync its `activity_synced_at` to the canonical server value.
    """
    user_id = str(user["id"])
    try:
        row = await pool.fetchrow(
            """
            UPDATE users
            SET    last_seen_at = $1
            WHERE  id = $2::uuid
              AND  last_seen_at < $1
            RETURNING last_seen_at
            """,
            body.last_seen_at,
            user_id,
        )
        if row is not None:
            return PresenceSeenResponse(last_seen_at=row["last_seen_at"])
        # No row updated — incoming timestamp wasn't fresher. Echo
        # the stored value so the client knows what the server has.
        current = await pool.fetchval(
            "SELECT last_seen_at FROM users WHERE id = $1::uuid",
            user_id,
        )
    except Exception as exc:
        log.error(
            "presence_update_failed",
            user_id=user_id,
            error=str(exc),
            error_type=type(exc).__name__,
        )
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "Failed to update last_seen_at",
        )
    if current is None:
        # The auth check passed, so the row exists by definition. If
        # somehow it vanished between the UPDATE attempt and the SELECT
        # treat it as a hard auth failure rather than papering over.
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User not found")
    return PresenceSeenResponse(last_seen_at=current)
