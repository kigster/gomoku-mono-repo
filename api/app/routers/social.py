"""Social-graph router: /social/follow, /social/unfollow, /social/block.

Implements the unidirectional follow + block model surfaced by the chat
panel's slash commands. See frontend/src/components/ChatPanel.tsx for
the contract this router has to satisfy:

- POST /social/follow { target_username }
    → 200 { reciprocal: bool }   # true iff target also follows caller
    → 404 user_not_found

- POST /social/unfollow { target_username }
    → 200 { unfollowed: true }   # idempotent — true even when nothing
                                  # was followed in the first place
    → 404 user_not_found

- POST /social/block { target_username }
    → 200 { game_terminated: bool }   # true iff there was an active
                                       # multiplayer game between the
                                       # two — block always terminates.
    → 404 user_not_found

Game termination on social actions is **block-only**. An unfollow
deliberately does NOT cascade into game termination, even when it
severs the last social link between two players: a game's liveness
shouldn't depend on social-graph state that neither participant can
see in the game UI. Only an explicit /block (or in-game resign /
timeout) ends a game.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, computed_field

from app.database import get_pool
from app.security import get_current_user

router = APIRouter(prefix="/social", tags=["social"])

# /social/who's "currently connected" window. Matches the chat-panel
# polling cadence (300 ms while active) — anyone last-seen within the
# minute is treated as present. Wider windows would surface ghost
# users; narrower would miss real ones across a single network blip.
WHO_PRESENCE_WINDOW_SECONDS = 60

# /social/online's window for the chat-panel /who command. 15 minutes
# is wide enough that someone who tabbed away mid-conversation still
# shows up, but tight enough that yesterday's logins don't pollute
# the "currently online" list.
ONLINE_PRESENCE_WINDOW_MINUTES = 15


class TargetUsernameRequest(BaseModel):
    """Body shape shared by all three endpoints."""

    target_username: str = Field(min_length=2, max_length=30)


class FollowResponse(BaseModel):
    reciprocal: bool


class UnfollowResponse(BaseModel):
    """Idempotent — `unfollowed: true` whether or not a row was deleted.

    Deliberately does NOT include a `game_terminated` field. Unfollow
    is a pure social-graph operation; only /block (or in-game
    resign / timeout) ends games.
    """

    unfollowed: bool


class BlockResponse(BaseModel):
    game_terminated: bool


class WhoEntry(BaseModel):
    """One row in /social/who. `is_friend` = mutual follow."""

    username: str
    last_seen_at: datetime
    is_friend: bool


class WhoResponse(BaseModel):
    users: list[WhoEntry]


class OnlineUserEntry(BaseModel):
    """One row in /social/online. `state` is derived in the `online_users`
    view (see migration 0014). `active_game_id` is the FK target relevant
    to the current state — multiplayer_games.id for human-battle, games.id
    for ai-battle, NULL otherwise. `opponent_username` is populated only
    when `state == 'human-battle'` — the other participant in the active
    multiplayer game. It is retained on the wire for API stability but is
    not currently rendered by any consumer (the Who's Online modal shows
    only a playing indicator, not the opponent's name).

    The remaining fields power the Who's Online modal:

    - `elo_rating` / `session_started_at` — the "Elo Score" / "Since"
      columns. `session_started_at` is the start of this user's current
      online session (NOT NULL since migration 0016).
    - relationship flags, computed **relative to the caller**:
        - `is_follower`  — this user follows the caller,
        - `is_following` — the caller follows this user,
        - `is_friend`    — mutual follow; derived from the two directional
          flags so `is_friend == is_follower ∧ is_following` holds by
          construction (see the computed property below),
        - `is_blocked`   — the caller has blocked this user.
    - `is_champion` — this user is the single top-ranked player. The
      tie-break ordering matches /leaderboard
      (`elo_rating DESC, elo_games_count DESC, created_at ASC`), but
      eligibility is looser: any user with a rated game
      (`elo_games_count > 0`), not just those with a winning AI game. So
      the crowned user may not be the visible /leaderboard #1."""

    user_id: str
    username: str
    state: Literal["human-battle", "ai-battle", "chatting", "idle"]
    active_game_id: str | None
    opponent_username: str | None = None
    last_seen_at: datetime
    elo_rating: int
    session_started_at: datetime
    is_follower: bool = False
    is_following: bool = False
    is_blocked: bool = False
    is_champion: bool = False

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_friend(self) -> bool:
        """Mutual follow ⇒ friends. Derived, not stored, so the
        `is_friend == is_follower ∧ is_following` invariant cannot drift."""
        return self.is_follower and self.is_following


class OnlineUsersResponse(BaseModel):
    """`caller_elo` is the requesting user's own Elo, echoed once at the
    top level so the modal can compute the "similar level" (±250 Elo)
    filter client-side without a second lookup."""

    users: list[OnlineUserEntry]
    total: int
    caller_elo: int = 1500


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _resolve_target(conn: asyncpg.Connection, username: str, *, caller_id: str) -> dict:
    """Look up the target user, 404 if missing or self-targeted."""
    row = await conn.fetchrow(
        "SELECT id, username FROM users WHERE lower(username) = lower($1)",
        username,
    )
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user_not_found")
    if str(row["id"]) == caller_id:
        # The CHECK on friendships / blocks would catch self-targeting too,
        # but a clear 400 beats a 500 from a constraint violation.
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "cannot_target_self")
    return dict(row)


