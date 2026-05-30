"""Models for the game API."""

from datetime import datetime

from pydantic import BaseModel


class GameStartRequest(BaseModel):
    """Request body for `/game/start`.

    Carries the settings the user picked so we can persist them on the
    `games` row right away. Every field has a defensive default so an
    old frontend that POSTs an empty body still works — `/game/start`
    has been fire-and-forget on the client side for a long time and
    we don't want to break that.
    """

    board_size: int = 15
    depth: int = 3
    radius: int = 2
    human_player: str = "X"


class GameStartResponse(BaseModel):
    """Response body for `/game/start`."""

    game_id: str
    status: str = "ok"


class GameSaveRequest(BaseModel):
    """Request body for saving a completed game.

    `game_id` (optional) refers to a row inserted at `/game/start`. When
    present, `/game/save` UPDATEs that row in place instead of inserting
    a new one — so a single AI session shows up as exactly one row in
    `games` regardless of how many tabs / restarts the human did. When
    absent (legacy clients), we fall back to inserting a fresh row.
    """

    game_json: dict
    game_id: str | None = None


class GameSaveResponse(BaseModel):
    """Response body for saving a completed game.

    The legacy ``score`` / ``rating`` fields are preserved while the
    frontend transitions to the Elo display. ``elo_*`` fields are the
    canonical post-game numbers.
    """

    id: str
    score: int
    rating: float
    elo_before: int | None = None
    elo_after: int | None = None
    elo_delta: int | None = None


class GameHistoryEntry(BaseModel):
    """A single game entry in the user's game history.

    `opponent_username` is "AI" for AI games and the other participant's
    username for multiplayer games. `game_type` lets the frontend hide
    AI-specific columns (depth, score) for multiplayer rows.
    """

    id: str
    username: str
    won: bool
    score: int
    depth: int
    human_time_s: float
    ai_time_s: float
    played_at: datetime
    game_type: str  # 'ai' | 'multiplayer'
    opponent_username: str
    elo_before: int | None = None
    elo_after: int | None = None
    opponent_elo_before: int | None = None


class GameHistoryResponse(BaseModel):
    """Response body for the user's game history."""

    games: list[GameHistoryEntry]
