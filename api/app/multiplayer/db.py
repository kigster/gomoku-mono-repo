"""Multiplayer SQL access layer returning typed row models."""

from __future__ import annotations

import json as json_mod

import asyncpg

from app.models.db_tables import MultiplayerGameRow, MultiplayerGameWithUsersRow, UserEloSnapshot


def _as_model(row: asyncpg.Record | None, model_type):
    """Convert an asyncpg record to a model."""
    if row is None:
        return None
    return model_type.model_validate(dict(row))


async def expire_waiting_if_stale(conn: asyncpg.Connection, code: str) -> None:
    """Expire a waiting game if it is stale."""
    await conn.execute(
        """
        UPDATE multiplayer_games
        SET    state      = 'cancelled',
               version    = version + 1,
               updated_at = NOW()
        WHERE  code = $1
          AND  state = 'waiting'
          AND  expires_at <= NOW()
        """,
        code,
    )


async def fetch_game_with_usernames_by_code(
    conn: asyncpg.Connection, code: str
) -> MultiplayerGameWithUsersRow | None:
    """Fetch a game with usernames by code."""
    row = await conn.fetchrow(
        """
        SELECT mg.*,
               hu.username AS host_username,
               gu.username AS guest_username
        FROM multiplayer_games mg
        JOIN users hu ON hu.id = mg.host_user_id
        LEFT JOIN users gu ON gu.id = mg.guest_user_id
        WHERE mg.code = $1
        """,
        code,
    )
    return _as_model(row, MultiplayerGameWithUsersRow)


async def fetch_game_with_usernames_by_code_for_update(
    conn: asyncpg.Connection, code: str
) -> MultiplayerGameWithUsersRow | None:
    """Fetch a game with usernames by code for update."""
    row = await conn.fetchrow(
        """
        SELECT mg.*,
               hu.username AS host_username,
               gu.username AS guest_username
        FROM multiplayer_games mg
        JOIN users hu ON hu.id = mg.host_user_id
        LEFT JOIN users gu ON gu.id = mg.guest_user_id
        WHERE mg.code = $1
        FOR UPDATE OF mg
        """,
        code,
    )
    return _as_model(row, MultiplayerGameWithUsersRow)


async def fetch_game_by_code_for_update(
    conn: asyncpg.Connection, code: str
) -> MultiplayerGameRow | None:
    """Fetch a game by code for update."""
    row = await conn.fetchrow("SELECT * FROM multiplayer_games WHERE code = $1 FOR UPDATE", code)
    return _as_model(row, MultiplayerGameRow)


async def update_join_game(
    conn: asyncpg.Connection, code: str, guest_user_id: str, new_host_color: str
) -> MultiplayerGameRow:
    """Update a game to join a guest."""
    row = await conn.fetchrow(
        """
        UPDATE multiplayer_games
        SET    guest_user_id = $1::uuid,
               host_color    = $3,
               state         = 'in_progress',
               version       = version + 1,
               updated_at    = NOW()
        WHERE  code = $2
        RETURNING *
        """,
        guest_user_id,
        code,
        new_host_color,
    )
    return MultiplayerGameRow.model_validate(dict(row))


async def fetch_username_by_id(conn: asyncpg.Connection, user_id: str) -> str | None:
    """Fetch a username by id."""
    return await conn.fetchval("SELECT username FROM users WHERE id = $1::uuid", user_id)


async def update_cancel_game_by_id(conn: asyncpg.Connection, game_id: str) -> MultiplayerGameRow:
    """Update a game to cancel it."""
    row = await conn.fetchrow(
        """
        UPDATE multiplayer_games
        SET    state      = 'cancelled',
               version    = version + 1,
               updated_at = NOW()
        WHERE  id = $1::uuid
        RETURNING *
        """,
        game_id,
    )
    return MultiplayerGameRow.model_validate(dict(row))