async def _terminate_active_game_between(
    conn: asyncpg.Connection, blocker_id: str, blockee_id: str
) -> bool:
    """If there's a `waiting` or `in_progress` multiplayer game between
    `blocker_id` and `blockee_id`, mark it terminated and return True.
    Otherwise return False.

    Waiting → cancelled (the game never started, no result to record).
    In-progress → abandoned (preserves the partial moves but ends the
    game). For the in_progress branch we also stamp
    `abandoned_by_user_id` = blocker and `abandoned_at` = now() so the
    UI can tell who left without leaking the fact that a block occurred
    (the blocker is implicit context that the receiving frontend doesn't
    surface — it just shows "your opponent has left").
    """
    row = await conn.fetchrow(
        """
        UPDATE multiplayer_games
        SET    state      = CASE state
                              WHEN 'waiting' THEN 'cancelled'
                              ELSE 'abandoned'
                            END,
               version    = version + 1,
               updated_at = NOW(),
               finished_at = NOW(),
               abandoned_by_user_id = CASE state
                              WHEN 'in_progress' THEN $1::uuid
                              ELSE NULL
                            END,
               abandoned_at = CASE state
                              WHEN 'in_progress' THEN NOW()
                              ELSE NULL
                            END
        WHERE  state IN ('waiting', 'in_progress')
          AND  (
                  (host_user_id = $1::uuid AND guest_user_id = $2::uuid)
               OR (host_user_id = $2::uuid AND guest_user_id = $1::uuid)
              )
        RETURNING id
        """,
        blocker_id,
        blockee_id,
    )
    return row is not None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/follow", response_model=FollowResponse)
async def follow(
    body: TargetUsernameRequest,
    user: dict = Depends(get_current_user),
    pool=Depends(get_pool),
) -> FollowResponse:
    caller_id = str(user["id"])
    async with pool.acquire() as conn:
        target = await _resolve_target(conn, body.target_username, caller_id=caller_id)
        target_id = str(target["id"])
        # Idempotent insert — re-following an existing follow is a no-op.
        await conn.execute(
            """
            INSERT INTO friendships (user_id, friend_id)
            VALUES ($1::uuid, $2::uuid)
            ON CONFLICT (user_id, friend_id) DO NOTHING
            """,
            caller_id,
            target_id,
        )
        # Reciprocity check: is there a row in the OTHER direction?
        reciprocal_row = await conn.fetchrow(
            """
            SELECT 1 FROM friendships
            WHERE user_id = $1::uuid AND friend_id = $2::uuid
            """,
            target_id,
            caller_id,
        )
    return FollowResponse(reciprocal=reciprocal_row is not None)


