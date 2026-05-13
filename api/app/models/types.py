"""Models for the leaderboard API."""

from datetime import datetime

from pydantic import BaseModel


class LeaderboardEntry(BaseModel):
    """Leaderboard entry response body."""

    username: str
    # Elo is now the canonical ranking field. `score` / `rating` are kept
    # for backward compatibility with the existing frontend; both will
    # disappear once the UI fully migrates to Elo.
    elo_rating: int = 1500
    elo_games_count: int = 0
    score: int = 0
    rating: float = 0.0
    depth: int = 0
    radius: int = 0
    total_moves: int = 0
    human_time_s: float = 0.0
    geo_country: str | None = None
    geo_city: str | None = None
    played_at: datetime


class LeaderboardResponse(BaseModel):
    """Leaderboard response body."""

    entries: list[LeaderboardEntry]