async def list_games_with_usernames_for_user(
    conn: asyncpg.Connection, user_id: str, limit: int
) -> list[MultiplayerGameWithUsersRow]:
    """List games with usernames for a user."""
    rows = await conn.fetch(
        """
        SELECT mg.*,
               hu.username AS host_username,
               gu.username AS guest_username
        FROM multiplayer_games mg
        JOIN users hu ON hu.id = mg.host_user_id
        LEFT JOIN users gu ON gu.id = mg.guest_user_id
        WHERE mg.host_user_id = $1::uuid OR mg.guest_user_id = $1::uuid
        ORDER BY mg.created_at DESC
        LIMIT $2
        """,
        user_id,
        limit,
    )
    return [MultiplayerGameWithUsersRow.model_validate(dict(row)) for row in rows]


async def update_game_after_move(
    conn: asyncpg.Connection,
    *,
    game_id: str,
    moves: list[tuple[int, int]],
    next_to_move: str,
    new_state: str,
    new_winner: str | None,
) -> MultiplayerGameRow:
    """Update a game after a move."""
    new_moves_json = json_mod.dumps([list(m) for m in moves])
    row = await conn.fetchrow(
        """
        UPDATE multiplayer_games
        SET    moves         = $1::jsonb,
               next_to_move  = $2,
               version       = version + 1,
               updated_at    = NOW(),
               state         = $3::varchar,
               winner        = $4,
               finished_at   = CASE
                   WHEN $3::varchar = 'finished' THEN NOW()
                   ELSE finished_at
               END
        WHERE  id = $5::uuid
        RETURNING *
        """,
        new_moves_json,
        next_to_move,
        new_state,
        new_winner,
        game_id,
    )
    return MultiplayerGameRow.model_validate(dict(row))


async def update_game_after_resign(
    conn: asyncpg.Connection, *, game_id: str, winner: str
) -> MultiplayerGameRow:
    """Update a game after a resignation."""
    row = await conn.fetchrow(
        """
        UPDATE multiplayer_games
        SET    state       = 'finished',
               winner      = $1,
               version     = version + 1,
               updated_at  = NOW(),
               finished_at = NOW()
        WHERE  id = $2::uuid
        RETURNING *
        """,
        winner,
        game_id,
    )
    return MultiplayerGameRow.model_validate(dict(row))


async def fetch_user_elo_snapshot(conn: asyncpg.Connection, user_id: str) -> UserEloSnapshot:
    """Fetch a user elo snapshot."""
    row = await conn.fetchrow(
        "SELECT elo_rating, elo_peak, elo_games_count FROM users WHERE id = $1::uuid",
        user_id,
    )
    return UserEloSnapshot.model_validate(dict(row))


async def insert_finished_game_history_row(
    conn: asyncpg.Connection,
    *,
    username: str,
    user_id: str,
    winner: str,
    human_player: str,
    board_size: int,
    total_moves: int,
    game_json: str,
    opponent_id: str,
    elo_before: int,
    elo_after: int,
    opponent_elo_before: int,
) -> None:
    """Insert a finished game history row."""
    await conn.execute(
        """
        INSERT INTO games
          (username, user_id, winner, human_player, board_size, depth, radius,
           total_moves, human_time_s, ai_time_s, score, game_json,
           game_type, opponent_id, elo_before, elo_after, opponent_elo_before)
        VALUES ($1, $2::uuid, $3, $4, $5, 0, 0,
                $6, 0, 0, 0, $7::jsonb, 'multiplayer', $8::uuid,
                $9, $10, $11)
        """,
        username,
        user_id,
        winner,
        human_player,
        board_size,
        total_moves,
        game_json,
        opponent_id,
        elo_before,
        elo_after,
        opponent_elo_before,
    )


async def update_user_elo(
    conn: asyncpg.Connection,
    *,
    user_id: str,
    elo_after: int,
) -> None:
    """Update a user elo."""
    await conn.execute(
        """UPDATE users
              SET elo_rating = $2,
                  elo_peak = GREATEST(elo_peak, $2),
                  elo_games_count = elo_games_count + 1,
                  updated_at = now()
            WHERE id = $1::uuid""",
        user_id,
        elo_after,
    )
