# Gomoku Project

Welcome to Gomoku Project.

Gomoku, also called "five in a row", is an abstract strategy board game. It is traditionally played with Go pieces (black and white stones) on a 15×15 Go board while in the past a 19×19 board was standard. Because pieces are typically not moved or removed from the board, gomoku may also be played as a paper-and-pencil game. The game is known in several countries under different names, like "crosses and naughts", etc.

## Gomoku Components

Currently, building the game with `make clean all` results in:

- a single binary `gomoku` that plays with the AI by the default, but accepts many CLI flags to adjust the difficulty.

- a single binary `gomoku-httpd` which listens on a HTTP port to POST to /gomoku/play and expect to receive a JSON response, schema for which is in the `doc` folder.

- A single binary `gomoku-http-test` (with it's own CLI) that connects to the port of `gomoku-httpd` (or several) and plays a game where the state is on the client's side, but the servers receive JSON representing a game state, they figure out how's next, and find the best move, returning the JSON with one additional move unless there is a win.

- We now have a web front-end that can talk to the `gomoku-httpd` daemon and make it play against itself.

- We also now have the cluster version that works locally in development (on a MacBook):

  - in development, first run `bin/gctl setup` to get everything installed and setup. The bash setup function is an aggregation function which calls four more specific setups.
  - in the development we should be starting the game cluster with `bin/gctl start` (starts envoy reverse proxy, nginx, gomoku-httpd).
  - or `bin/gctl start [ -p haproxy ]` to use haproxy instead
  - stopped with `gctl stop`
  - restarted with `gctl restart`
  - monitored with `gctl observe [ htop | btop | ctop | btm ]`
  - monitored with `gctl ps` — prints all the processes related to the cluster using a custom format ps sequence: PID, PPID, %CPU, %MEM, ARGS

### Current Deploy

The canonical deploy command is **`just deploy`** — it sources `.env` at repo root, runs Alembic migrations against the production database, builds the frontend + Docker images for `linux/amd64`, applies Terraform, and posts a deploy marker to Honeycomb. The actual logic lives in `bin/deploy`.

Required `.env` keys at repo root (deploy-time only — never read at runtime):

- `PRODUCTION_DATABASE_URL` — Neon pooled DSN
- `PRODUCTION_JWT_SECRET` — HMAC key (`just jwt-secret` to generate)
- `HONEYCOMB_INGEST_API_KEY` — runtime tracing
- `HONEYCOMB_CONFIG_API_KEY` — deploy markers
- `PROJECT_ID`, `REGION`

Legacy `just cr-init` and `just cr-update` still exist as escape hatches but skip migrations — prefer `just deploy`.

### Runtime Configuration

The FastAPI app loads `api/.env.{development,test,ci}[.local]` based on the `ENVIRONMENT` env var (default `development`). The `.local` overlays are gitignored for personal overrides (e.g., pointing local dev at Neon). Production runtime config arrives via Cloud Run env vars set by Terraform; no `.env` file is read in production.

### Tests

`just test-api` runs the API test suite in parallel across 4 workers via pytest-xdist (currently ~145 tests; multiplayer adds 56). Each worker gets its own `gomoku_test_gw{N}` database, dropped at session end. Sequential `just test` from `api/` also works for debugging.

### Multiplayer (human vs human)

The FastAPI server hosts a complete two-human game flow under
`/multiplayer/*` (see `api/app/routers/multiplayer.py`). The frontend's
`ChooseGameTypeModal` lets a logged-in user pick AI or Another Player —
the latter generates a 15-minute invite link (`/play/<6-char>`) the host
shares. Highlights a future maintainer should know:

- **No SQLAlchemy** — all DB access is asyncpg + raw SQL, with savepoints
  for the code-collision retry path.
- **Schema discriminator** — `games.game_type IN ('ai','multiplayer')` keeps
  the strict AI invariants (`depth>=1`, `radius>=1`, `total_moves>0`)
  while admitting `0/0/0` sentinels for multiplayer history rows.
- **Lazy expiry** — every read of a `waiting` game past its `expires_at`
  flips it to `cancelled`; no background sweeper is required for the
  modal flow.
- **Tiered polling** — both `useMultiplayerPolling` and
  `useMultiplayerHostPolling` use `pollingIntervalForElapsedMs`:
  300 ms for the first 10 min, 2 s up to 30 min, 3 s up to 60 min,
  5 s thereafter. Wall-clock caps remain (15 min waiting, 8 h in-progress).

Reference docs: `doc/human-vs-human-plan.md` (architecture & API),
`doc/multiplayer-modal-plan.md` (UX), `doc/multiplayer-bugs.md`
(historical issues that drove the current design).

## PR #95 Rework — Solo/Multi tabs + chat panel + slash commands + backend

PR #95 (`kig/sidepanel-tabs-and-chat`) was reviewed and received "request changes." The code quality is solid — tests pass (181 pytest, 54 vitest, 7 Cypress), types check, lints clean — but there are architectural problems that need fixing before merge. This file describes exactly what to change.

The branch has two commits:

1. `34eda87` — Frontend: SidePanelTabs, ChatPanel, slash command parsing
1. `40084a9` — Backend: chat.py, social.py routers, migration 0009

## Required Changes (must fix)

### 1. Gate `/chat/invite` behind a relationship requirement

**Problem:** Anyone can `/invite @anyone` as long as they aren't blocked. This is a spam vector — a random user can create game codes targeting any username they discover.

**Fix:** In `api/app/routers/chat.py`, in the `invite()` endpoint, after the block check and before calling `_target_state`, add a query that checks whether a unidirectional follow exists in **either** direction between caller and target:

```sql
SELECT 1 FROM friendships
WHERE (user_id = $1::uuid AND friend_id = $2::uuid)
   OR (user_id = $2::uuid AND friend_id = $1::uuid)
LIMIT 1
```

If no row exists, raise `HTTPException(status.HTTP_403_FORBIDDEN, "must_follow_or_be_followed")`.

Add tests in `api/tests/test_chat_invite.py`:

- `test_invite_without_relationship_returns_403` — neither follows the other, expect 403
- `test_invite_when_caller_follows_target_succeeds` — caller follows target, expect 200
- `test_invite_when_target_follows_caller_succeeds` — target follows caller, expect 200

### 2. Decouple game termination from `/social/unfollow`

**Problem:** `/social/unfollow` terminates an active multiplayer game if the unfollow severs the "last link" between two players. This creates a bizarre coupling where a game's liveness depends on social graph state that neither player can see in the game UI. A user unfollowing someone shouldn't silently kill their game.

**Fix:** In `api/app/routers/social.py`, in the `unfollow()` endpoint, remove ALL game termination logic. The endpoint should:

1. Delete the friendship row
1. Return `{"unfollowed": true}` (drop the `game_terminated` field entirely from the unfollow response)

Only `/social/block` and explicit resign/timeout should terminate games. Update the Pydantic response model accordingly.

Update `api/tests/test_social.py`:

- Remove or rewrite any test that asserts `game_terminated` behavior on unfollow
- Add `test_unfollow_does_not_terminate_active_game` — create a game between two mutual followers, have one unfollow, assert the multiplayer game state is still `in_progress`

On the frontend in `ChatPanel.tsx`, update the `/unfollow` slash command handler: since the server no longer returns `game_terminated`, remove the `onActiveGameTerminated` call from the unfollow branch. Keep it only for `/block`.

### 3. Extract shared game-code allocation helper

**Problem:** `api/app/routers/chat.py` has a retry loop (8 attempts with savepoints) for allocating a unique game code. The multiplayer router's `POST /multiplayer/new` (from PR #90) does NOT have this retry loop. There are now two code paths that insert into `multiplayer_games` with a generated code, only one of which handles collisions.

**Fix:** Create `api/app/multiplayer/allocate.py`:

```python
"""Shared game-code allocation with collision retry."""

from __future__ import annotations

import asyncpg

from app.multiplayer.codes import new_code

MAX_RETRIES = 8

async def allocate_game(
    conn: asyncpg.Connection,
    host_user_id: str,
    host_color: str = "X",
    board_size: int = 15,
    color_chosen_by: str = "host",
) -> str:
    """Insert a new multiplayer_games row with a unique code.

    Returns the allocated code. Retries up to MAX_RETRIES times on
    UniqueViolationError (code collision). Each attempt uses a savepoint
    so a collision doesn't poison the caller's transaction.

    Raises RuntimeError if all attempts fail (astronomically unlikely
    with a ~729M codespace).
    """
    last_exc: Exception | None = None
    for _ in range(MAX_RETRIES):
        candidate = new_code()
        try:
            async with conn.transaction():
                await conn.execute(
                    """
                    INSERT INTO multiplayer_games
                        (code, host_user_id, host_color, board_size,
                         color_chosen_by)
                    VALUES ($1, $2::uuid, $3, $4, $5)
                    """,
                    candidate,
                    host_user_id,
                    host_color,
                    board_size,
                    color_chosen_by,
                )
            return candidate
        except asyncpg.UniqueViolationError as exc:
            last_exc = exc
            continue
    raise RuntimeError(f"Failed to allocate game code after {MAX_RETRIES} attempts: {last_exc}")
```

Then update both call sites:

- `api/app/routers/chat.py` `invite()` — replace the inline retry loop with `code = await allocate_game(conn, caller_id)`
- `api/app/routers/multiplayer.py` `create_game()` — replace the bare `INSERT` with `code = await allocate_game(conn, ...)`

Update `api/app/multiplayer/__init__.py` to export `allocate_game`.

## Strongly Recommended Changes

### 4. Use Literal type for `target_state` in InviteResponse

**Problem:** `InviteResponse.target_state` is typed as `str` with the valid values documented only in a comment.

**Fix:** In `api/app/routers/chat.py`, change:

```python
target_state: str  # 'in_game' | 'idle' | 'offline'
```

to:

```python
from typing import Literal
target_state: Literal["in_game", "idle", "offline"]
```

Also update the return type of `_target_state()` to `Literal["in_game", "idle", "offline"]`.

### 5. Extract `_invite_url` into a shared module

**Problem:** `_invite_url()` in `chat.py` duplicates URL construction logic from the multiplayer router. The inline comment says "kept inline to avoid coupling" but these are two routers in the same app sharing the same domain — this isn't coupling, it's a shared utility.

**Fix:** Create or add to `api/app/multiplayer/urls.py` (or add to `__init__.py`):

```python
from app.config import settings

def game_invite_url(code: str) -> str:
    domain = settings.effective_domain
    scheme = (
        "http" if domain.startswith("localhost") or domain.startswith("127.") else "https"
    )
    return f"{scheme}://{domain}/play/{code}"
```

Import and use in both `chat.py` and `multiplayer.py`.

### 6. Specify what the blocked player sees

**Problem:** When `/social/block` terminates a game, the blocking player gets kicked to idle via `onActiveGameTerminated`. But what does the *blocked* player see? Their polling will eventually get a terminal game state, but there's no user-facing message.

**Fix:** In the multiplayer game view returned by `GET /multiplayer/{code}`, when the game state is `abandoned` (or `finished` with no winner), and the requesting user is the one who was blocked, the response should include a reason field or the frontend should show a neutral message. The simplest approach:

- In `MultiplayerGamePage.tsx`, when the polling detects a state transition to `abandoned` or `finished` that wasn't caused by a move or resign, show a banner: "Your opponent has left the game."
- Do NOT reveal that a block occurred — that's a privacy norm.

### 7. Chat bubbles — current user on the RIGHT

**Problem:** The PR puts current-user chat bubbles on the LEFT. Every major messaging app (iMessage, WhatsApp, Slack, Discord, Telegram) puts your messages on the right. This will confuse users.

**Fix:** In `ChatPanel.tsx`, swap the alignment:

- Current user bubbles: `justify-end` + `bg-blue-600 text-white` (right-aligned)
- Peer bubbles: `justify-start` + `bg-neutral-800 border` (left-aligned)

## File as Issues (not in this PR)

These should be tracked but not addressed in this PR:

1. **Split migration 0009** into two migrations: one for social graph tables (`friendships`, `blocks`) and one for chat tables (`chats`, `chat_messages`). These are independent domain concepts and rolling back chat shouldn't require rolling back the social graph. Track as tech debt.

1. **Rate limiting on chat message sends.** Once the chat message persistence endpoint lands (deferred per chat.py docstring), add per-user rate limiting to prevent abuse. File now so it doesn't get forgotten.

1. **Game expiration for invite-created games.** The PR description mentions a "15-minute lazy-expiry" for invite games where the invitee never joins, but there's no implementation. File an issue to add a background task or scheduled query that transitions stale `waiting` games to `abandoned`.

## Verification Checklist

After making changes, confirm:

- [ ] `cd api && uv run pytest tests/ -x -q` — all pass (expect ~181+3 new tests)
- [ ] `cd api && uv run ruff check app/ tests/` — clean
- [ ] `cd api && uv run alembic downgrade -1 && uv run alembic upgrade head` — migration round-trips
- [ ] `cd frontend && npx tsc --noEmit` — clean
- [ ] `cd frontend && npm run build` — clean
- [ ] `cd frontend && npx vitest run` — all pass
- [ ] `cd frontend && npx cypress run` — all pass
- [ ] Two-tab smoke test: alice creates game, invites bob (after alice follows bob), bob joins, moves alternate correctly, blocking terminates game for both sides with appropriate messaging

## Newly Found Issues

Audit of the locally-staged rework diff on `kig/sidepanel-tabs-and-chat` against the seven asks above. Reviewed on 2026-05-01: all source files in the staged set (`api/app/multiplayer/{allocate,urls,__init__}.py`, `api/app/routers/{chat,multiplayer,social}.py`, the 0009 migration, the three test files, and the two frontend components). The findings below are issues the original review did NOT flag and that were either introduced or left unaddressed by the rework.

### 1. Replace pending-invite cap with rolling-window rate limit (supersedes original Required #1)

**Severity:** blocker
**File(s):** `api/app/routers/chat.py:60-67, 98-160`, `api/tests/test_chat_invite.py:126-214`, new column on `multiplayer_games`

The original Required #1 (relationship gate) is dropped. Replace the current `MAX_PENDING_INVITES=5` cap with a per-caller rolling-window check on **invite-created** games only:

- ≤ 7 invites in any rolling 1-hour window
- ≤ 15 invites in any rolling 24-hour window

Both counts must exclude `/multiplayer/new` (modal) rows — add a `created_via TEXT NOT NULL CHECK (created_via IN ('modal','invite'))` column on `multiplayer_games` and pass it from each call site through `allocate_game()`. This also closes finding #3 (modal/invite conflation) and makes finding #2 (lazy-expiry interaction) moot — the count no longer cares about `state`.

On exceed, raise `429` with `detail = {"error": "Your have reached invite maximum for this period.", "retry_at": <ISO timestamp>}` (the literal error string is required verbatim). `retry_at` is the later of:

- `oldest_in_hour + 1h` (when hourly cap fires)
- `oldest_in_day + 24h` (when daily cap fires)

Tests: drop the three pending-cap tests; add `test_invite_at_hourly_cap_returns_429` (8th in the hour 429s with the required error string + a `retry_at`), `test_invite_at_daily_cap_returns_429` (using SQL backdating to fake old rows under the hourly cap), and `test_invite_count_excludes_modal_rooms` (open N modal games, then invite — the modal rows don't consume invite quota).

### 2. `MAX_PENDING_INVITES` cap counts stale-but-unread `waiting` rows, contradicting the docstring

**Severity:** high
**File(s):** `api/app/routers/chat.py:98-117`, `api/app/routers/multiplayer.py:170-189`

The docstring on `_count_pending_invites` claims "the 15-min lazy-expiry on `waiting` rows means abandoned invites disappear from this count without any scheduled sweeper." That is false: lazy expiry only fires inside `_expire_if_stale`, which is called per-code from `GET /multiplayer/{code}`, `POST /join`, and `POST /cancel`. The pending-count query (`SELECT COUNT(*) … WHERE state='waiting'`) never triggers it, so a user whose first 5 invites went unread for >15 min stays jammed at the cap forever — `429 too_many_pending_invites` even though every one of their pending rows is logically expired. Either expand the WHERE clause to `state='waiting' AND expires_at > NOW()` (cheap, correct), or run a bulk `_expire_stale_for_host` UPDATE before counting.

### 3. `MAX_PENDING_INVITES` conflates chat invites with regular `/multiplayer/new` rooms

**Severity:** high
**File(s):** `api/app/routers/chat.py:98-160`

`_count_pending_invites` matches on `host_user_id = caller AND state = 'waiting'` — it does not distinguish a `multiplayer_games` row created by `POST /chat/invite` from one created by `POST /multiplayer/new` (the existing modal flow). A user who opens the multiplayer modal a few times (each click creates a `waiting` row that lingers until cancel/join/expiry) consumes invite slots they don't know exist, and will hit `429 too_many_pending_invites` from the chat panel for an unrelated reason. Conversely, the cap can be bypassed by alternating modal-creates with chat-invites against accomplice accounts. Fix by adding a discriminator (e.g., `source ENUM('modal','chat_invite')` on `multiplayer_games`, or the `intended_guest_id` column the docstring already mentions as future work) and counting only `source='chat_invite'`.

### 4. `host_color` parameter type to `allocate_game` doesn't match the spec or the column

**Severity:** medium
**File(s):** `api/app/multiplayer/allocate.py:30-37`

The shared helper signature is `host_color: str | None = "X"`, but the multiplayer router passes `body.host_color` typed as `Literal["X", "O"] | None` (with `None` meaning "guest picks"), and the chat router relies on the `"X"` default. The `str | None` annotation silently admits any string — including invalid values like `"Y"` or `""` — which would only be caught by the DB CHECK constraint at `INSERT` time, surfacing as a 503 `failed_to_allocate_code` (after 8 retries with the same bad value). Tighten to `host_color: Literal["X", "O"] | None = "X"` so type-checkers actually catch the mistake at the call site.

### 5. `social.py` module docstring omits the `400 cannot_target_self` response that `_resolve_target` raises

**Severity:** medium
**File(s):** `api/app/routers/social.py:1-28, 72-84`

`_resolve_target` raises `HTTPException(status.HTTP_400_BAD_REQUEST, "cannot_target_self")` for all three endpoints, but the per-endpoint contract enumerated at the top of the file only lists `200` and `404 user_not_found` for follow/unfollow/block. A frontend author reading the contract will not handle the 400 (the chat panel's `errorCaption` will surface the raw detail string). Either document the 400 alongside the 404 for all three verbs, or — given that follow/unfollow are now idempotent — short-circuit self-targeting to a 200 no-op for symmetry with the "DELETE returns affected rows but we don't care" comment.

### 6. `MultiplayerGamePage` shows the "opponent has left" banner to the player who *did* the blocking

**Severity:** medium
**File(s):** `frontend/src/components/MultiplayerGamePage.tsx:83-106, 174-184`

The banner fires whenever `prev === 'in_progress' && game.state === 'abandoned'`. When the local user types `/block @peer` in the chat panel, the server flips the shared game to `abandoned`. The chat panel calls `onActiveGameTerminated()` (which the parent handles by routing away from `/play/<code>`), but if the user is on a second tab still pointed at the game, that tab's poll lands on `state='abandoned'` with `prev='in_progress'` and tells the *blocker* "Your opponent has left the game." Track who initiated the termination (e.g., a `terminated_by` field on the game view, or a local `iBlockedRef` flag set by the chat panel and read here) so the banner only shows to the receiving side.

### 7. Frontend `SlashResponseBody` still claims `unfollow` may set `game_terminated`, but the backend no longer does

**Severity:** low
**File(s):** `frontend/src/components/ChatPanel.tsx:85-100, 195`

`SlashResponseBody` keeps `game_terminated?: boolean` as a generic field across all four endpoints, and `dispatchSlash` calls `onActiveGameTerminated?.()` whenever `body.game_terminated` is truthy regardless of which slash command ran. After Required #2, `/social/unfollow` returns `{unfollowed: true}` and never sets `game_terminated`, so the current code is already correct in practice — but a future server bug or stray field would silently re-introduce the unfollow→terminate behavior the spec just removed. Make the dispatch explicit (only check `body.game_terminated` when `action === 'block'`) or split the response types per action so TypeScript can prove the field can't appear on the unfollow path.
