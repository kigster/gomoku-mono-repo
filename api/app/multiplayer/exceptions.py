"""Typed multiplayer route exceptions."""

from __future__ import annotations

from fastapi import status

from app.exceptions import HTTPResponseException


class MultiplayerGameNotFound(HTTPResponseException):
    """Game Not Found."""

    def __init__(self) -> None:
        super().__init__(status.HTTP_404_NOT_FOUND, "multiplayer_game_not_found")


class CannotJoinOwnGame(HTTPResponseException):
    """Cannot Join Own Game."""

    def __init__(self) -> None:
        super().__init__(status.HTTP_409_CONFLICT, "cannot_join_own_game")


class GameCancelled(HTTPResponseException):
    """Game Cancelled."""

    def __init__(self) -> None:
        super().__init__(status.HTTP_409_CONFLICT, "game_cancelled")


class GameAlreadyFull(HTTPResponseException):
    """Game Already Full."""

    def __init__(self) -> None:
        super().__init__(status.HTTP_409_CONFLICT, "game_already_full")


class GameNotInWaitingState(HTTPResponseException):
    """Game Not In Waiting State."""

    def __init__(self) -> None:
        super().__init__(status.HTTP_409_CONFLICT, "game_not_in_waiting_state")


class ChosenColorRequired(HTTPResponseException):
    """Chosen Color Required."""

    def __init__(self) -> None:
        super().__init__(status.HTTP_422_UNPROCESSABLE_CONTENT, "chosen_color_required")


class ChosenColorNotAllowed(HTTPResponseException):
    """Chosen Color Not Allowed."""

    def __init__(self) -> None:
        super().__init__(status.HTTP_422_UNPROCESSABLE_CONTENT, "chosen_color_not_allowed")


class NotTheHost(HTTPResponseException):
    """Not The Host."""

    def __init__(self) -> None:
        super().__init__(status.HTTP_403_FORBIDDEN, "not_the_host")


class CannotCancelInState(HTTPResponseException):
    """Cannot Cancel In State."""

    def __init__(self, state_value: str) -> None:
        super().__init__(status.HTTP_409_CONFLICT, f"cannot_cancel_in_state_{state_value}")


class NotAParticipant(HTTPResponseException):
    """Not A Participant."""

    def __init__(self) -> None:
        super().__init__(status.HTTP_403_FORBIDDEN, "not_a_participant")


class GameNotInProgress(HTTPResponseException):
    """Game Not In Progress."""

    def __init__(self) -> None:
        super().__init__(status.HTTP_409_CONFLICT, "game_not_in_progress")


class OutOfBounds(HTTPResponseException):
    """Out of Bounds."""

    def __init__(self) -> None:
        super().__init__(status.HTTP_400_BAD_REQUEST, "out_of_bounds")


class VersionConflict(HTTPResponseException):
    """Version Conflict."""

    def __init__(self) -> None:
        super().__init__(status.HTTP_409_CONFLICT, "version_conflict")


class NotYourTurn(HTTPResponseException):
    """Not Your Turn."""

    def __init__(self) -> None:
        super().__init__(status.HTTP_409_CONFLICT, "not_your_turn")


class SquareOccupied(HTTPResponseException):
    """Square Occupied."""

    def __init__(self) -> None:
        super().__init__(status.HTTP_409_CONFLICT, "square_occupied")


class FailedToAllocateCode(HTTPResponseException):
    """Failed To Allocate Code."""

    def __init__(self) -> None:
        super().__init__(status.HTTP_503_SERVICE_UNAVAILABLE, "failed_to_allocate_code")
