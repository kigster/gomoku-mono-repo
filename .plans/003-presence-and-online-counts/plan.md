# 003 — Presence & realtime online counts — plan

Derived from `spec.md`. Owner: Zeus; verifier: Jeff. Builds directly on
002's websocket transport.

## Decisions up front

### OPEN: do AI games count toward "playing"?

**Recommended default: count human-vs-human in-progress games only.**

Rationale:

- The umbrella narrative ("23 Are playing", matchmaking, "non-playing
  human") is about *people available to be matched against other people*.
  An AI game has exactly one human and isn't part of the human lobby.
- "Playing" should be a strict subset of "matchmaking-relevant busy".
  Counting AI players inflates the number with people who are
  unavailable to the very mechanic the modal is selling.
- It keeps the SQL trivial and the invariant clean: every "playing" user
  is in a `multiplayer_games` row.

We still know AI games cheaply (the `games` table has
`status='in_progress'` rows, served by `games_in_progress_idx`), so this
is a one-line policy switch if product wants the bigger number later. The
playing SQL below is written so adding AI is a `UNION`, not a rewrite.

**ASSUMPTION:** product is fine with "playing" = humans in human-vs-human
games for the beta. Flagged for the user; flip the constant if not.

### "Playing" count: single SQL `COUNT` vs maintained in-memory counter

**Recommended: single SQL `COUNT(DISTINCT user)` re-run on each coalesced
flush — NOT a hand-maintained in-memory counter.**

Justification:

- The DB is *already* the authority for game lifecycle (start, finish,
  abandon, cancel, lazy-expiry). A parallel in-memory counter would have
  to be incremented/decremented from every one of those paths
  (`multiplayer.py`'s start/finish/abandon, the lazy-expiry-on-read path,
  win detection, savepoint retry paths). That's a swarm of places to keep
  in sync, and any miss silently corrupts the number with no way to
  self-heal until restart. Hard Rule #4 (clean architecture over slop) —
  a maintained counter is the slop here.
- The query is cheap and bounded: a single `COUNT(DISTINCT host/guest)`
  over rows where `state='in_progress'`, served by the existing partial
  index `multiplayer_games_active_idx`. It runs at most ~1×/sec because
  the push is coalesced (see below), independent of event volume.
- It's *self-healing*: every flush reads ground truth, so a missed event
  or a server restart just produces a correct number on the next tick.

The "online" count, by contrast, **is** in-memory — it's `len(connection manager keys)`, because the connection manager *is* the authority for
"has a live socket." No DB, no counter to maintain; connect/disconnect
already mutate that set in 002.

So: online = in-memory `len`, playing = one cheap indexed SQL COUNT per
flush. Different authorities, each owning the thing it actually knows.

## Architecture

```
        002 connection manager (in-process, keyed by user_id)
                 │  connect / disconnect hooks
                 ▼
        PresenceService  (this slice)
          ├─ online_count()      → len(manager.user_ids())      [in-mem]
          ├─ online_user_ids()   → set[UUID]   (exposed for 004) [in-mem]
          ├─ playing_count()     → SQL COUNT(DISTINCT …)        [DB]
          ├─ mark_dirty()        → schedules a coalesced flush
          └─ _flush()            → recompute {online,playing},
                                   broadcast presence.update if changed
                 │ broadcast(type,payload)        │ send_to(socket,…)
                 ▼                                 ▼
        all clients  ◄── presence.update     one client ◄── presence.snapshot
                 ▼
        frontend usePresence()  →  { online, playing, connected }
                 ▼
        007 modal  /  any consumer
```

Event sources that call `mark_dirty()`:

1. **socket connect** — 002's connect hook (also triggers the unicast
   `presence.snapshot` to that socket; see below).
1. **socket disconnect** — 002's disconnect hook.
1. **multiplayer game start** — `multiplayer.py` where `state` flips to
   `in_progress`.
1. **multiplayer game end** — finish / abandon / cancel / lazy-expiry
   paths in `multiplayer.py`.

`mark_dirty()` is fire-and-forget and idempotent: it sets a flag /
schedules a flush; it never does work inline on the hot path. The game
lifecycle paths must not block on a presence recompute.

