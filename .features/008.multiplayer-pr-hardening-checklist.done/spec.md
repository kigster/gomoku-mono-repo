# Multiplayer PR Hardening Checklist

## Goal

The initial multiplayer pull request introduced the two-human game
flow but shipped several concerning patterns that must be addressed
before the next deploy. This spec captures the seven correctness,
robustness, and ergonomics issues identified during PR review.

## Context

The multi-player flow uses the Python FastAPI server end-to-end —
the C-based `gomoku-httpd` is not in the path. Python validates
moves, generates invite codes, polls game state, and writes the
final result. Because the data model overlaps with the existing AI
`games` table and the polling design has no time bound, several
shortcuts in the original PR will degrade reliability or distort
historical data over time.

## Required fixes (priority order)

### 1. Don't weaken the `games` table constraints

The original PR relaxed CHECK constraints on `games.depth`,
`games.radius`, and `games.total_moves` (allowing 0) so multiplayer
games could use the same table as AI games. Those constraints exist
for a reason — to keep garbage AI data out of the leaderboard.

**Fix:** add a `game_type` discriminator column
(`'ai' | 'multiplayer'`) with type-specific CHECK constraints:
AI rows keep the `>= 1` invariants, multiplayer rows admit `0/0/0`
sentinels. History queries filter by `game_type` where needed.

### 2. Remove `DROP TABLE IF EXISTS ... CASCADE` from migration 0006

A defensive CASCADE drop at the top of `upgrade()` is a migration
smell — it compensates for a broken test fixture and can silently
drop foreign keys added by later migrations.

**Fix:** repair the test fixture, then remove the CASCADE drop.

### 3. Add expiry / TTL on `waiting` games

There is no TTL on waiting games — someone can leave thousands of
codes in `waiting` forever, and the polling hook will hammer the
server indefinitely.

**Fix:** lazy-expire `waiting` games after **15 minutes**
(every read flips the row to `cancelled`). A background sweeper is
optional bonus, not required.

### 4. Collision retry in `new_code()`

The 6-char Crockford codespace (~729 M) is fine, but `new_code()`
does not check for collisions, and the UNIQUE constraint on `code`
will raise an unhandled `asyncpg.UniqueViolationError`.

**Fix:** wrap insertion in a retry loop (max 5–8 attempts) using a
per-attempt savepoint.

### 5. Polling backoff + max-age cutoff

`useMultiplayerPolling` polls every 1.5 s forever. A user who opens
the page and walks away for 8 hours generates ~19,000 unnecessary
requests.

**Fix:**

- Tier the polling cadence (300 ms → 2 s → 3 s → 5 s as the game
  ages), and
- Hard-cap polling at **15 min for waiting** rooms and **8 h for
  in_progress** games. After the cap, surface "this game has
  expired".

### 6. Surface join errors in the frontend

`MultiplayerGamePage` calls join and silently logs errors. A 403
`already_joined` or 409 `game_full` becomes nothing in the UI.

**Fix:** render user-facing error messages for the documented 4xx
detail codes (`already_joined`, `game_full`, `not_found`,
`game_cancelled`, `game_expired`, `cannot_join_own_game`).

### 7. Tighten `MoveRequest` validation against `board_size`

`MoveRequest` accepts `x`/`y` up to 18 regardless of board size.
The handler catches it with a 400, but Pydantic returns 422 for
the syntactic case — two status codes for the same semantic error
is confusing for client developers.

**Fix:** use a board-size-aware validator (or carry `board_size` in
the request and validate inside Pydantic) so both layers return
the same status code.

## Acceptance criteria

- All seven fixes shipped before the next deploy.
- `games.depth`, `games.radius`, `games.total_moves` invariants
  remain `>= 1` for `game_type = 'ai'` rows.
- Polling stops or backs off after the documented caps.
- Join errors are visible in the UI without opening the console.

## Cross-references

- Plan and rationale per item: `plan.md` in this folder.
- Original multiplayer plan:
  `.features/003.multiplayer-architecture-and-data-model.done/`.
- Final user-facing spec:
  `.features/006.web-multiplayer-invite-flow.done/`.
