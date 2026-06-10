# 009 — Timed games & timeouts — plan

> Owner: Zeus. Derived from `spec.md`. Jeff-Dean verifier notes at the end.

## 1. Architecture overview

```
create (005/007)  ──timed:bool──►  multiplayer_games row
                                     ├─ timed
                                     ├─ per_move_deadline   (timed only)
                                     └─ game_deadline       (timed → +5m, untimed → +30m)
                                            │
                  join → in_progress  ──────┤ deadlines armed here (game_deadline = now()+cap)
                                            │
        ┌───────────────────────────────────┴────────────────────────────┐
        │                                                                  │
   move POST (HTTP, authoritative)                          GameTimerScheduler (asyncio)
   reset per_move_deadline = now()+15s                      one task per active game,
   reject if now > per_move_deadline                        sleeps until min(deadline),
   (server clock)                                           re-fetches row, fires on expiry
        │                                                                  │
        └──────────────► both fire terminal state in DB ◄─────────────────┘
                          + push game.update / game.timeout over WS (002)
```

Two enforcement paths, **both server-side**:

1. **Reactive** — the move handler validates the per-move deadline whenever a
   move arrives, and resets it for the next player. This catches the common
   case (a move *does* arrive) with zero scheduler dependency.
1. **Proactive** — a `GameTimerScheduler` fires deadlines that elapse with **no
   move POST** (a player who simply walks away, or the whole-game cap). This is
   the part that cannot be done by the move handler alone.

A small reusable helper, `app/multiplayer/timers.py`, computes deadlines and
resolves "which terminal state does this elapsed deadline produce", so 008/011
can call the same logic for the AI-hardest cap.

## 2. Schema / migration

New migration, next in sequence after `0015`
(`20260526-180000-online-users-opponent-presence.py`):

**Path:** `api/db/migrations/versions/20260610-120000-add-multiplayer-game-timers.py`
(`revision = "0016"`, `down_revision = "0015"`).

```sql
ALTER TABLE multiplayer_games
  ADD COLUMN timed             BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Absolute deadline for the player currently on the clock (timed games
  -- only; NULL when timed = false or game not in_progress).
  ADD COLUMN per_move_deadline TIMESTAMPTZ,
  -- Absolute whole-game deadline: in_progress + 5min (timed) or + 30min
  -- (untimed). NULL until the game goes in_progress.
  ADD COLUMN game_deadline     TIMESTAMPTZ;
```

- Partial index to let the scheduler / sweeper find live deadlines cheaply:
  ```sql
  CREATE INDEX multiplayer_games_deadline_idx
    ON multiplayer_games (game_deadline)
    WHERE state = 'in_progress';
  CREATE INDEX multiplayer_games_per_move_idx
    ON multiplayer_games (per_move_deadline)
    WHERE state = 'in_progress' AND per_move_deadline IS NOT NULL;
  ```
- **Winner CHECK already admits `draw`** (migration 0006:47:
  `winner IN ('X','O','draw')`), so the cap-→-draw outcome needs no constraint
  change. Forfeit-loss writes `'X'`/`'O'`, also already allowed.
- Existing `expires_at` (waiting-state TTL) is **untouched** — it governs the
  pre-join window; the new `game_deadline` governs the in-progress window. They
  never overlap (different states).
- `downgrade()` drops the two indexes and three columns.

**Model:** add `timed: bool = False`, `per_move_deadline: datetime | None`,
`game_deadline: datetime | None` to `MultiplayerGameRow` in
`api/app/models/db_tables.py` (around line 128-144, next to `expires_at`). Add
`timed`, `per_move_deadline`, `game_deadline` to the `MultiplayerGameView`
Pydantic model in `api/app/models/multiplayer.py` and surface them in
`_build_view` (`multiplayer.py:113-152`) so the client gets absolute deadlines.

## 3. Timeout firing mechanism — asyncio scheduler (recommended)

**Decision: a `GameTimerScheduler` running as a single asyncio task in the API
process, holding one `asyncio.Task` (timer) per active in-progress game.**
Rejected alternatives and justification below.

### Why not pure lazy-check

