"""Chat router.

For now this router exposes a single endpoint, /chat/invite, which the
ChatPanel slash-command parser hits when the user types
`/invite @username`. The full chat-message persistence + polling layer
comes in a follow-up PR; we land /invite first because it's the only
slash command with cross-user side effects (the others are pure
social-graph writes handled in app/routers/social.py).

POST /chat/invite { target_username }
    → 200 {
            invited_code: str,        # 6-char Crockford code
            invite_url:   str,        # full https URL the invitee can open
            target_state: 'in_game' | 'idle' | 'offline',
            delivered:    bool,       # always false today; reserved for
                                       # the eventual push channel
          }
    → 404 user_not_found
    → 403 cannot_invite_blocker         # target has blocked the caller
    → 429 {error, retry_at}             # caller hit the rolling-window cap
    → 400 cannot_target_self

Spam containment: per-caller rolling-window rate limit on invites.
A caller may send at most `INVITE_HOURLY_CAP` invites in any 1-hour
window and `INVITE_DAILY_CAP` in any 24-hour window. Counts include
all `multiplayer_games` rows where `host_user_id = caller AND
created_via = 'invite'` regardless of state — joining or expiring an
invite does NOT free a quota slot. Modal-created games (`created_via
= 'modal'`) are not counted.

When the cap is hit, the endpoint returns HTTP 429 with a structured
detail `{"error": "Your have reached invite maximum for this period.",
"retry_at": <ISO timestamp>}`. `retry_at` is the earliest moment at
which the next invite will succeed — the later of (oldest-in-hour
+ 1h) and (oldest-in-day + 24h), whichever cap is currently violated.

The endpoint creates a fresh multiplayer game with the caller as host
(host picks Black/X by default — same as the modal's default) so the
invitee has a real game to join. The invite is single-use; if the
invitee never joins, the standard 15-minute lazy-expiry kicks in.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Literal

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.database import get_pool
from app.multiplayer import allocate_game, game_invite_url
from app.security import get_current_user

router = APIRouter(prefix="/chat", tags=["chat"])

TargetState = Literal["in_game", "idle", "offline"]

# Rolling-window invite limits, per caller. Both windows are checked
# on every invite attempt; the most-restrictive cap wins.
INVITE_HOURLY_CAP = 7
INVITE_DAILY_CAP = 15

# Chat-message length cap, enforced both here (Pydantic, for a clean 422)
# and by the column CHECK on `chat_messages.message`. Defined up here so
# the InviteRequest model below can use it for the optional attached
# message; the chat-messages models lower down share the same constant.
CHAT_MESSAGE_MAX_LEN = 500

# Polite line surfaced when the invitee taps Decline. The frontend never
# reads this string — it's stored verbatim as a chat_messages row from
# the invitee, so the inviter sees it in the chat log on their side.
DECLINE_MESSAGE = "Apologies, but I can't play or chat at the moment."

# Required verbatim by the spec — frontend pattern-matches on this
# string in the chat panel error caption. Do not reword without
# updating the spec.
RATE_LIMIT_ERROR = "Your have reached invite maximum for this period."


class InviteRequest(BaseModel):
    target_username: str = Field(min_length=2, max_length=30)
    # Optional one-line note the inviter wants the recipient to see in
    # the modal ("hey wanna play?" etc.). Stored as a chat_messages row
    # against the new game's chat so it survives accept (the chat shows
    # the note) and decline (the note remains in the cancelled game's
    # chat for the audit trail). Bounded by the same column CHECK as
    # other chat messages.
    message: str | None = Field(default=None, max_length=CHAT_MESSAGE_MAX_LEN)


class InviteResponse(BaseModel):
    invited_code: str
    invite_url: str
    target_state: TargetState
    delivered: bool


# Presence: a user is "offline" if their last authenticated request
# was longer ago than this. Matches the /social/who window so all
# presence-aware UI stays consistent.
TARGET_PRESENCE_WINDOW_SECONDS = 60


async def _target_state(conn: asyncpg.Connection, target_id: str) -> TargetState:
    """`in_game` if the target has an active multiplayer row, else
    `idle` if they were last seen within the presence window, else
    `offline`. Reads `users.last_seen_at` (kept fresh by the
    `get_current_user` dependency on every authed request)."""
    in_game = await conn.fetchrow(
        """
        SELECT 1 FROM multiplayer_games
        WHERE state IN ('waiting', 'in_progress')
          AND (host_user_id = $1::uuid OR guest_user_id = $1::uuid)
        LIMIT 1
        """,
        target_id,
    )
    if in_game is not None:
        return "in_game"
    is_present = await conn.fetchval(
        """
        SELECT last_seen_at > NOW() - ($2 || ' seconds')::interval
        FROM users WHERE id = $1::uuid
        """,
        target_id,
        str(TARGET_PRESENCE_WINDOW_SECONDS),
    )
    return "idle" if is_present else "offline"


async def _check_invite_rate_limit(conn: asyncpg.Connection, host_id: str) -> datetime | None:
    """Return None if the caller may send another invite.

    Otherwise return the earliest UTC timestamp at which the next
    invite will succeed. Both the hourly and daily caps are checked;
    the later (most-restrictive) retry time wins.

    Implementation: pull up to DAILY_CAP recent invite created_at
    timestamps, newest first. If we have DAILY_CAP rows, the oldest
    in that batch must roll out of the 24h window before the next
    invite can land — that gives the daily retry. Same logic against
    the subset within the last hour for the hourly retry.
    """
    rows = await conn.fetch(
        """
        SELECT created_at
        FROM multiplayer_games
        WHERE host_user_id = $1::uuid
          AND created_via = 'invite'
          AND created_at > NOW() - INTERVAL '24 hours'
        ORDER BY created_at DESC
        LIMIT $2
        """,
        host_id,
        INVITE_DAILY_CAP,
    )
    now = datetime.now(UTC)

    daily_retry: datetime | None = None
    if len(rows) >= INVITE_DAILY_CAP:
        # rows[-1] is the DAILY_CAPth most recent (oldest in our batch).
        # It must age past 24h for the count to drop to DAILY_CAP - 1.
        daily_retry = rows[-1]["created_at"] + timedelta(hours=24)

    one_hour_ago = now - timedelta(hours=1)
    in_hour = [r["created_at"] for r in rows if r["created_at"] > one_hour_ago]
    hourly_retry: datetime | None = None
    if len(in_hour) >= INVITE_HOURLY_CAP:
        hourly_retry = in_hour[-1] + timedelta(hours=1)

    candidates = [t for t in (daily_retry, hourly_retry) if t is not None]
    return max(candidates) if candidates else None


@router.post("/invite", response_model=InviteResponse)
async def invite(
    body: InviteRequest,
    user: dict = Depends(get_current_user),
    pool=Depends(get_pool),
) -> InviteResponse:
    caller_id = str(user["id"])
    async with pool.acquire() as conn:
        target = await conn.fetchrow(
            "SELECT id, username FROM users WHERE lower(username) = lower($1)",
            body.target_username,
        )
        if target is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "user_not_found")
        target_id = str(target["id"])
        if target_id == caller_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "cannot_target_self")

        # Refuse if the target has blocked the caller. This is a proper
        # 403 (not a silent no-op) so the inviter learns why their invite
        # didn't go through.
        blocked = await conn.fetchrow(
            """
            SELECT 1 FROM blocks
            WHERE blocker_id = $1::uuid AND blocked_id = $2::uuid
            """,
            target_id,
            caller_id,
        )
        if blocked is not None:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "cannot_invite_blocker")

        # Rolling-window rate limit. retry_at is the earliest moment
        # the next invite will land; the frontend formats it for the
        # user in the chat error caption.
        retry_at = await _check_invite_rate_limit(conn, caller_id)
        if retry_at is not None:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                {
                    "error": RATE_LIMIT_ERROR,
                    "retry_at": retry_at.isoformat(),
                },
            )

        target_state = await _target_state(conn, target_id)

        try:
            row = await allocate_game(
                conn,
                host_user_id=caller_id,
                created_via="invite",
                intended_guest_id=target_id,
            )
        except RuntimeError as exc:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
        code = row.code

        # If the inviter attached a note, persist it as the first
        # chat_messages row for this game's chat. Surfaced verbatim in
        # the recipient's invite modal and remains in the chat if she
        # accepts. allocate_game already created the paired chat row,
        # so the FK target is guaranteed to exist.
        if body.message is not None and body.message.strip():
            chat_id = await conn.fetchval(
                "SELECT id FROM chats WHERE multiplayer_game_id = $1::uuid",
                row.id,
            )
            await conn.execute(
                """
                INSERT INTO chat_messages (chat_id, speaker_id, message)
                VALUES ($1::uuid, $2::uuid, $3)
                """,
                str(chat_id),
                caller_id,
                body.message.strip(),
            )

    return InviteResponse(
        invited_code=code,
        invite_url=game_invite_url(code),
        target_state=target_state,
        # `delivered` is true when the invite is in a state where the
        # target's polling client will surface it: there's an
        # intended_guest_id and a non-offline target. Offline targets
        # still get the row (and may pick it up on next login) but
        # we don't claim live delivery.
        delivered=target_state != "offline",
    )


class IncomingInvite(BaseModel):
    """One pending invite addressed to the caller. `message` carries
    the optional note the inviter attached (the first chat_messages
    row authored by the host before any guest joined). Null when the
    inviter sent a bare invite."""

    code: str
    invite_url: str
    host_username: str
    board_size: int
    created_at: datetime
    expires_at: datetime
    message: str | None = None


class IncomingInvitesResponse(BaseModel):
    invites: list[IncomingInvite]


class DeclineResponse(BaseModel):
    declined: bool


class ChatMessage(BaseModel):
    """One persisted chat message."""

    id: str
    speaker_username: str
    speaker_is_me: bool
    message: str
    created_at: datetime


class PostChatMessageRequest(BaseModel):
    message: str = Field(min_length=1, max_length=CHAT_MESSAGE_MAX_LEN)


class ChatMessagesResponse(BaseModel):
    messages: list[ChatMessage]


@router.get("/incoming", response_model=IncomingInvitesResponse)
async def incoming(
    user: dict = Depends(get_current_user),
    pool=Depends(get_pool),
) -> IncomingInvitesResponse:
    """List pending invites addressed to the caller, newest first.

    Driven by the partial index
    `multiplayer_games_intended_guest_active_idx` so this is cheap to
    poll. Filters: state='waiting' (untaken), expires_at>NOW() (not
    stale), and intended_guest_id=caller. Stale rows are NOT lazily
    expired here — that's the per-code endpoints' job; we just hide
    them.
    """
    caller_id = str(user["id"])
    rows = await pool.fetch(
        """
        SELECT mg.code,
               mg.board_size,
               mg.created_at,
               mg.expires_at,
               u.username AS host_username,
               (
                   -- The first chat_messages row authored by the host
                   -- on this chat IS the attached invite note (the
                   -- inviter posts only that line before anyone joins).
                   SELECT cm.message
                   FROM   chat_messages cm
                   JOIN   chats c ON c.id = cm.chat_id
                   WHERE  c.multiplayer_game_id = mg.id
                     AND  cm.speaker_id = mg.host_user_id
                   ORDER BY cm.created_at ASC
                   LIMIT 1
               ) AS invite_message
        FROM multiplayer_games mg
        JOIN users u ON u.id = mg.host_user_id
        WHERE mg.intended_guest_id = $1::uuid
          AND mg.state = 'waiting'
          AND mg.expires_at > NOW()
        ORDER BY mg.created_at DESC
        LIMIT 50
        """,
        caller_id,
    )
    return IncomingInvitesResponse(
        invites=[
            IncomingInvite(
                code=r["code"],
                invite_url=game_invite_url(r["code"]),
                host_username=r["host_username"],
                board_size=r["board_size"],
                created_at=r["created_at"],
                expires_at=r["expires_at"],
                message=r["invite_message"],
            )
            for r in rows
        ]
    )


@router.post("/incoming/{code}/decline", response_model=DeclineResponse)
async def decline_invite(
    code: str,
    user: dict = Depends(get_current_user),
    pool=Depends(get_pool),
) -> DeclineResponse:
    """Decline a pending invite addressed to the caller.

    Sets `state='cancelled'` on the multiplayer_games row and posts a
    polite chat message from the caller (`DECLINE_MESSAGE`) into the
    paired chat, so the inviter can see the response when they revisit
    the game's chat log. Validates that the caller IS the intended
    guest — 403 otherwise to keep random users from cancelling
    invites they were never offered.

    404 — code not found
    403 — caller isn't the intended_guest_id
    409 — game isn't in `waiting` state any more (already joined,
          expired, or cancelled by someone else)
    """
    caller_id = str(user["id"])
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """
                SELECT mg.id, mg.intended_guest_id, mg.state,
                       c.id AS chat_id
                FROM   multiplayer_games mg
                JOIN   chats c ON c.multiplayer_game_id = mg.id
                WHERE  mg.code = $1
                FOR UPDATE OF mg
                """,
                code,
            )
            if row is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "invite_not_found")
            if row["intended_guest_id"] is None or str(row["intended_guest_id"]) != caller_id:
                raise HTTPException(status.HTTP_403_FORBIDDEN, "not_invited")
            if row["state"] != "waiting":
                raise HTTPException(status.HTTP_409_CONFLICT, "invite_not_pending")
            await conn.execute(
                """
                UPDATE multiplayer_games
                SET    state      = 'cancelled',
                       version    = version + 1,
                       updated_at = NOW()
                WHERE  id = $1::uuid
                """,
                str(row["id"]),
            )
            await conn.execute(
                """
                INSERT INTO chat_messages (chat_id, speaker_id, message)
                VALUES ($1::uuid, $2::uuid, $3)
                """,
                str(row["chat_id"]),
                caller_id,
                DECLINE_MESSAGE,
            )
    return DeclineResponse(declined=True)


# ---------------------------------------------------------------------------
# In-game chat messages
# ---------------------------------------------------------------------------
#
# Per the design discussion, every multiplayer_games row has a paired
# `chats` row from birth (created eagerly inside allocate_game; see
# app/multiplayer/allocate.py). That removes the only race the message
# endpoints would otherwise have to deal with: "first message arrives
# before the chat row exists." We can take the FK target for granted.
#
# Slash commands (`/invite`, `/follow`, ...) are stored verbatim as
# regular messages here — the client posts the literal text first and
# then dispatches the slash side-effect on its own. "Store first,
# post-process later" — even if the side-effect call fails or the
# tab closes between calls, the user's intent stays in the chat log.


async def _participant_chat(
    conn: asyncpg.Connection, code: str, user_id: str
) -> dict:
    """Resolve the chat for `code` and verify that `user_id` is a
    participant of the underlying multiplayer game.

    Returns a dict with `chat_id` and `multiplayer_game_id`. Raises
    HTTPException with the same shapes the rest of the multiplayer
    routes use (404 / 403) so the frontend can reuse its translation
    table.
    """
    row = await conn.fetchrow(
        """
        SELECT c.id AS chat_id, mg.id AS multiplayer_game_id,
               mg.host_user_id, mg.guest_user_id
        FROM   multiplayer_games mg
        JOIN   chats c ON c.multiplayer_game_id = mg.id
        WHERE  mg.code = $1
        """,
        code,
    )
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "multiplayer_game_not_found")
    is_host = str(row["host_user_id"]) == user_id
    is_guest = row["guest_user_id"] is not None and str(row["guest_user_id"]) == user_id
    if not (is_host or is_guest):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "not_a_participant")
    return {
        "chat_id": str(row["chat_id"]),
        "multiplayer_game_id": str(row["multiplayer_game_id"]),
    }


@router.post("/{code}/messages", response_model=ChatMessage)
async def post_chat_message(
    code: str,
    body: PostChatMessageRequest,
    user: dict = Depends(get_current_user),
    pool=Depends(get_pool),
) -> ChatMessage:
    """Persist a chat message for an in-progress multiplayer game.

    "Store first, post-process later" — the message is written to
    `chat_messages` verbatim, including any leading slash command. The
    client dispatches slash side-effects after this POST returns so the
    log captures intent even if the side-effect fails afterwards.
    """
    caller_id = str(user["id"])
    async with pool.acquire() as conn:
        ctx = await _participant_chat(conn, code, caller_id)
        row = await conn.fetchrow(
            """
            INSERT INTO chat_messages (chat_id, speaker_id, message)
            VALUES ($1::uuid, $2::uuid, $3)
            RETURNING id, message, created_at
            """,
            ctx["chat_id"],
            caller_id,
            body.message,
        )
        # Echo the speaker's username back so the client can render the
        # bubble without a follow-up lookup. We already know the speaker
        # is the caller (we just inserted), so no extra JOIN.
        return ChatMessage(
            id=str(row["id"]),
            speaker_username=user["username"],
            speaker_is_me=True,
            message=row["message"],
            created_at=row["created_at"],
        )


@router.get("/{code}/messages", response_model=ChatMessagesResponse)
async def list_chat_messages(
    code: str,
    since: int = 0,
    user: dict = Depends(get_current_user),
    pool=Depends(get_pool),
) -> ChatMessagesResponse:
    """Return chat messages for an in-progress multiplayer game.

    `since` is the number of messages the client has already seen; we
    return messages with offset >= since, ordered (created_at ASC,
    id ASC). The frontend polls at the same wall-clock cadence as the
    board state so the conversation stays in sync.
    """
    caller_id = str(user["id"])
    async with pool.acquire() as conn:
        ctx = await _participant_chat(conn, code, caller_id)
        rows = await conn.fetch(
            """
            SELECT cm.id,
                   cm.message,
                   cm.created_at,
                   cm.speaker_id,
                   u.username AS speaker_username
            FROM   chat_messages cm
            JOIN   users u ON u.id = cm.speaker_id
            WHERE  cm.chat_id = $1::uuid
            ORDER BY cm.created_at ASC, cm.id ASC
            OFFSET $2
            """,
            ctx["chat_id"],
            since,
        )
    return ChatMessagesResponse(
        messages=[
            ChatMessage(
                id=str(r["id"]),
                speaker_username=r["speaker_username"],
                speaker_is_me=str(r["speaker_id"]) == caller_id,
                message=r["message"],
                created_at=r["created_at"],
            )
            for r in rows
        ]
    )
