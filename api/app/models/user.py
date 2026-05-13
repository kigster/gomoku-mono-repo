"""Models for the user API."""

import re
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, EmailStr, field_validator

# A-Z a-z (including accented), 0-9, dash, caret
USERNAME_PATTERN = re.compile(r"^[\w\u00C0-\u024F0-9\-\^]{2,30}$")


class UserCreate(BaseModel):
    """User creation request body."""

    username: str
    password: str
    email: EmailStr | None = None
    first_name: str | None = None
    last_name: str | None = None

    @field_validator("username")
    @classmethod
    def validate_username(cls, v: str) -> str:
        """Validate the username."""
        if not USERNAME_PATTERN.match(v):
            raise ValueError(
                "Username must be 2-30 characters: letters (including accented), "
                "digits, dash, or caret"
            )
        return v

    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        if len(v) < 7:
            raise ValueError("Password must be at least 7 characters")
        return v


class UserLogin(BaseModel):
    """User login request body."""

    username: str
    password: str


class TokenResponse(BaseModel):
    """Token response body."""

    access_token: str
    token_type: str = "bearer"
    username: str


class PresenceSeenRequest(BaseModel):
    """Client-supplied presence update.

    The client tracks user-input activity locally with a 15-second
    debounce and posts the most recent timestamp on a 60-second
    schedule (see frontend's UserActivityTracker). The server only
    updates `users.last_seen_at` if the incoming timestamp is newer
    than the stored value, so duplicate/out-of-order POSTs are safe.
    """

    last_seen_at: datetime


class PresenceSeenResponse(BaseModel):
    """The post-update value of `users.last_seen_at` — always the freshest
    of (client-submitted, previously-stored). Lets the client reconcile
    its local `activity_synced_at` without a second round-trip."""

    last_seen_at: datetime


class PasswordResetRequest(BaseModel):
    """Password reset request body."""

    email: EmailStr


class PasswordResetConfirm(BaseModel):
    """Password reset confirmation request body."""

    token: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        """Validate the password."""
        if len(v) < 7:
            raise ValueError("Password must be at least 7 characters")
        return v


class PersonalBest(BaseModel):
    """Personal best response body."""

    score: int
    rating: float
    depth: int
    radius: int
    played_at: datetime


class UserOut(BaseModel):
    """User response body."""

    id: UUID
    username: str
    email: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    created_at: datetime
    last_logged_in_at: datetime | None = None
    logins_count: int = 0
    games_won: int = 0
    games_lost: int = 0
    personal_best: PersonalBest | None = None
    elo_rating: int = 1500
    elo_peak: int = 1500
    elo_games_count: int = 0