The existing `_expire_if_stale` lazy pattern only fires on the *next request
touching that game*. For a per-move timeout the whole point is that **no
request is coming** — the player walked away and the opponent is idle waiting.
A lazy check would never fire until someone polls, and 002 is removing the
poll loop. So lazy-only cannot meet the spec.

### Why not a coarse sweeper

A periodic sweeper (`SELECT ... WHERE deadline < now()` every N seconds) is
simple and restart-safe, but a 15 s per-move clock needs ~1 s firing
granularity; a sweeper tight enough for that wakes constantly and still adds up
to its interval of latency. We keep a **slow sweeper as a safety net** (see
restart-safety) but drive the common case with precise per-game timers.

### The scheduler

- Started in the FastAPI `lifespan` (`api/app/main.py:27`), alongside the pool:
  `fastapi_app.state.timer_scheduler = GameTimerScheduler(pool, ws_manager)`;
  `await scheduler.start()`. Stopped before `close_pool()`.
- `GameTimerScheduler.arm(game_id, deadline)` schedules an `asyncio.Task` that
  `await asyncio.sleep(deadline - now)` then calls `_fire(game_id)`.
  - `_fire` opens a transaction, `SELECT ... FOR UPDATE` the row, **re-checks
    the deadline against the DB clock** (`now()`), and only then applies the
    terminal state. This double-check makes the sleep advisory, not
    authoritative — a move that arrived first will have bumped `version` and
    moved/cleared the deadline, so `_fire` becomes a no-op.
  - For a **timed** game it arms `min(per_move_deadline, game_deadline)` and on
    wake decides which one actually elapsed.
- `arm` is idempotent per game: re-arming cancels the prior task
  (`asyncio.Task.cancel()`) and replaces it — called on every move (per-move
  deadline moves forward) and on join (game goes in_progress).
- `disarm(game_id)` cancels the task when a game reaches a terminal state via
  any path (move-win, resign, timeout).

### Restart safety (persisted deadlines re-arm)

Because both deadlines live in the DB as absolute timestamps, a process
restart loses only the in-memory tasks, not the truth. On `lifespan` startup
the scheduler runs a **re-arm sweep**:

```sql
SELECT id, per_move_deadline, game_deadline
FROM multiplayer_games
WHERE state = 'in_progress';
```

For each row it arms `min(deadlines)`. Any deadline already in the past fires
immediately (the FOR UPDATE re-check still gates it). A lightweight periodic
sweep (e.g. every 30 s) re-runs the same query to catch any game whose in-memory
task was dropped (defensive against a cancelled-task bug) and serves as the
sweeper safety net mentioned above.

## 4. Move-handler changes (`make_move`, `multiplayer.py:513`)

Inside the existing `async with conn.transaction()` block, after the
`fetch_..._for_update` and turn/version checks, before/around the
`update_game_after_move` call:

1. **Per-move deadline check (timed only).** If `row.timed` and
   `row.per_move_deadline is not None`, compare against DB `now()` (select
   `now()` or pass a server timestamp into the UPDATE). If the move is past the
   per-move deadline, **do not apply it** — instead apply the timeout outcome
   (forfeit-loss for the player who was on the clock = `row.next_to_move`).
   Raise nothing to the mover beyond the resulting state; the WS `game.timeout`
   informs both. (This is the race where the timer and a late move collide —
   the transaction + FOR UPDATE serialize them.)
1. **Whole-game deadline check.** If `row.game_deadline` is past, end as a draw
   regardless of the move.
1. **Reset per-move clock.** On a *successful, in-time* move that keeps the game
   `in_progress`, set `per_move_deadline = now() + interval '15 seconds'` (timed
   only) for the next player. On a winning move, null both deadlines.

Extend `update_game_after_move` in `api/app/multiplayer/db.py:147` to also write
`per_move_deadline` (add a parameter; compute `NOW() + INTERVAL '15 seconds'`
in SQL when timed and not finished, else NULL). `game_deadline` is set once at
join time and not touched per move.

**Arm at join.** In `join_game` (`multiplayer.py:373`) / `update_join_game`
(`db.py:82`), when the game transitions to `in_progress`, set
`game_deadline = NOW() + INTERVAL '5 minutes'` (timed) or
`'30 minutes'` (untimed), and `per_move_deadline = NOW() + INTERVAL '15 seconds'`
(timed only). Then call `scheduler.arm(game_id, min(deadlines))`.

