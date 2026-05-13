"""Add games.status + relax strict CHECKs to allow in_progress rows

Revision ID: 0013
Revises: 0012
Create Date: 2026-05-13 00:00:00

`/game/start` now inserts a real `games` row with `status = 'in_progress'`
so the frontend can carry a stable `game_id` through the AI session and
the `online_users` view (migration 0014) can derive an "ai-battle" state
without a separate tracking column.

Originally the table assumed every row was a finished AI game:
`winner`, `human_player` were NOT NULL, `total_moves > 0` was strictly
required, etc. We relax those guards conditionally — they still apply
to `status = 'completed'` rows so completed-game invariants don't
weaken — and add a status discriminator.

Existing rows are all completed AI games; the column default
('completed') backfills them safely.

Stale `in_progress` rows (user closed the tab mid-game) are not pruned
by this migration. A separate cleanup pass (cron / manual SQL) can
mark them `abandoned` later. The `online_users` view tolerates stale
rows because it gates on `users.last_seen_at` — a user whose tab is
gone falls out of the presence window quickly even if their games row
lingers.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0013"
down_revision: str | Sequence[str] | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # New status column. Backfilled to 'completed' for every existing row
    # via the column DEFAULT so historical games keep their meaning.
    op.execute(
        """
        ALTER TABLE games
            ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'
                CHECK (status IN ('in_progress', 'completed', 'abandoned'))
        """
    )

    # An in_progress row doesn't have a winner or a human side decided
    # yet (well, the side IS chosen at /game/start, but for safety and
    # symmetry with `winner` we relax both). Completed rows still must
    # populate them — enforced via the conditional CHECKs below.
    op.execute("ALTER TABLE games ALTER COLUMN winner DROP NOT NULL")
    op.execute("ALTER TABLE games ALTER COLUMN human_player DROP NOT NULL")

    # Drop the inline CHECKs that came with the original table (they
    # used Postgres-auto names like `games_winner_check` /
    # `games_human_player_check`). IF EXISTS so the migration is safe
    # whether or not PG happened to use those exact names.
    op.execute("ALTER TABLE games DROP CONSTRAINT IF EXISTS games_winner_check")
    op.execute("ALTER TABLE games DROP CONSTRAINT IF EXISTS games_human_player_check")
    op.execute("ALTER TABLE games DROP CONSTRAINT IF EXISTS games_total_moves_check")

    # Re-add them gated on status='completed' so in_progress rows are
    # exempt. AI-game invariants (depth, radius) already use a similar
    # `game_type <> 'ai' OR ...` pattern from migration 0006 — extend
    # the same idea here.
    op.execute(
        """
        ALTER TABLE games ADD CONSTRAINT games_winner_check
            CHECK (status <> 'completed' OR winner IN ('X', 'O', 'draw'))
        """
    )
    op.execute(
        """
        ALTER TABLE games ADD CONSTRAINT games_human_player_check
            CHECK (status <> 'completed' OR human_player IN ('X', 'O'))
        """
    )
    op.execute(
        """
        ALTER TABLE games ADD CONSTRAINT games_total_moves_check
            CHECK (
                game_type <> 'ai'
                OR status <> 'completed'
                OR total_moves > 0
            )
        """
    )

    # Index for the common in_progress lookup at /game/start:
    # "abandon any prior in_progress AI rows for this user before
    # inserting a fresh one". Partial — most rows are completed and we
    # never scan them.
    op.execute(
        "CREATE INDEX games_in_progress_idx "
        "ON games (user_id, played_at DESC) "
        "WHERE status = 'in_progress'"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS games_in_progress_idx")

    op.execute("ALTER TABLE games DROP CONSTRAINT IF EXISTS games_total_moves_check")
    op.execute("ALTER TABLE games DROP CONSTRAINT IF EXISTS games_human_player_check")
    op.execute("ALTER TABLE games DROP CONSTRAINT IF EXISTS games_winner_check")

    # Restore the strict shapes. Sweep stale rows first so the NOT NULL
    # / CHECK enforcement doesn't fail on partial data — anything still
    # in_progress was abandoned by virtue of the rollback.
    op.execute("DELETE FROM games WHERE status <> 'completed'")
    op.execute("ALTER TABLE games ALTER COLUMN winner SET NOT NULL")
    op.execute("ALTER TABLE games ALTER COLUMN human_player SET NOT NULL")
    op.execute(
        """
        ALTER TABLE games ADD CONSTRAINT games_winner_check
            CHECK (winner IN ('X', 'O', 'draw'))
        """
    )
    op.execute(
        """
        ALTER TABLE games ADD CONSTRAINT games_human_player_check
            CHECK (human_player IN ('X', 'O'))
        """
    )
    op.execute(
        """
        ALTER TABLE games ADD CONSTRAINT games_total_moves_check
            CHECK (game_type <> 'ai' OR total_moves > 0)
        """
    )

    op.execute("ALTER TABLE games DROP COLUMN IF EXISTS status")
