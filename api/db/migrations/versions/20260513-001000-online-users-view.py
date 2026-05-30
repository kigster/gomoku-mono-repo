"""Create online_users view

Revision ID: 0014
Revises: 0013
Create Date: 2026-05-13 00:10:00

A computed view over `users.last_seen_at` (refreshed on every
authenticated request by `get_current_user`) classifying each user into
one of four states:

  - 'human-battle' : has a multiplayer_games row in waiting/in_progress
  - 'ai-battle'    : has a games row with status='in_progress' and
                     game_type='ai' (inserted at `/game/start`,
                     UPDATEd to 'completed' at `/game/save`, swept to
                     'abandoned' when the user starts another AI game)
  - 'chatting'     : posted a chat message in the last 30 s and is not
                     in either battle state (rare in practice; chat in
                     a game is captured by 'human-battle' already)
  - 'idle'         : has been seen within the window but isn't doing
                     anything else

Filter: `last_seen_at` within the last 8 hours (the same as the
frontend's MAX_AGE_IN_PROGRESS_MS — the wall-clock cap on the polling
loop). Users whose tabs are gone fall out of the view within a polling
interval or two; the long window only matters for very-long-running
in_progress games where the tab is still alive.

`active_game_id` is the multiplayer_games.id when in human-battle, the
games.id (AI in-progress row) when in ai-battle, NULL otherwise.

`state` priority order matters: a player who is chatting *during* an
in-progress multiplayer game is classified as 'human-battle' — the
game is the load-bearing affordance, the chat is incidental.

The view is a plain VIEW (not MATERIALIZED) because it must be live
to the millisecond — `/social/online` calls it on every poll. Cost is
trivial as long as we keep the per-user count small; the only
expensive piece is the LATERAL join over multiplayer_games, which is
served by the existing partial index `multiplayer_games_active_idx`.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0014"
down_revision: str | Sequence[str] | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 8 hours, matching frontend MAX_AGE_IN_PROGRESS_MS. Encoded as a
    # constant string we feed into the view body so it's easy to find
    # and grep — change here, redeploy, change is live.
    PRESENCE_WINDOW = "INTERVAL '8 hours'"
    # "Chatting" requires recent chat activity AND no concurrent game.
    # 30 s is wider than a chat message bursts but tight enough that
    # "chatting" doesn't outlast the conversation.
    CHATTING_WINDOW = "INTERVAL '30 seconds'"

    op.execute(
        f"""
        CREATE OR REPLACE VIEW online_users AS
        SELECT
            u.id                                      AS user_id,
            u.username                                AS username,
            CASE
                WHEN mp.id IS NOT NULL THEN 'human-battle'
                WHEN ai.id IS NOT NULL THEN 'ai-battle'
                WHEN cm.last_chat_at IS NOT NULL
                    AND cm.last_chat_at > NOW() - {CHATTING_WINDOW}
                    THEN 'chatting'
                ELSE 'idle'
            END                                       AS state,
            COALESCE(mp.id, ai.id)                    AS active_game_id,
            u.last_seen_at                            AS last_seen_at
        FROM users u
        LEFT JOIN LATERAL (
            -- Most recent active multiplayer game where u is a participant.
            -- Served by multiplayer_games_active_idx (partial on state).
            SELECT id
            FROM   multiplayer_games
            WHERE  state IN ('waiting', 'in_progress')
              AND  (host_user_id = u.id OR guest_user_id = u.id)
            ORDER BY created_at DESC
            LIMIT 1
        ) mp ON TRUE
        LEFT JOIN LATERAL (
            -- Currently-in-progress AI game inserted at /game/start.
            -- Served by games_in_progress_idx (partial on status).
            SELECT id
            FROM   games
            WHERE  user_id   = u.id
              AND  game_type = 'ai'
              AND  status    = 'in_progress'
            ORDER BY played_at DESC
            LIMIT 1
        ) ai ON TRUE
        LEFT JOIN LATERAL (
            -- Most recent chat message authored by u. Reads from
            -- chat_messages_chat_created_idx (DESC) so it's a single
            -- index seek; we then filter on speaker_id in-place.
            SELECT MAX(created_at) AS last_chat_at
            FROM   chat_messages
            WHERE  speaker_id = u.id
        ) cm ON TRUE
        WHERE u.last_seen_at > NOW() - {PRESENCE_WINDOW}
        ORDER BY u.last_seen_at DESC
        """
    )


def downgrade() -> None:
    op.execute("DROP VIEW IF EXISTS online_users")