**Timeout handler** (`_fire` outcome) reuses `_write_finished_games_rows`
(`multiplayer.py:201`) exactly like resign does, so Elo write-back is identical.

## 5. WebSocket timeout events (over 002 transport)

After any terminal/clock state change commits, push over the 002 connection
manager to **both** participants:

- `game.update` — the full `_build_view` JSON (002's existing event), so the
  client re-renders board + new deadlines. Pushed on **every** clock-affecting
  change: a move (already done by 002's R5 hook), a per-move reset, a timeout.
- `game.timeout` — new event reserved by 002 under `game.*` (alongside the
  reserved `game.ended`). Payload:
  `{ code, reason: "per_move" | "game_cap" | "untimed_expiry", winner: "X"|"O"|"draw"|null, version }`.
  Lets the client show a distinct "Time!" / "Out of time" banner that a plain
  state diff wouldn't convey.

The push happens **after** the DB commit, from both the move handler (reactive
path) and the scheduler `_fire` (proactive path). The scheduler holds a
reference to 002's connection manager (`fastapi_app.state.ws_manager`, injected
at construction). Because the move POST already returns the view to the mover,
the WS push primarily serves the **opponent's idle screen** — which is exactly
the case a timer must cover.

## 6. Frontend timer component (server-deadline → countdown)

**Display location:** the board-modal header in
`frontend/src/components/MultiplayerGamePage.tsx`, in the centre column next to
`PlayerHeader` (lines 339-344) — i.e. "the very top of the board modal, next to
whose turn it is."

- New `frontend/src/components/GameTimers.tsx`:
  - Props: `perMoveDeadline: string | null`, `gameDeadline: string | null`,
    `onClock: boolean` (is it *my* move), `timed: boolean`.
  - Renders up to two countdowns: per-move (timed only) + total-game. Format
    `m:ss`. Per-move pill turns amber \<10 s, red \<5 s with a subtle pulse
    (Tailwind utility classes per the project's frontend rules — no raw CSS).
  - **Server-authoritative rendering.** The component counts down from the
    server's absolute `*_deadline` ISO timestamps, not from a local duration.
    On mount and on every `game.update`/`game.timeout` it recomputes
    `remaining = deadline - Date.now() + skew`, so a re-pushed deadline
    instantly reconciles the display.
  - **Drift reconciliation.** Estimate clock skew once from a server timestamp.
    Reuse 002's heartbeat/`pong` (it already pings for keepalive): record
    `serverNow` from a lightweight field (add `server_time` to the WS
    `heartbeat`/`pong` payload, or to `_build_view`) and compute
    `skew = serverNow - clientNow`. Apply `skew` to every countdown so a player
    with a wrong wall clock still sees the true remaining time. Never let the
    client *expire* the game — at 0 it shows "0:00 / Time!" and waits for the
    server's `game.timeout`; it does not mutate state.
  - A local `requestAnimationFrame`/`setInterval(250ms)` ticks the display only;
    it is pure presentation.

Wire `timed`, `per_move_deadline`, `game_deadline` through
`frontend/src/lib/multiplayerClient.ts` (`MultiplayerGameView` type) and render
`<GameTimers .../>` in the in-game layout block.

## 7. File-by-file task list (real paths)

| File | Change |
| ---- | ------ |
| `api/db/migrations/versions/20260610-120000-add-multiplayer-game-timers.py` | **new** — add `timed`/`per_move_deadline`/`game_deadline` + indexes (rev 0016) |
| `api/app/multiplayer/timers.py` | **new** — `compute_deadlines(timed)`, `resolve_elapsed(row, now) -> outcome`, interval constants; reusable by 008/011 |
| `api/app/multiplayer/scheduler.py` | **new** — `GameTimerScheduler` (arm/disarm/\_fire/re-arm sweep) |
| `api/app/models/db_tables.py` | add 3 fields to `MultiplayerGameRow` (~L128) |
| `api/app/models/multiplayer.py` | add `timed`/deadlines to `MultiplayerGameView`; `timed` to `NewMultiplayerGameRequest` |
| `api/app/multiplayer/allocate.py` | persist `timed`, compute deadlines at creation |
| `api/app/multiplayer/db.py` | `update_game_after_move` writes `per_move_deadline`; `update_join_game` arms deadlines; new `fetch_in_progress_deadlines` for re-arm sweep; timeout-finish writer |
| `api/app/routers/multiplayer.py` | `new_game` reads `body.timed`; `make_move` does deadline check + reset + arm; `join_game` arms; surface deadlines in `_build_view`; WS `game.timeout` push |
| `api/app/main.py` | start/stop `GameTimerScheduler` in `lifespan` (~L27-44); stash on `app.state` |
| `frontend/src/components/GameTimers.tsx` | **new** — countdown component |
| `frontend/src/components/MultiplayerGamePage.tsx` | render `<GameTimers>` next to `PlayerHeader` (~L339) |
| `frontend/src/lib/multiplayerClient.ts` | add `timed`/deadlines to `MultiplayerGameView`; pass `timed` on create |
| `frontend/src/hooks/useGameSocket.ts` (002) | dispatch `game.timeout` to subscribers (consumer wiring) |

## 8. Test plan

### pytest (injectable clock)

Make `now` injectable so tests don't sleep. Approach: route every "current
time" through a single helper (DB `now()` plus a `app.multiplayer.timers.now()`
seam) and monkeypatch the seam — the repo already monkeypatches time in
`api/tests/test_chat_invite.py`, follow that pattern. The scheduler's
`asyncio.sleep` is patched to a near-zero sleep so `_fire` runs deterministically.

Cases:

1. **Per-move timeout → forfeit-loss.** Timed game, advance the clock past
   `per_move_deadline` with no move; `_fire` marks `finished`, winner =
   opposite of `next_to_move`; two `games` history rows + Elo written; both
   players get `game.timeout{reason:"per_move"}`.
1. **Late move at/after per-move deadline is rejected** and converts to the
   forfeit outcome (server clock, not client).
1. **Per-move reset.** A timely move bumps `per_move_deadline` forward by ~15 s
   for the *next* player; the mover's clock is cleared.
1. **5-minute timed cap → draw.** Advance past `game_deadline` while
   in-progress, no winner; `_fire` marks `finished`, `winner = 'draw'`; history
   rows written with draw; `game.timeout{reason:"game_cap"}`.
1. **30-minute untimed expiry → draw.** Same as (4) with `timed=false` and the
   30 min deadline; `reason:"untimed_expiry"`.
1. **Re-arm on restart.** Insert an in-progress timed game with a past
   `per_move_deadline`, construct a fresh scheduler, run the startup sweep,
   assert it fires.
1. **Create persists `timed`** from the request; untimed game arms only
   `game_deadline`, never `per_move_deadline`.

### Cypress (note for 012)

012 owns the e2e suite. Add a fast-timed-game spec there (or flag it as a 012
deliverable): create a **timed** game between two browser contexts, assert both
headers render a per-move timer and a total-game timer next to the turn
indicator, and assert the per-move countdown text **decrements** across two
polls/ticks. A full 15 s timeout in CI is slow — prefer asserting render +
decrement, and (optionally, behind a test-only env knob) a shortened deadline
to exercise the actual forfeit without a real 15 s wait.

## 9. Edge cases

- **Both deadlines race (timed).** Scheduler arms `min(per_move, game)`. On
  wake, `resolve_elapsed` checks the game cap first (a draw at the cap
  outranks a simultaneous per-move forfeit — players shouldn't lose on the same
  instant the game would've drawn anyway). Document this ordering explicitly.
- **Move lands exactly at the deadline.** The move transaction takes
  `FOR UPDATE`; `_fire` also takes `FOR UPDATE` and re-checks against DB `now()`.
  Whichever commits first wins; the loser sees the row already terminal/version-
  bumped and no-ops. Boundary rule: `now() <= per_move_deadline` is **in time**
  (inclusive) so a move at the exact tick is honored, not forfeited.
- **Server restart mid-countdown.** Persisted absolute deadlines + startup
  re-arm sweep (§3) reconstruct every timer; a deadline already passed fires at
  once. No game is silently stranded `in_progress`.
- **WS disconnect during countdown.** The client keeps counting down from the
  last-known absolute deadline (it's absolute, not a server stream). On 002's
  reconnect resync (R8: GET `/multiplayer/{code}`), it re-reads the deadlines
  and corrects. The *authoritative* timeout still fires server-side regardless
  of whether the client is connected, then pushes on reconnect.
- **Untimed game never has a per-move deadline** — guard every per-move branch
  on `row.timed`.
- **Resign / normal win before any deadline** — must `disarm(game_id)` so a
  stale timer can't fire on a finished game (the `_fire` FOR UPDATE re-check is
  the backstop, but disarm avoids the wasted wake).
- **Waiting-state TTL vs new deadlines** — `expires_at` only applies while
  `waiting`; `game_deadline` only while `in_progress`. A game that expires
  before anyone joins still uses the old `_expire_if_stale` path unchanged.

## 10. Build sequence

1. Migration 0016 + model fields (DB shape first).
1. `timers.py` (pure logic) + unit tests for `compute_deadlines` /
   `resolve_elapsed`.
1. `db.py` writers (move-reset, join-arm, re-arm fetch) + `allocate.py` create.
1. `GameTimerScheduler` + `lifespan` wiring + restart re-arm test.
1. `make_move` deadline check/reset + timeout-finish path + pytest cases 1-5,7.
1. WS `game.timeout` push (depends on 002 landing first).
1. Frontend `GameTimers.tsx` + `MultiplayerGamePage` wiring + client types.
1. Hand the Cypress timed-game assertion to 012.

## 11. Assumptions & open questions

- **ASSUMPTION:** Single always-on API instance (002 + umbrella infra make this
  explicit). One in-process scheduler owns all timers; no cross-replica
  coordination needed.
- **ASSUMPTION:** 002 has landed the connection manager + `game.update` push and
  reserved the `game.*` namespace before 009 wires `game.timeout`. If 009 runs
  ahead of 002, the timeout still fires + persists server-side; only the live
  push is deferred (clients see it on next GET resync).
- **ASSUMPTION:** Terminal state for both whole-game caps is `draw` (consistent
  with AI-hardest and Elo's `X/O/draw` vocabulary).
- **OPEN:** Per-move-timeout penalty = **forfeit-loss** (recommended) vs
  auto-random move. Plan assumes forfeit-loss; needs user confirmation.
- **OPEN:** Should the 30-min untimed cap be a `draw` or a no-result
  `abandoned`/`cancelled` (no Elo change)? Recommended `draw`; flagged because
  "draw for inactivity" is debatable when one player simply left — though
  resign already covers the leaver case, so the cap mostly catches
  both-idle/stalled games where a draw is fair.
- **OPEN:** Where to source `server_time` for skew (add to 002's heartbeat
  payload vs to `_build_view`)? Either works; prefer the heartbeat so every
  client gets periodic re-sync, not just on a game fetch. Coordinate with 002.

______________________________________________________________________

## Verifier notes (Jeff Dean)

- **Re-check on fire is non-negotiable.** The `asyncio.sleep` is advisory; the
  only authority is the FOR UPDATE + DB-`now()` re-check inside `_fire`. Without
  it, a clock skew between the event loop and Postgres could forfeit a player a
  few hundred ms early. Covered in §3/§9 — make sure the implementation never
  writes a terminal state off the in-memory sleep alone.
- **Idempotent arm/disarm.** Every state-changing path (move, join, resign,
  win, timeout) must reconcile the timer. The biggest bug risk is a forgotten
  `disarm` on the win/resign paths leaving a ghost timer; the FOR UPDATE
  re-check saves correctness but a leaked task is a slow resource leak under
  load. Add an assertion/log when `_fire` no-ops to surface it.
- **Skew must be signed and bounded.** A malicious client reporting absurd skew
  must not extend its own clock — skew only affects *local rendering*, never the
  server decision (§ server-authoritative). Confirm `GameTimers` never sends
  skew back to the server.
- **Test the race explicitly** (case 2 + boundary in §9): a move committing in
  the same ~ms window as `_fire`. Use a transaction-ordering test, not a wall
  sleep.
- **Untimed games**: verify no `per_move_deadline` is ever set; an accidental
  15 s clock on an "untimed" game is the worst silent failure here.
