"""Seed the database with two dev users so local play has somebody to test
against without going through the signup flow.

Idempotent — uses INSERT … ON CONFLICT DO NOTHING keyed on the unique
`username`. Re-running the script never wipes data or rotates passwords;
delete the user manually if you want to reset the password.

Usage::

    cd api && uv run python -m scripts.seed_dev_users

Reads `DATABASE_URL` (or whatever the app config resolves to) — point it
at your dev DB; pointing it at production is a deliberate act and will
upsert the same two users there too.
"""

from __future__ import annotations

import asyncio

import asyncpg

from app.config import settings
from app.security import hash_password

# (username, password, email) — passwords are intentionally weak; these
# are dev-only accounts that should never exist on a real deployment.
DEV_USERS: list[tuple[str, str, str]] = [
    ("bob", "bobobob", "bob@dev.gomoku.games"),
    ("kate", "katekate", "kate@dev.gomoku.games"),
]


async def main() -> None:
    conn = await asyncpg.connect(settings.database_dsn)
    try:
        for username, password, email in DEV_USERS:
            pw_hash = hash_password(password)
            row = await conn.fetchrow(
                """
                INSERT INTO users (username, email, password_hash)
                VALUES ($1, $2, $3)
                ON CONFLICT (username) DO NOTHING
                RETURNING id
                """,
                username,
                email,
                pw_hash,
            )
            if row is None:
                print(f"  [skip] {username} already exists")
            else:
                print(f"  [seed] {username} -> {row['id']}")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