@router.post("/unfollow", response_model=UnfollowResponse)
async def unfollow(
    body: TargetUsernameRequest,
    user: dict = Depends(get_current_user),
    pool=Depends(get_pool),
) -> UnfollowResponse:
    caller_id = str(user["id"])
    async with pool.acquire() as conn:
        target = await _resolve_target(conn, body.target_username, caller_id=caller_id)
        target_id = str(target["id"])
        # Idempotent — DELETE returns affected rows but we don't care;
        # the result is the same whether anything was actually followed.
        await conn.execute(
            """
            DELETE FROM friendships
            WHERE user_id = $1::uuid AND friend_id = $2::uuid
            """,
            caller_id,
            target_id,
        )
        # Game termination is intentionally NOT triggered here —
        # see the module docstring. Only /social/block (or explicit
        # in-game resign / timeout) ends a game.
    return UnfollowResponse(unfollowed=True)


@router.post("/block", response_model=BlockResponse)
async def block(
    body: TargetUsernameRequest,
    user: dict = Depends(get_current_user),
    pool=Depends(get_pool),
) -> BlockResponse:
    caller_id = str(user["id"])
    async with pool.acquire() as conn:
        target = await _resolve_target(conn, body.target_username, caller_id=caller_id)
        target_id = str(target["id"])
        async with conn.transaction():
            # Idempotent insert.
            await conn.execute(
                """
                INSERT INTO blocks (blocker_id, blocked_id)
                VALUES ($1::uuid, $2::uuid)
                ON CONFLICT (blocker_id, blocked_id) DO NOTHING
                """,
                caller_id,
                target_id,
            )
            # A block also wipes any follow in either direction so the
            # blocked user can't piggy-back on a stale follow to keep
            # invite-spamming.
            await conn.execute(
                """
                DELETE FROM friendships
                WHERE (user_id = $1::uuid AND friend_id = $2::uuid)
                   OR (user_id = $2::uuid AND friend_id = $1::uuid)
                """,
                caller_id,
                target_id,
            )
            # Always terminate any active game between the two.
            game_terminated = await _terminate_active_game_between(conn, caller_id, target_id)
    return BlockResponse(game_terminated=game_terminated)


@router.get("/who", response_model=WhoResponse)
async def who(
    window_seconds: int = Query(default=WHO_PRESENCE_WINDOW_SECONDS, ge=10, le=600),
    user: dict = Depends(get_current_user),
    pool=Depends(get_pool),
) -> WhoResponse:
    """List users active within the presence window, newest activity first.

    `is_friend` is true iff the relationship is **mutual** — both rows
    of the friendships pair exist. Users who have blocked the caller
    or whom the caller has blocked are excluded entirely (no leak).

    The caller themselves is excluded; you can't /invite yourself, so
    surfacing yourself would just be noise.
    """
    caller_id = str(user["id"])
    rows = await pool.fetch(
        """
        SELECT
            u.username,
            u.last_seen_at,
            EXISTS (
                SELECT 1 FROM friendships f1
                WHERE f1.user_id = $1::uuid AND f1.friend_id = u.id
            )
            AND EXISTS (
                SELECT 1 FROM friendships f2
                WHERE f2.user_id = u.id AND f2.friend_id = $1::uuid
            ) AS is_friend
        FROM users u
        WHERE u.id <> $1::uuid
          AND u.last_seen_at > NOW() - ($2 || ' seconds')::interval
          AND NOT EXISTS (
              SELECT 1 FROM blocks b
              WHERE (b.blocker_id = $1::uuid AND b.blocked_id = u.id)
                 OR (b.blocker_id = u.id AND b.blocked_id = $1::uuid)
          )
        ORDER BY u.last_seen_at DESC
        LIMIT 200
        """,
        caller_id,
        str(window_seconds),
    )
    return WhoResponse(
        users=[
            WhoEntry(
                username=r["username"],
                last_seen_at=r["last_seen_at"],
                is_friend=r["is_friend"],
            )
            for r in rows
        ]
    )


