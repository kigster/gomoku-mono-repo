"""Add abandoned_by_user_id/abandoned_at + backfill chats

Revision ID: 0012
Revises: 0011
Create Date: 2026-05-12 22:00:00

Two changes that together make in-game chat work end-to-end without race
conditions and let the UI tell users *who* left when a game is abandoned:

1. `multiplayer_games.abandoned_by_user_id` + `abandoned_at` track who
   triggered an abandonment (today: a block-cascade in /social/block,
   tomorrow: a future timeout sweeper). The columns are NULL unless
   `state = 'abandoned'`, enforced by a CHECK. Resigns continue to write
   `state = 'finished'` with `winner = opposite-color` — that's a result,
   not an abandonment.

2. Backfill the `chats` table so every existing `multiplayer_games` row
   has a paired chats row. From now on the application code creates the
   chats row eagerly inside the `allocate_game` transaction (see
   app/multiplayer/allocate.py), so we never have to fight a race
   between the first message and the chat-row INSERT.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0012"
down_revision: str | Sequence[str] | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE multiplayer_games
            ADD COLUMN abandoned_by_user_id UUID
                REFERENCES users(id) ON DELETE SET NULL,
            ADD COLUMN abandoned_at TIMESTAMPTZ
        """
    )
    # Abandonment-fields consistency: both columns are NULL unless state
    # is 'abandoned'. We don't require them to be non-null when abandoned
    # (legacy rows transitioned before this migration must remain valid),
    # but new code paths populate them.
    op.execute(
        """
        ALTER TABLE multiplayer_games
        ADD CONSTRAINT abandoned_fields_consistency CHECK (
            state = 'abandoned'
            OR (abandoned_by_user_id IS NULL AND abandoned_at IS NULL)
        )
        """
    )

    # Backfill: ensure every multiplayer_games row has a paired chats row
    # so the application can assume the FK target exists from now on.
    # ON CONFLICT DO NOTHING covers the case where a partial backfill ran
    # in a prior failed migration attempt.
    op.execute(
        """
        INSERT INTO chats (multiplayer_game_id)
        SELECT mg.id
        FROM   multiplayer_games mg
        WHERE  NOT EXISTS (
                   SELECT 1 FROM chats c WHERE c.multiplayer_game_id = mg.id
               )
        """
    )


def downgrade() -> None:
    # We don't undo the chats backfill — those rows are harmless and the
    # app-layer change in allocate_game would keep creating them anyway.
    op.execute(
        "ALTER TABLE multiplayer_games DROP CONSTRAINT IF EXISTS abandoned_fields_consistency"
    )
    op.execute("ALTER TABLE multiplayer_games DROP COLUMN IF EXISTS abandoned_at")
    op.execute("ALTER TABLE multiplayer_games DROP COLUMN IF EXISTS abandoned_by_user_id")
