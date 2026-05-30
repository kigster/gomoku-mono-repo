"""Make online_users.state respect opponent presence

Revision ID: 0015
Revises: 0014
Create Date: 2026-05-26 18:00:00

Bug context
-----------

`/who` was reporting "@bob playing @kig" for multiplayer games whose
state was 'in_progress' but whose opponent had long since closed the
tab without resigning. The CLAUDE.md note says we use *lazy expiry* —
only `waiting` games get auto-cancelled on read, and only their own
read path. An `in_progress` game with an abandoned opponent stays
`in_progress` forever, so the previous `online_users` view classified
both participants as `'human-battle'` even when one of them had
disappeared hours ago.

Concretely: bob's row stayed `human-battle` with `opponent_username =
'kig'` long after kig was gone, because the view only checked the
existence of a game, not whether the *opponent* was still present.

Fix
---

The view's `mp` LATERAL now requires the OTHER participant to be
within the same `PRESENCE_WINDOW` (8 h) that the view already uses to
gate which users appear at all. If the opponent has not been seen
recently, the active multiplayer game is treated as stale for the
purposes of /who and the row falls through to the next state
('ai-battle' if applicable, then 'chatting', then 'idle').

The data itself is *not* touched — the multiplayer_games row stays
`in_progress` (we still don't sweep). This is purely a presentation
fix on the /who classifier. If both players come back, the game
resurfaces in /who automatically on the next view read.

`'waiting'` games are exempt from the opponent-presence check: those
rows have `guest_user_id IS NULL` until someone joins, and they are
already self-correcting via the existing 15-minute lazy expiry on
state='waiting'.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0015"
down_revision: str | Sequence[str] | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Kept identical to migration 0014 so the two values stay in sync.
PRESENCE_WINDOW = "INTERVAL '8 hours'"
CHATTING_WINDOW = "INTERVAL '30 seconds'"


def upgrade() -> None:
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
            -- Most recent active multiplayer game where u is a
            -- participant AND the opponent (if any) is still within
            -- the presence window. 'waiting' games have no opponent
            -- yet (guest_user_id IS NULL) and are exempt from the
            -- presence check; they self-correct via lazy expiry.
            SELECT mg.id
            FROM   multiplayer_games mg
            LEFT JOIN users opp
              ON   opp.id = CASE
                              WHEN mg.host_user_id = u.id
                                  THEN mg.guest_user_id
                              ELSE mg.host_user_id
                            END
            WHERE  mg.state IN ('waiting', 'in_progress')
              AND  (mg.host_user_id = u.id OR mg.guest_user_id = u.id)
              AND  (
                    mg.state = 'waiting'
                 OR opp.last_seen_at > NOW() - {PRESENCE_WINDOW}
              )
            ORDER BY mg.created_at DESC
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
    # Restore the pre-fix definition: no opponent-presence check on
    # the mp LATERAL.
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
            SELECT id
            FROM   multiplayer_games
            WHERE  state IN ('waiting', 'in_progress')
              AND  (host_user_id = u.id OR guest_user_id = u.id)
            ORDER BY created_at DESC
            LIMIT 1
        ) mp ON TRUE
        LEFT JOIN LATERAL (
            SELECT id
            FROM   games
            WHERE  user_id   = u.id
              AND  game_type = 'ai'
              AND  status    = 'in_progress'
            ORDER BY played_at DESC
            LIMIT 1
        ) ai ON TRUE
        LEFT JOIN LATERAL (
            SELECT MAX(created_at) AS last_chat_at
            FROM   chat_messages
            WHERE  speaker_id = u.id
        ) cm ON TRUE
        WHERE u.last_seen_at > NOW() - {PRESENCE_WINDOW}
        ORDER BY u.last_seen_at DESC
        """
    )