@router.get("/online", response_model=OnlineUsersResponse)
async def online(
    limit: int = Query(default=10, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: dict = Depends(get_current_user),
    pool=Depends(get_pool),
) -> OnlineUsersResponse:
    """List users currently considered "online" (see migration 0014's
    `online_users` view docstring) with their state, active game id,
    Elo, session start, and relationship flags relative to the caller,
    paginated. The Who's Online modal requests one big page
    (`limit=200`) and filters client-side; the legacy chat `/who` used
    small pages — both share this endpoint.

    Tightens the view's 8h presence window down to
    `ONLINE_PRESENCE_WINDOW_MINUTES` for the UX — yesterday's logins
    shouldn't pollute the "currently online" list even though the view
    itself keeps them so other consumers can decide their own cutoff.

    Excludes nobody server-side — including the caller — so the row set
    stays stable for every consumer; the modal drops the caller's own
    row client-side. The page is sorted by `last_seen_at DESC` (most-
    recently-active first) by the view itself.

    For rows in `human-battle`, joins `multiplayer_games` + `users` to
    resolve the other participant's username as `opponent_username`,
    so the client can render "playing @<opponent>" without a second
    round-trip per row.

    `is_champion` is computed against a single scalar — the id of the
    top-ranked user (highest Elo among players with a rated game). The
    tie-break ordering matches /leaderboard, but eligibility is looser
    (`elo_games_count > 0` vs the leaderboard's winning-AI-game filter),
    so the crowned user may not be the visible leaderboard #1. At most
    one row in any page can carry the crown.
    """
    caller_id = str(user["id"])
    rows = await pool.fetch(
        f"""
        WITH champion AS (
            SELECT id
            FROM   users
            WHERE  elo_games_count > 0
            ORDER BY elo_rating DESC, elo_games_count DESC, created_at ASC
            LIMIT 1
        )
        SELECT
            ou.user_id,
            ou.username,
            ou.state,
            ou.active_game_id,
            ou.last_seen_at,
            u.elo_rating,
            u.session_started_at,
            opp.username AS opponent_username,
            EXISTS (
                SELECT 1 FROM friendships f
                WHERE f.user_id = $3::uuid AND f.friend_id = ou.user_id
            ) AS caller_follows,
            EXISTS (
                SELECT 1 FROM friendships f
                WHERE f.user_id = ou.user_id AND f.friend_id = $3::uuid
            ) AS follows_caller,
            EXISTS (
                SELECT 1 FROM blocks b
                WHERE b.blocker_id = $3::uuid AND b.blocked_id = ou.user_id
            ) AS is_blocked,
            (ou.user_id = (SELECT id FROM champion)) AS is_champion
        FROM   online_users ou
        JOIN   users u ON u.id = ou.user_id
        LEFT JOIN LATERAL (
            SELECT u2.username
            FROM   multiplayer_games mg
            JOIN   users u2
              ON   u2.id = CASE
                            WHEN mg.host_user_id = ou.user_id
                                THEN mg.guest_user_id
                            ELSE mg.host_user_id
                          END
            WHERE  mg.id = ou.active_game_id
            LIMIT  1
        ) opp ON ou.state = 'human-battle'
        WHERE  ou.last_seen_at > NOW()
               - INTERVAL '{ONLINE_PRESENCE_WINDOW_MINUTES} minutes'
        LIMIT $1 OFFSET $2
        """,
        limit,
        offset,
        caller_id,
    )
    total = await pool.fetchval(
        f"""
        SELECT COUNT(*) FROM online_users
        WHERE last_seen_at > NOW()
              - INTERVAL '{ONLINE_PRESENCE_WINDOW_MINUTES} minutes'
        """
    )
    caller_elo = await pool.fetchval(
        "SELECT elo_rating FROM users WHERE id = $1::uuid",
        caller_id,
    )
    return OnlineUsersResponse(
        users=[
            OnlineUserEntry(
                user_id=str(r["user_id"]),
                username=r["username"],
                state=r["state"],
                active_game_id=str(r["active_game_id"]) if r["active_game_id"] else None,
                opponent_username=r["opponent_username"],
                last_seen_at=r["last_seen_at"],
                elo_rating=int(r["elo_rating"]),
                session_started_at=r["session_started_at"],
                # `is_friend` is derived from these two directional flags
                # by the model's computed property — not set here.
                is_follower=bool(r["follows_caller"]),
                is_following=bool(r["caller_follows"]),
                is_blocked=bool(r["is_blocked"]),
                is_champion=bool(r["is_champion"]),
            )
            for r in rows
        ],
        total=int(total or 0),
        caller_elo=int(caller_elo if caller_elo is not None else 1500),
    )