## Coalescing / debounce

A single `asyncio` flush loop owned by `PresenceService`:

- `mark_dirty()` sets `self._dirty = True` and, if no flush is pending,
  schedules `_flush()` to run after `COALESCE_INTERVAL = 1.0s` (leading
  events within the window collapse into one flush). This is **trailing**
  coalescing: many connects in 200ms → exactly one `presence.update`.
- `_flush()`:
  1. clears `_dirty`,
  1. computes `online = manager.online_count()` (in-mem) and
     `playing = await playing_count(pool)` (one SQL),
  1. compares to the last-broadcast `(online, playing)`; if unchanged,
     **does nothing** (no redundant frames — e.g. a 3rd tab opening
     doesn't change `online` since it's de-duped per user, so no push),
  1. if changed, `await manager.broadcast("presence.update", {online, playing})` and stores the new tuple.
- Guard against starvation: if events keep firing, the 1s cadence caps
  pushes at ~1/sec. A short **leading** flush on the very first dirty
  after idle is acceptable to make a lone connect feel instant; default
  to trailing-only for simplicity unless 007 reports lag.

The lifecycle owner: `PresenceService` is instantiated in `main.py`'s
`lifespan` (alongside the db pool), holds a reference to 002's connection
manager and the pool, and is stored on `fastapi_app.state.presence`. Its
flush task is cancelled on shutdown.

## Snapshot-on-connect

002's connect hook, after registering the socket, calls
`presence.send_snapshot(socket)`:

```python
async def send_snapshot(self, ws) -> None:
    online = self.manager.online_count()
    playing = await self.playing_count()
    await ws.send_envelope("presence.snapshot", {"online": online, "playing": playing})
```

This is unicast and runs the SQL once per connect. That's fine: connects
are human-paced. If a thundering-herd reconnect (post-deploy) makes
per-connect SQL a concern, the snapshot can read the *last flushed* cached
tuple instead of re-querying — **OPEN**, defer until measured.

The connect hook also calls `mark_dirty()` so everyone *else* learns the
new online count via the coalesced `presence.update`.

## Exact payloads

### Python (server) — a tiny typed shape

```python
# api/app/services/presence.py
from typing import TypedDict

class PresenceCounts(TypedDict):
    online: int
    playing: int
```

Envelope-wrapping (`{type, payload, v}`) and the `v` version field are
002's responsibility; this slice passes only `type` + the `PresenceCounts`
payload.

### TypeScript (frontend)

```ts
// frontend/src/hooks/usePresence.ts
export interface PresenceCounts {
  online: number;
  playing: number;
}

// Discriminated on the 002 envelope's `type`:
type PresenceServerMessage =
  | { type: "presence.snapshot"; v: number; payload: PresenceCounts }
  | { type: "presence.update";   v: number; payload: PresenceCounts };
```

## The playing-count SQL

`state='in_progress'` is the in-progress discriminator for multiplayer
(`multiplayer_games`, migration `20260501-120100`). A row has two
participants (`host_user_id`, `guest_user_id`); both are "playing", and a
user can be in at most one active game, so `COUNT(DISTINCT)` over the
union of both columns is exact:

```sql
SELECT COUNT(*) FROM (
    SELECT host_user_id  AS uid FROM multiplayer_games WHERE state = 'in_progress'
    UNION
    SELECT guest_user_id AS uid FROM multiplayer_games WHERE state = 'in_progress'
) AS playing_users
WHERE uid IS NOT NULL;
```

