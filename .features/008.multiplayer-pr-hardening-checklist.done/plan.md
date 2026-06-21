# FastAPI Server

## Implementation of the multi-player game flow.

NOTE: In this type of game flow, the C-based AI `gomoku-httpd` is not used at all. Therefore the Python FastAPI server must implement two-player gameplay, verify validity of the moves, and how the two players connect.

## Review of the Multi-Player PR

This file describes some problems with the https://github.com/kigster/gomoku-mono-repo/pull/90 that introduces multi-player game.

The goal of this task is to address all of the problems described below.

## Implementation Concerns

### Migration 0006

The depth=0, radius=0 constraint relaxation in migration 0006 is the most concerning part. You're weakening CHECK constraints on the games table that exist for a reason — to prevent garbage data from AI games. The PR does this to write "sentinel" rows so multiplayer games show up in /game/history. This is the wrong abstraction.

It is much more reasonable to add a `game_type` discriminator column ('ai' | 'multiplayer') with type-specific constraints, and use a separate view/query for multiplayer history.

Relaxing existing constraints to shoehorn a different feature's data into an existing table is how you get mystery bugs six months from now when someone queries games assuming depth >= 1.

## Migraiton SLOP

The defensive `DROP TABLE IF EXISTS ... CASCADE` at the top of upgrade() is a code smell the self-review correctly identified but then dismissed too easily. This means your migration is not idempotent in the way Alembic expects — it's compensating for a broken test fixture.

Fix the fixture. CASCADE in a migration upgrade() is a land mine — remove it; if someone has foreign keys referencing that table from a later migration, the CASCADE silently drops them. This is not an acceptable workaround.

### Board Size

`MoveRequest` accepting x/y up to 18 regardless (and without checking) of the `board_size` is not just cosmetic.

Yes, the handler catches it with a 400. But now you have two validation layers returning different status codes (Pydantic's 422 vs your 400) for what is semantically the same error. For a client developer integrating this API, that's confusing. Use a validator or make the Pydantic model board-size-aware.

### Timeout

No timeout on the polling. The `useMultiplayerPolling` hook polls every 1.5s forever while the game is waiting or `in_progress`. If someone opens a game link and forgets about it for 8 hours, that's ~19,000 unnecessary requests. You should add an exponential backoff after N polls with no state change, or at minimum a `max_age` cutoff where you stop polling and show "this game invitation has expired.".

Add exponential backoff + expire the invitation links after 15 minutes. If a user sends an invitation link and it's not used after 15 minutes, the second player is not going to use it.

### Game Expiration/Cleanup

There is complete lack of game expiration/cleanup. There's no TTL on waiting games. Someone can create thousands of game codes that sit in waiting state forever. You need either a background task or a DB trigger that transitions stale waiting games to abandoned after, 15 minutes.

### Add a unique constraint on invite code

The 6-char Crockford code space (~729M) is fine for now, but new_code() doesn't check for collisions. The UNIQUE constraint on code will raise an asyncpg `UniqueViolationError` that's current unhandled in `create_game`. Replace it with the while loop, until a unique code is found.

Retry loop is three lines of code and prevents a 500 on the one-in-a-billion collision.

### Frontend

There no error handling on the join flow. `MultiplayerGamePage` calls join and if the game is already full, the user gets... what exactly? The 403 `already_joined` and 409 `game_full` responses need to render user-facing messages, not just console errors.

## Summary of recommended fixes (in priority order)

1. Add game_type column instead of relaxing depth/radius/total_moves constraints
1. Fix test_migrations.py::fresh_db and remove the DROP TABLE IF EXISTS CASCADE
1. Add game expiration (TTL on waiting state)
1. Add collision retry in new_code() generation
1. Add polling backoff / max-age cutoff
1. Surface join errors to the user in the frontend
1. Tighten MoveRequest validation against actual board size

All of those must be fixed before the next deploy.
