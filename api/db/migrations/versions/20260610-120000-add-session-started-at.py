"""Add users.session_started_at (online-session start clock)

Revision ID: 0016
Revises: 0015
Create Date: 2026-06-10 12:00:00

`last_seen_at` is a heartbeat: the frontend's UserActivityTracker POSTs
`/users/me/seen` on a debounce, so for an active tab it sits at ~now()
and tells you nothing about *when the user came online*. The Who's
Online modal wants a "Since (LTZ)" column — the start of the user's
*current* continuous online session — which `last_seen_at` can't give.

`session_started_at` fills that gap. It is:

  - stamped to now() on login (auth.login) and at signup (DEFAULT),
  - re-stamped to now() by `/users/me/seen` whenever the previous
    `last_seen_at` is older than the online-presence window
    (ONLINE_PRESENCE_WINDOW_MINUTES = 15) — i.e. the user fell out of
    "online" and has now come back, which we treat as a fresh session,
  - otherwise left untouched, so a continuously-present user keeps the
    same session start for the whole visit.

15 minutes is deliberately the same window `/social/online` uses to
decide who is "online" at all: if you were gone long enough to drop off
the list, your next heartbeat starts a new session. Background-tab timer
throttling (which slows but doesn't stop the heartbeat) stays well
inside the window, so a backgrounded tab does not spuriously reset.

Backfilled to last_seen_at for existing rows — the best available
approximation of when each current user's session began.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0016"
down_revision: str | Sequence[str] | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE users
            ADD COLUMN session_started_at TIMESTAMPTZ NOT NULL DEFAULT now()
        """
    )
    # Best-effort backfill: existing online users' sessions are at least
    # as old as their last heartbeat. now() (the column default) would
    # claim everyone just connected, which is wrong for users who have
    # been around a while.
    op.execute("UPDATE users SET session_started_at = last_seen_at")


def downgrade() -> None:
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS session_started_at")
