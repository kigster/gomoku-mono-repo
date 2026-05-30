"""Pydantic row models for database tables."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import UUID

from pydantic import BaseModel


class MultiplayerGameState(StrEnum):
    """Multiplayer game state."""

    WAITING = "waiting"
    IN_PROGRESS = "in_progress"
    FINISHED = "finished"
    ABANDONED = "abandoned"
    CANCELLED = "cancelled"


class StoneColor(StrEnum):
    """Stone color."""

    X = "X"
    O_COLOR = "O"


class WinnerColor(StrEnum):
    """Winner color."""

    X = "X"
    O_COLOR = "O"
    DRAW = "draw"


class ColorChosenBy(StrEnum):
    """Color chosen by."""

    HOST = "host"
    GUEST = "guest"


class MultiplayerCreatedVia(StrEnum):
    """Multiplayer created via."""

    MODAL = "modal"
    INVITE = "invite"


class GameType(StrEnum):
    """Game type."""

    AI = "ai"
    MULTIPLAYER = "multiplayer"


class UserRow(BaseModel):
    """User record."""

    id: UUID
    username: str
    email: str | None = None
    password_hash: str
    games_started: int
    games_finished: int
    created_at: datetime
    updated_at: datetime
    first_name: str | None = None
    last_name: str | None = None
    last_logged_in_at: datetime | None = None
    logins_count: int = 0
    elo_rating: int = 1500
    elo_peak: int = 1500
    elo_games_count: int = 0
    last_seen_at: datetime


class UserEloSnapshot(BaseModel):
    """User elo snapshot."""

    elo_rating: int
    elo_peak: int
    elo_games_count: int


class PasswordResetTokenRow(BaseModel):
    """Password reset token record."""

    id: UUID
    user_id: UUID
    token: str
    expires_at: datetime
    used: bool = False
    created_at: datetime


class GameRow(BaseModel):
    """Game record."""

    id: UUID
    username: str
    user_id: UUID | None = None
    winner: WinnerColor
    human_player: StoneColor
    board_size: int
    depth: int
    radius: int
    total_moves: int
    human_time_s: float
    ai_time_s: float
    score: int
    game_json: Any
    client_ip: str | None = None
    geo_country: str | None = None
    geo_region: str | None = None
    geo_city: str | None = None
    geo_loc: Any | None = None
    played_at: datetime
    game_type: GameType = GameType.AI
    opponent_id: UUID | None = None
    elo_before: int | None = None
    elo_after: int | None = None
    opponent_elo_before: int | None = None


class MultiplayerGameRow(BaseModel):
    """Multiplayer game record."""

    id: UUID
    code: str
    host_user_id: UUID
    guest_user_id: UUID | None = None
    host_color: StoneColor | None = StoneColor.X
    color_chosen_by: ColorChosenBy = ColorChosenBy.HOST
    board_size: int = 15
    rule_set: str = "freestyle"
    state: MultiplayerGameState = MultiplayerGameState.WAITING
    winner: WinnerColor | None = None
    moves: Any
    next_to_move: StoneColor = StoneColor.X
    version: int = 0
    expires_at: datetime
    created_at: datetime
    updated_at: datetime
    finished_at: datetime | None = None
    created_via: MultiplayerCreatedVia = MultiplayerCreatedVia.MODAL
    intended_guest_id: UUID | None = None
    abandoned_by_user_id: UUID | None = None
    abandoned_at: datetime | None = None


class MultiplayerGameWithUsersRow(MultiplayerGameRow):
    """Multiplayer game record with usernames."""

    host_username: str
    guest_username: str | None = None


class ChatRow(BaseModel):
    """Chat record."""

    id: UUID
    multiplayer_game_id: UUID
    created_at: datetime


class ChatMessageRow(BaseModel):
    """Chat message record."""

    id: UUID
    chat_id: UUID
    speaker_id: UUID
    message: str
    created_at: datetime


class FriendshipRow(BaseModel):
    """Friendship record."""

    id: UUID
    user_id: UUID
    friend_id: UUID
    created_at: datetime


class BlockRow(BaseModel):
    """Block record."""

    blocker_id: UUID
    blocked_id: UUID
    created_at: datetime
