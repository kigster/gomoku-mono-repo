"""Helpers for the human-vs-human multiplayer feature.

See `.features/003.multiplayer-architecture-and-data-model.done/plan.md`
for the design. Keep this package side-effect free so importing it doesn't
require a DB pool.
"""

from app.multiplayer.allocate import MAX_RETRIES, allocate_game
from app.multiplayer.codes import ALPHABET, new_code
from app.multiplayer.urls import game_invite_url
from app.multiplayer.win_detector import has_winner

__all__ = [
    "ALPHABET",
    "MAX_RETRIES",
    "allocate_game",
    "game_invite_url",
    "has_winner",
    "new_code",
]