- `UNION` (not `UNION ALL`) de-dupes, so a user who somehow appears as
  both host and guest (shouldn't happen) is still counted once.
- `uid IS NOT NULL` guards the multiplayer `0/0/0` sentinel /
  not-yet-joined `waiting` rows — but those are excluded by
  `state='in_progress'` anyway; the guard is belt-and-suspenders.
- Served by `multiplayer_games_active_idx` (partial index on `state IN ('waiting','in_progress')`).

**If product later wants AI players counted**, append:

```sql
    UNION
    SELECT user_id AS uid FROM games WHERE game_type = 'ai' AND status = 'in_progress'
```

(served by `games_in_progress_idx`). Single additive change — the reason
we chose a `UNION`-shaped query over `COUNT(DISTINCT host)+...`.

No migration is required: every table, column, and index this slice reads
already exists. (If a dedicated covering view is wanted for clarity it
would be the *next* revision after `0015`, but it's not needed — keep the
count inline in the service.)

## File-by-file (real paths)

### 002 (consumed, light touch)

- `api/app/ws/manager.py` *(002-owned; exact module name set by 002)* —
  must expose `online_count() -> int`, `online_user_ids() -> set[UUID]`,
  `broadcast(type, payload)`, per-socket `send_envelope(type, payload)`,
  and connect/disconnect hooks. If 002 didn't already, 003 adds the
  `online_user_ids()` accessor here (it's a `set(self._by_user.keys())`)
  and wires the two hook callbacks to `presence`.
- `api/app/ws/router.py` *(002-owned WS endpoint)* — in the connect path,
  after registration: `await presence.send_snapshot(ws)` then
  `presence.mark_dirty()`. In the disconnect path: `presence.mark_dirty()`.

### 003 (new / modified)

- **`api/app/services/presence.py`** *(new)* — `PresenceService`:
  holds `manager` + `pool`; `online_count`, `online_user_ids`,
  `playing_count` (the SQL above), `send_snapshot`, `mark_dirty`, the
  coalescing `_flush` loop, `start()` / `stop()` lifecycle. The
  `online_user_ids()` accessor is the clean seam 004 imports — 004 never
  touches the connection manager directly.
- **`api/app/main.py`** *(modified)* — in `lifespan`, after the pool and
  002's manager exist: `presence = PresenceService(manager, pool); await presence.start(); fastapi_app.state.presence = presence`; cancel
  in teardown. (Wire-up only; the WS router include is 002's.)
- **`api/app/routers/multiplayer.py`** *(modified)* — call
  `request.app.state.presence.mark_dirty()` at the four game-lifecycle
  transitions (start → in_progress; finish; abandon/cancel; lazy-expiry
  flip). Fire-and-forget; never block the response.
- **`frontend/src/hooks/usePresence.ts`** *(new)* — subscribes to the
  002 socket, handles `presence.snapshot` + `presence.update`, returns
  `{ online, playing, connected }`. Mirrors the existing hook style in
  `frontend/src/hooks/useChatMessages.ts` (typed interface, `useState` +
  `useEffect`, no polling). Default `{ online: 0, playing: 0 }` until the
  snapshot lands; `connected` reflects the underlying socket so 007 can
  show a skeleton vs real numbers.
- **`frontend/src/types.ts`** *(modified, optional)* — export
  `PresenceCounts` if shared beyond the hook.

## Test plan

### pytest (`api/tests/…`, parallel xdist, per-worker DB)

1. **two sockets → snapshot + update.** Open WS A (002 test harness),
   assert it receives a `presence.snapshot` with `online >= 1`. Open WS B;
   assert **both** A and B receive a `presence.update` with `online == 2`
   within ~1.2s (coalesce window + slack).
1. **double tab counts once.** Same user opens two sockets; assert
   `online` increments by 1, not 2, across the pair.
1. **disconnect decrements.** Close B; assert A receives a
   `presence.update` with `online == 1`.
1. **playing reflects a multiplayer game.** Seed a
   `multiplayer_games` row, flip it to `in_progress`, call `mark_dirty()`;
   assert the next `presence.update` carries `playing == 2`. End the game;
   assert it drops back.
1. **playing SQL unit test.** Direct test of `playing_count()` against a
   seeded DB: 0 active games → 0; one in_progress → 2; a `waiting` row →
   still 0; an AI in_progress `games` row → 0 (asserts AI is excluded
   under the chosen default — the test pins the policy).
1. **coalescing.** Fire `mark_dirty()` N times in a tight loop; assert at
   most a small bounded number of `presence.update` frames are broadcast
   (≈ ⌈elapsed / 1s⌉), and the final frame holds the correct counts.
1. **no-op suppression.** A 3rd tab for an already-online user fires
   `mark_dirty()` but doesn't change `online`; assert **no**
   `presence.update` is broadcast.

### Cypress (note for 012)

012 owns the two-human e2e. Contract this slice guarantees for it: with
two browsers logged in and connected, the load modal in browser 1 shows
`online == 2`; starting a game between them flips `playing` to `2` live in
both without a reload. 003 leaves a stub/TODO in the 012 plan rather than
writing the spec here.

## Race / edge cases (Jeff)

- **Rapid connect/disconnect (flapping tab).** Coalescing absorbs it —
  net change is read from ground truth at flush time, so a connect+
  disconnect inside one window produces zero or one correct frame, never a
  stuck count.
- **Double tabs = count once.** Online is keyed by **user id** in the
  manager, so N sockets for one user → one entry. The manager must only
  drop a user from the online set when their **last** socket closes
  (002's contract; 003 asserts it in test #2/#3).
- **Player mid-reconnect during a game.** They momentarily have **0
  sockets** but their `multiplayer_games` row is still `in_progress`, so
  `playing` still counts them (DB is authority for playing) while `online`
  may briefly not (socket is authority for online). This can transiently
  make `playing > online` by one. Acceptable and self-correcting on
  reconnect; we do **not** add reconnect grace logic in this slice. Noted
  so 007 doesn't assert `playing <= online` as an invariant in the UI.
- **Server restart resets the in-memory online set.** All sockets drop,
  clients reconnect (002's reconnect logic), the manager refills, and the
  first post-restart flush broadcasts correct numbers. `playing` is
  unaffected (it's read from the DB). No persistence of the online set —
  by design; cross-restart presence is a non-goal.
- **Multi-instance (Cloud Run >1 container).** Each instance only sees
  its own sockets, so `online` is per-instance and **undercounts**
  globally. **OPEN / known limitation:** acceptable for beta (single
  instance / low concurrency). The real fix (Redis pub/sub or a shared
  presence store) is out of scope and belongs with a future infra slice
  (011 touches per-game infra but not presence fan-out). Flag to user
  before any production scale-out.
- **Flush task crash.** If `_flush` raises (e.g. transient DB error),
  catch-log-continue and leave `_dirty` set so the next tick retries —
  never let the loop die silently (Hard Rule #4: no catch-and-ignore;
  here it's catch-log-retry).
- **`mark_dirty()` from a sync context.** Game lifecycle handlers are
  async; `mark_dirty()` is sync (just sets a flag + ensures a task), safe
  to call from anywhere without `await`.

## Build sequence

1. Land **002** (transport, manager, envelope, snapshot/broadcast
   primitives, `presence.*` namespace). Blocking.
1. Add `online_user_ids()` to 002's manager if absent (003 PR).
1. Implement `api/app/services/presence.py` + unit-test `playing_count()`
   and the coalescing loop against a fake manager.
1. Wire `PresenceService` into `main.py` lifespan; wire connect/disconnect
   hooks + snapshot in 002's WS router.
1. Add `mark_dirty()` calls at the four `multiplayer.py` lifecycle points.
1. Build `frontend/src/hooks/usePresence.ts` against the 002 socket.
1. pytest (the 7 cases above); browser-verify at
   `https://dev.gomoku.games` per Hard Rule #2 (open two tabs, watch the
   number change) before push.
1. Hand the contract to **007** (modal) and **004** (online-user-id set);
   leave the Cypress stub for **012**.

## Flags

- **OPEN: AI games in "playing"** — defaulting to *exclude*. Needs a
  product yes/no; one-line `UNION` to flip.
- **OPEN: snapshot reads live SQL vs last cached tuple** — live for now;
  switch to cached only if connect-storm SQL shows up in traces.
- **OPEN: multi-instance global presence** — undercounts across Cloud Run
  instances; deferred to a future infra slice.
- **ASSUMPTION:** 002 exposes manager `online_count`/connected user-id
  set, `broadcast`, per-socket send, and connect/disconnect hooks, and
  reserves `presence.*`. If 002 ships a different surface, only
  `presence.py` + the two hook call-sites change.
- **ASSUMPTION:** a user is in at most one active multiplayer game, so the
  `DISTINCT` union can't double-count a person across two games.
