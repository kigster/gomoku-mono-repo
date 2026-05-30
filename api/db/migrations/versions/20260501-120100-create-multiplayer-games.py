"""Create multiplayer_games table for human-vs-human play

Revision ID: 0006
Revises: 0005
Create Date: 2026-05-01 12:01:00

Adds:

- The `multiplayer_games` table itself, with `expires_at` (15 minute TTL
  on `waiting`), `color_chosen_by` ('host' / 'guest'), nullable
  `host_color`, and a `cancelled` state value alongside the existing
  states. See `.features/009.choose-game-type-modal-and-invite-link.done/plan.md` §2.
- A `game_type` discriminator column on the existing `games` table
  ('ai' default, 'multiplayer' for finished human-vs-human rows). The
  original CHECK constraints on `depth`, `radius`, `total_moves` are
  preserved and made conditional on `game_type = 'ai'` — multiplayer
  rows write `0/0/0` sentinels without violating AI-game invariants.
  See `.features/008.multiplayer-pr-hardening-checklist.done/plan.md` item #1.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0006"
down_revision: str | Sequence[str] | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ---- multiplayer_games table ------------------------------------------
    op.execute("""
        CREATE TABLE multiplayer_games (
            id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
            code            VARCHAR(8)  NOT NULL UNIQUE,
            host_user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            guest_user_id   UUID        REFERENCES users(id) ON DELETE SET NULL,
            host_color      CHAR(1)     CHECK (host_color IS NULL OR host_color IN ('X','O')),
            color_chosen_by VARCHAR(8)  NOT NULL DEFAULT 'host'
                            CHECK (color_chosen_by IN ('host','guest')),
            board_size      INTEGER     NOT NULL DEFAULT 15 CHECK (board_size IN (15, 19)),
            rule_set        VARCHAR(16) NOT NULL DEFAULT 'freestyle',
            state           VARCHAR(16) NOT NULL DEFAULT 'waiting'
                            CHECK (state IN ('waiting','in_progress','finished',
                                             'abandoned','cancelled')),
            winner          CHAR(1)     CHECK (winner IS NULL OR winner IN ('X','O','draw')),
            moves           JSONB       NOT NULL DEFAULT '[]'::JSONB,
            next_to_move    CHAR(1)     NOT NULL DEFAULT 'X',
            version         INTEGER     NOT NULL DEFAULT 0,
            expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes'),
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            finished_at     TIMESTAMPTZ,
            CONSTRAINT host_color_consistency CHECK (
                (color_chosen_by = 'host'  AND host_color IS NOT NULL) OR
                (color_chosen_by = 'guest')
            )
        )
    """)
    op.execute("CREATE INDEX multiplayer_games_code_idx     ON multiplayer_games (code)")
    op.execute(
        "CREATE INDEX multiplayer_games_host_idx     "
        "ON multiplayer_games (host_user_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX multiplayer_games_guest_idx    "
        "ON multiplayer_games (guest_user_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX multiplayer_games_active_idx   "
        "ON multiplayer_games (state) WHERE state IN ('waiting','in_progress')"
    )
    op.execute("CREATE INDEX multiplayer_games_updated_idx  ON multiplayer_games (updated_at DESC)")
    op.execute(
        "CREATE INDEX multiplayer_games_expiry_idx   "
        "ON multiplayer_games (expires_at) WHERE state = 'waiting'"
    )

    # ---- games.game_type discriminator -------------------------------------
    # Existing rows are all AI games — backfilled to 'ai' via DEFAULT.
    op.execute("""
        ALTER TABLE games
            ADD COLUMN game_type VARCHAR(16) NOT NULL DEFAULT 'ai'
                       CHECK (game_type IN ('ai','multiplayer'))
    """)

    # The original 0003 CHECK constraints (depth>=1, radius>=1, total_moves>0)
    # exist for AI-game integrity. Replace them with conditional versions so
    # multiplayer rows can carry 0/0/0 sentinels without weakening AI guards.
    op.execute("ALTER TABLE games DROP CONSTRAINT IF EXISTS games_depth_check")
    op.execute("ALTER TABLE games DROP CONSTRAINT IF EXISTS games_radius_check")
    op.execute("ALTER TABLE games DROP CONSTRAINT IF EXISTS games_total_moves_check")
    op.execute(
        "ALTER TABLE games ADD CONSTRAINT games_depth_check "
        "CHECK (game_type <> 'ai' OR (depth BETWEEN 1 AND 10))"
    )
    op.execute(
        "ALTER TABLE games ADD CONSTRAINT games_radius_check "
        "CHECK (game_type <> 'ai' OR (radius BETWEEN 1 AND 5))"
    )
    op.execute(
        "ALTER TABLE games ADD CONSTRAINT games_total_moves_check "
        "CHECK (game_type <> 'ai' OR (total_moves > 0))"
    )
    # Multiplayer rows still need bounded numerics — separate, independent check.
    op.execute(
        "ALTER TABLE games ADD CONSTRAINT games_multiplayer_zero_sentinels "
        "CHECK (game_type <> 'multiplayer' OR (depth = 0 AND radius = 0 AND total_moves >= 0))"
    )


def downgrade() -> None:
    # Restore original AI-only constraints, drop game_type column.
    op.execute("ALTER TABLE games DROP CONSTRAINT IF EXISTS games_multiplayer_zero_sentinels")
    op.execute("ALTER TABLE games DROP CONSTRAINT IF EXISTS games_total_moves_check")
    op.execute("ALTER TABLE games DROP CONSTRAINT IF EXISTS games_radius_check")
    op.execute("ALTER TABLE games DROP CONSTRAINT IF EXISTS games_depth_check")
    op.execute("DELETE FROM games WHERE game_type = 'multiplayer'")
    op.execute("ALTER TABLE games DROP COLUMN IF EXISTS game_type")
    op.execute("ALTER TABLE games ADD CONSTRAINT games_depth_check CHECK (depth BETWEEN 1 AND 10)")
    op.execute("ALTER TABLE games ADD CONSTRAINT games_radius_check CHECK (radius BETWEEN 1 AND 5)")
    op.execute("ALTER TABLE games ADD CONSTRAINT games_total_moves_check CHECK (total_moves > 0)")

    op.execute("DROP INDEX IF EXISTS multiplayer_games_expiry_idx")
    op.execute("DROP INDEX IF EXISTS multiplayer_games_updated_idx")
    op.execute("DROP INDEX IF EXISTS multiplayer_games_active_idx")
    op.execute("DROP INDEX IF EXISTS multiplayer_games_guest_idx")
    op.execute("DROP INDEX IF EXISTS multiplayer_games_host_idx")
    op.execute("DROP INDEX IF EXISTS multiplayer_games_code_idx")
    op.execute("DROP TABLE IF EXISTS multiplayer_games")
