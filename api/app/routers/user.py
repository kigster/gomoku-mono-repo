from fastapi import APIRouter, Depends

from app.database import get_pool
from app.models.user import PersonalBest, UserOut
from app.scoring import rating
from app.security import get_current_user

router = APIRouter(prefix="/user", tags=["user"])


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
