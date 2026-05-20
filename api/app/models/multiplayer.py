"""Pydantic request/response schemas for the multiplayer router.

These are not SQLAlchemy models (the codebase is asyncpg-only) — purely
wire shapes. `MultiplayerGameView` is the full participant view;
`MultiplayerGamePreview` is the slim view returned to non-participants.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

State = Literal["waiting", "in_progress", "finished", "abandoned", "cancelled"]

# --- Request bodies ---------------------------------------------------------


class NewMultiplayerGameRequest(BaseModel):
    """Body of POST /multiplayer/new.

    `host_color = None` means the host wants the *guest* to choose the color
    when they join. Otherwise the host has decided up front.
    """

    board_size: Literal[15, 19] = 15
    host_color: Literal["X", "O"] | None = "X"


class JoinRequest(BaseModel):
    """Body of POST /multiplayer/{code}/join.

    `chosen_color` is required when the game was created with
    `color_chosen_by='guest'` and forbidden otherwise.
    """

    chosen_color: Literal["X", "O"] | None = None


class MoveRequest(BaseModel):
    """Body of POST /multiplayer/{code}/move.

    Pydantic only enforces non-negative ints — the *upper* bound is
    `board_size - 1` and is checked in the handler so we never disagree
    with the actual board dimensions and we always emit a single,
    consistent 400 `out_of_bounds` for OOB cases (see
    `doc/multiplayer-bugs.md` item #7).
    """

    x: int = Field(ge=0)
    y: int = Field(ge=0)
    expected_version: int = Field(ge=0)


class ResignRequest(BaseModel):
    pass


class CancelRequest(BaseModel):
    """Body of POST /multiplayer/{code}/cancel — empty placeholder."""


# --- Response shapes --------------------------------------------------------


class PlayerInfo(BaseModel):
    """Public-facing identity for a participant."""

    username: str
    color: Literal["X", "O"] | None  # None while host hasn't picked yet


class MultiplayerGameView(BaseModel):
    """Full view returned to participants (host or guest)."""

    code: str
    state: State
    board_size: int
    rule_set: str
    host: PlayerInfo
    guest: PlayerInfo | None
    moves: list[tuple[int, int]]
    next_to_move: Literal["X", "O"]
    winner: Literal["X", "O", "draw"] | None
    your_color: Literal["X", "O"] | None
    your_turn: bool
    version: int
    color_chosen_by: Literal["host", "guest"]
    expires_at: datetime
    created_at: datetime
    finished_at: datetime | None
    invite_url: str


class MultiplayerGamePreview(BaseModel):
    """Slim preview for non-participants. NB: no `moves` key."""

    code: str
    state: State
    board_size: int
    rule_set: str
    host: PlayerInfo
    guest: PlayerInfo | None
    next_to_move: Literal["X", "O"]
    winner: Literal["X", "O", "draw"] | None
    your_color: None = None
    your_turn: bool = False
    version: int
    color_chosen_by: Literal["host", "guest"]
    expires_at: datetime
    created_at: datetime
    finished_at: datetime | None
