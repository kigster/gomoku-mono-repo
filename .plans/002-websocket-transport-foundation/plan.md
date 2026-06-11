# 002 — WebSocket transport foundation — plan

> Owner: Zeus (architecture). Verifier appendix: Jeff Dean.
> Spec: [`spec.md`](./spec.md).

## 1. Architecture

```
                       ┌─────────────────────────────────────────┐
   React (one tab)     │              gomoku-api (FastAPI)         │
  ┌──────────────┐     │                                           │
  │ useGameSocket│◀────┼── WS /ws ──▶ ws_router (app/routers/ws.py)│
  │  (pub/sub)   │     │                     │                     │
  └──────┬───────┘     │                     ▼                     │
         │             │       ConnectionManager (in-process,      │
         │ HTTP POST   │       keyed by user_id, asyncio-safe)     │
         │ /move       │                     ▲                     │
         ▼             │                     │ broadcast()         │
  ┌──────────────┐     │   make_move() ──────┘  game.update        │
  │ multiplayer  │────▶│   (multiplayer.py:513) after txn commit    │
  │   client     │     │                                           │
  └──────────────┘     └─────────────────────────────────────────┘
```

Key decisions:

- **One lobby-wide socket per user**, not per game. The connection manager is
  keyed by `user_id`; the game `code` is *not* part of the connection key. A
  `game.update` is delivered by looking up the host + guest `user_id`s on the
  mutated row and sending to whichever of them currently hold a socket.
- **In-process manager.** Per the umbrella spec ("ONE always-on API instance
  for up to 100 connections") in-memory state is acceptable. The scaling
  boundary is documented in §8 — and there is a **live config mismatch** that
  must be addressed before deploy (`api_max_instances` defaults to `5`).
- **The move POST stays HTTP and stays transactional.** WS is a *notification*
  side-effect fired *after* the DB transaction commits, never the source of
  truth. The authoritative state always comes from `multiplayer_games`.

## 2. Connection-manager design

New module `api/app/ws/manager.py`.

```python
# api/app/ws/manager.py  (sketch)
from __future__ import annotations
import asyncio
from collections import defaultdict
from starlette.websockets import WebSocket

class ConnectionManager:
    def __init__(self) -> None:
        # user_id -> set of live sockets (multi-tab / multi-device)
        self._conns: dict[str, set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def connect(self, user_id: str, ws: WebSocket) -> None:
        async with self._lock:
            self._conns[user_id].add(ws)

    async def disconnect(self, user_id: str, ws: WebSocket) -> None:
        async with self._lock:
            conns = self._conns.get(user_id)
            if conns:
                conns.discard(ws)
                if not conns:
                    self._conns.pop(user_id, None)

    def is_online(self, user_id: str) -> bool:        # for 003
        return bool(self._conns.get(user_id))

    def online_user_ids(self) -> set[str]:            # for 003
        return set(self._conns.keys())

    async def send_to_user(self, user_id: str, envelope: dict) -> None:
        targets = list(self._conns.get(user_id, ()))   # snapshot, lock-free
        dead: list[WebSocket] = []
        for ws in targets:
            try:
                await ws.send_json(envelope)
            except Exception:                           # closed mid-send
                dead.append(ws)
        for ws in dead:
            await self.disconnect(user_id, ws)

    async def broadcast_to_users(self, user_ids, envelope: dict) -> None:
        for uid in user_ids:
            await self.send_to_user(str(uid), envelope)
```

### Async-safety with asyncpg

- The manager touches **no DB connection**. asyncpg pool/connection objects are
  *not* shared into it; the manager only holds `WebSocket` handles and a
  `user_id` index. This sidesteps the asyncpg rule that a single `Connection`
  must not be used concurrently from two tasks.
- The broadcast in `make_move` runs **after** `async with conn.transaction()`
  exits and the pool connection is released (see §5) — so the send never
  contends with the DB connection that produced the row.
- Single-process FastAPI runs one event loop; the only concurrency is between
  coroutines on that loop. The `asyncio.Lock` guards the **mutating** dict ops
  (`connect`/`disconnect`); reads for fan-out take a list snapshot so a slow
  `send_json` never holds the lock while awaiting socket I/O. `send_json` is
  `await`ed sequentially — acceptable at ≤100 connections; if it becomes a
  bottleneck, wrap the loop in `asyncio.gather` (noted as an optional follow-up,
  not needed for this slice).

The manager is a **process-wide singleton** held on `fastapi_app.state.ws_manager`
(constructed in `lifespan`, alongside `db_pool`), retrieved by a
`get_ws_manager(request)` dependency mirroring `get_pool`.

## 3. WebSocket auth flow

FastAPI WebSockets do **not** run `BaseHTTPMiddleware`, so the JWT decode in
`RequestLoggingMiddleware` (request_logging.py:28-40) and the `get_current_user`
HTTP dependency (security.py:41) do not apply. We authenticate explicitly in the
endpoint, reusing the **same** `decode_token` helper.

Token delivery options (pick one; see OPEN below):

- **A. Subprotocol / first-message auth (chosen).** Accept the socket, then
  require the client's **first frame** to be `{"type":"auth","payload":{"token":...},"v":1}`.
  Decode with `app.security.decode_token`. On success → send `auth.ok` +
  register in the manager. On failure → send `auth.error` and `close(code=4401)`.
  This avoids putting the JWT in a URL query string (which lands in access logs
  and Honeycomb spans).
- **B. Query param `?token=`.** Simpler, but the token leaks into logs. Rejected.

```
client                          server (ws_router /ws)
  │ ── WS handshake ──────────▶ │  await ws.accept()
  │ ◀── hello {v:1} ─────────── │  (server greets, states it expects auth)
  │ ── auth {token} ──────────▶ │  payload = decode_token(token)
  │                             │  user_id = payload["sub"]
  │ ◀── auth.ok {user_id} ───── │  await manager.connect(user_id, ws)
  │ ── ping ──────────────────▶ │  (heartbeat loop begins)
  │ ◀── pong ────────────────── │
```

- **Auth expiry mid-socket:** the JWT `exp` is checked **only at handshake**.
  A long-lived socket is *not* force-closed when the token would have expired
  (PyJWT can't re-validate without a re-presented token). Mitigation: the
  client re-opens the socket on its normal reconnect path carrying a fresh
  token; and any **state-mutating** action still goes through HTTP, which *does*
  re-validate `exp` and returns 401, tripping the client's
  `onSessionExpired`. So an expired-but-open socket can only *receive* pushes,
  never act — an acceptable posture. **OPEN:** if 009's timers need to forcibly
  expire idle sockets, add a server-side max socket lifetime then.

## 4. Envelope schema

### Python (`api/app/ws/envelope.py`)

```python
from typing import Any, Literal
from pydantic import BaseModel

ENVELOPE_V = 1

class Envelope(BaseModel):
    type: str           # e.g. "game.update", "auth.ok", "ping"
    payload: dict[str, Any] = {}
    v: int = ENVELOPE_V

def make(type_: str, payload: dict[str, Any] | None = None) -> dict:
    return {"type": type_, "payload": payload or {}, "v": ENVELOPE_V}
```

### TypeScript (`frontend/src/lib/wsEnvelope.ts`)

```ts
export const ENVELOPE_V = 1;

export interface WsEnvelope<P = unknown> {
  type: string;          // "game.update" | "auth.ok" | "ping" | ...
  payload: P;
  v: number;             // envelope schema version (NOT game version)
}

// game.update payload is the exact MultiplayerGameView from multiplayerClient.ts
import type { MultiplayerGameView } from "./multiplayerClient";
export type GameUpdatePayload = MultiplayerGameView;
```

Note the deliberate naming split: envelope `v` (wire schema) vs. the
`version: number` field *inside* a `MultiplayerGameView` payload (optimistic-
concurrency counter on `multiplayer_games.version`). §9 explains how the latter
drives ordering and gap detection.

## 5. Move-POST → broadcast integration point

The hook point is the existing `make_move` handler in
`api/app/routers/multiplayer.py:513-589`. Today it:

1. opens `async with pool.acquire() as conn: async with conn.transaction():`
1. mutates via `mp_db.update_game_after_move(...)` → `updated_row`
1. (on win) writes Elo history rows
1. returns `_build_view(updated_row, host_username=…, guest_username=…, your_color=…)`

Integration (no behavior change to the HTTP response itself):

- After the `async with conn.transaction()` block **commits and the connection
  is released** (i.e. after the `async with pool.acquire()` block, just before
  the existing `return`), build the view for **each** participant and fan out:

```python
# after the transaction commits, before `return _build_view(...)`
mgr = request.app.state.ws_manager          # add `request: Request` param
host_id = str(updated_row.host_user_id)
guest_id = str(updated_row.guest_user_id)   # non-None: game is in progress

# host's view (your_color = host_color) and guest's view (opposite).
host_view = _build_view(updated_row, host_username=row.host_username,
                        guest_username=row.guest_username,
                        your_color=updated_row.host_color.value if updated_row.host_color else "X")
guest_view = _build_view(updated_row, host_username=row.host_username,
                         guest_username=row.guest_username,
                         your_color=_opposite_color(updated_row.host_color.value if updated_row.host_color else "X"))
await mgr.send_to_user(host_id, envelope.make("game.update", host_view.model_dump(mode="json")))
await mgr.send_to_user(guest_id, envelope.make("game.update", guest_view.model_dump(mode="json")))
```

Why per-participant views: `MultiplayerGameView` carries `your_color` /
`your_turn`, which differ per recipient. Reusing `_build_view` (multiplayer.py:113)
guarantees the pushed payload is byte-identical to what `GET /multiplayer/{code}`
returns, so the client can treat a `game.update` and a poll response
interchangeably (critical for R8 fallback).

**Best-effort semantics:** the broadcast is wrapped so a WS failure never fails
the HTTP move. The move already succeeded transactionally; the recipient who
missed the push will catch up via poll-fallback or reconnect-resync (§9). Do
**not** move the broadcast inside the transaction — a socket send must not be
able to roll back a committed move, and holding the pool connection during
socket I/O violates the asyncpg single-use rule.

**Also reuse the same hook in** `resign_game` (multiplayer.py:592) and `join_game`
(`game.update` when the game transitions `waiting → in_progress`) so both screens
update without polling. `cancel_game` likewise pushes a `game.update`. These are
the "more than one screen" mutations the umbrella spec targets. (Scope note:
wiring resign/join/cancel is small and belongs here since it's the same
primitive; chat/invite/match stay out.)

## 6. Client hook + reconnect/backoff

New file `frontend/src/hooks/useGameSocket.ts`. A single module-level singleton
socket (not one-per-component) so every screen shares one lobby-wide connection.

Design:

- **Open on login.** Driven by the `gomoku_auth_token` in `sessionStorage`
  (key `TOKEN_KEY`, App.tsx:45). Opening is triggered from `App.tsx` once a
  token exists; closing on logout (`removeItem(TOKEN_KEY)`).
- **URL.** `new WebSocket(wsUrl())` where `wsUrl()` maps `VITE_API_BASE`
  (multiplayerClient.ts:5) http→ws / https→wss, path `/ws`. Empty base ⇒
  same-origin `wss://<host>/ws`.
- **Auth.** On `onopen`, send `{type:"auth",payload:{token},v:1}` as the first
  frame (per §3-A).
- **Pub/sub dispatch.** `subscribe(type, handler)` returns an unsubscribe fn;
  inbound envelopes are routed by `type` (and namespace prefix for `chat.*`
  etc.). Returns `{ status, subscribe, send }`.
- **Heartbeat.** Client sends `ping` every ~25 s (under Cloud Run's idle/timeout
  ceiling, §8); a missed `pong` within N s marks the socket unhealthy and
  triggers reconnect.
- **Reconnect with exponential backoff + jitter:** `min(30s, base * 2^attempt)`
  with `base=500ms` and ±20% jitter; reset on a clean `auth.ok`. Stop
  permanently on `auth.error` close code `4401` (let App surface re-login).
- **Resync on reconnect (R8/R10).** On every successful (re)connect, emit a
  `socket:reconnected` event; the active game screen responds by calling the
  existing `getGame(token, code)` once to reconcile any `game.update` missed
  while disconnected. This is the message-loss safety net.

Migration of existing hooks (R8):

- `useMultiplayerPolling.ts`: keep the poll loop but **gate its cadence** — when
  `useGameSocket` reports `status === "open"`, slow the poll to a long
  safety-net interval (e.g. 15 s) and let `game.update` drive the fast path;
  when the socket is down, fall back to the current tiered schedule. The hook
  subscribes to `game.update` and folds the payload through its existing
  `setGame` + `versionRef` path (same shape as a poll result).
- `sendMove` stays exactly as-is (HTTP `postMove`). The server's broadcast will
  also echo the mover their own `game.update`; the client dedupes by `version`
  (no-op if it already has that version from the POST response).

## 7. Files changed (real paths / names verified)

| File | Change |
| ---- | ------ |
| `api/app/ws/__init__.py` | new package |
| `api/app/ws/manager.py` | `ConnectionManager` (singleton on `app.state.ws_manager`) |
| `api/app/ws/envelope.py` | `Envelope` model + `make()` + `ENVELOPE_V` |
| `api/app/routers/ws.py` | `ws_router`; `@ws_router.websocket("/ws")` handler: accept → auth (`decode_token`) → register → heartbeat/dispatch loop → disconnect in `finally` |
| `api/app/main.py` | construct `ws_manager` in `lifespan` (next to `db_pool`, main.py:29); `include_router(ws.router)` (next to main.py:82-89); add `get_ws_manager` dep helper |
| `api/app/routers/multiplayer.py` | add `request: Request` to `make_move`/`resign_game`/`join_game`/`cancel_game`; after-commit `game.update` broadcast reusing `_build_view` (line 113); best-effort wrapper |
| `frontend/src/lib/wsEnvelope.ts` | envelope TS types |
| `frontend/src/hooks/useGameSocket.ts` | singleton WS hook (open/auth/heartbeat/backoff/pubsub/resync) |
| `frontend/src/App.tsx` | open socket when `TOKEN_KEY` present (App.tsx:45,122), close on logout (App.tsx:105,611) |
| `frontend/src/hooks/useMultiplayerPolling.ts` | subscribe to `game.update`; throttle poll when socket open; resync on reconnect |
| `api/tests/` (pytest) | new `test_ws_transport.py` (see §10) |

No new DB migration is required for this slice (heartbeat reuses the existing
`users.last_seen_at` column + `POST /users/me/seen` path; 003 owns presence
storage). `app.security.decode_token`, `settings.jwt_secret`,
`settings.jwt_algorithm` are reused unchanged.

## 8. Cloud Run / WS caveats

| Concern | Reality | Action |
| ------- | ------- | ------ |
| **Idle timeout** | Cloud Run request timeout caps a streamed connection; WS counts as one long request. Default 300 s; max 3600 s. | Set the api service `timeout` high (e.g. 3600 s) **and** client heartbeat < idle window (25 s ping). Currently `iac/cloud_run/main.tf` api block (line 131-252) sets **no** `timeout` (defaults to 300 s) — must add one. |
| **Session affinity** | In-memory manager requires the same client to keep hitting the **same instance** for its socket, and broadcasts only reach users on **the same instance** as the broadcaster. | Cloud Run `session_affinity` only pins by client; it does **not** make two *different* users land on the same instance. The real guarantee comes from single-instance (below). |
| **Concurrency** | api `max_instance_request_concurrency = 80` (main.tf:251). A WS is one long-lived request, so ≤80 concurrent sockets per instance — fine for the ≤100 target only if essentially one instance. | Acceptable at target load; revisit if sockets approach 80. |
| **Single-instance assumption** | The spec assumes ONE always-on api instance. | **CRITICAL MISMATCH:** `var.api_max_instances` **defaults to 5** (`iac/cloud_run/variables.tf`, used at main.tf:143) and `api_min_instances` to 1. With max=5, two players can land on different instances and **never receive each other's `game.update`** — broadcasts are process-local. **Must pin `api_max_instances = 1` for production** in this slice's deploy, and document it as a hard constraint. |
| **What breaks at >1 instance** | In-process fan-out is process-local: a move handled on instance A cannot push to a socket held on instance B. | Out of scope to fix here. The cross-instance fix (deferred to a later infra task, see 011) is a shared bus: **Postgres `LISTEN/NOTIFY`** (no new infra; matches the no-SQLAlchemy/raw-asyncpg style) or Redis pub/sub (redis already runs locally). Until then, `api_max_instances = 1` is a **deploy gate**, and the GET-resync fallback (§9) is the only thing that keeps a mis-routed user eventually-consistent. |

## 9. Risks & edge cases

- **Message loss on reconnect → GET resync.** A `game.update` sent while the
  client socket was down is gone (no server-side replay buffer in this slice).
  Mitigation R8/R10: every reconnect triggers one `getGame(token, code)` on the
  active screen to reconcile. The poll-fallback (throttled, not removed) is the
  backstop if even that fails.
- **Ordering vs `version`.** WS delivery order is not guaranteed across a
  reconnect, and the POST-response view + the echoed broadcast view race. The
  client treats `MultiplayerGameView.version` as the monotonic truth: **apply a
  `game.update` only if its `version` > the currently-held version**; drop
  stale/duplicate frames. This makes the mover's own echo idempotent.
- **Auth expiry mid-socket.** Covered in §3 — socket can only receive after
  expiry; all mutations re-validate over HTTP.
- **Dropped / half-open sockets.** `send_to_user` removes any socket that raises
  on `send_json`; the heartbeat detects a silent peer and the manager prunes it
  on `disconnect` (called in the handler's `finally`). No zombie entries.
- **Best-effort broadcast must never fail the move.** Wrapped in try/except;
  logged, not raised (§5).
- **Multi-tab.** Manager stores a *set* of sockets per user, so two tabs both
  get the push; each tab's hook dedupes by `version`.
- **Self-DoS via reconnect storms.** Backoff + jitter + permanent stop on
  `4401` prevent a hot loop against an auth-failing endpoint (mirrors the
  polling hook's existing 401 stop, useMultiplayerPolling.ts:90-95).

## 10. Test plan

- **pytest (Starlette `TestClient.websocket_connect`)** in
  `api/tests/test_ws_transport.py`:
  - `test_ws_requires_auth`: connecting and sending a bad/expired token →
    `auth.error` + close `4401`.
  - `test_ws_auth_ok`: valid JWT (minted with `create_token`, security.py:23) →
    `hello` then `auth.ok` with the right `user_id`.
  - `test_ping_pong`: client `ping` → server `pong`.
  - `test_move_broadcasts_game_update`: two clients (host + guest) connect &
    auth on one app instance; host `POST /multiplayer/{code}/move`; assert
    **both** sockets receive a `game.update` whose payload `version` matches the
    POST response and whose `your_color`/`your_turn` are correct per recipient.
    This is the unit-level analogue of the 012 two-browser assertion.
  - `test_broadcast_survives_dead_socket`: one of two sockets is closed before
    the move; the move still 200s and the live socket still gets its update.
- **vitest** (`frontend/src/__tests__/useGameSocket.test.tsx`): mock `WebSocket`;
  assert auth-first-frame, ping cadence, backoff schedule, pub/sub dispatch,
  and `socket:reconnected` → resync callback.
- **Cypress (012, downstream):** two browsers, one move, both boards update via
  push — this plan's `test_move_broadcasts_game_update` is the contract 012
  asserts end-to-end. Not owned here, but the wire shape is frozen here.

## 11. Build sequence (checklist)

1. [ ] `api/app/ws/envelope.py` — `Envelope` + `make()` + `ENVELOPE_V`.
1. [ ] `api/app/ws/manager.py` — `ConnectionManager` + pytest for connect/
   disconnect/send/dead-socket pruning.
1. [ ] `api/app/main.py` — build `ws_manager` in `lifespan`; add
   `get_ws_manager`; register `ws.router`.
1. [ ] `api/app/routers/ws.py` — `/ws` handler: accept → first-frame auth via
   `decode_token` → register → heartbeat/dispatch loop → `finally`
   disconnect.
1. [ ] pytest §10 server tests (lifecycle + ping/pong).
1. [ ] `api/app/routers/multiplayer.py` — add `request: Request`; after-commit
   best-effort `game.update` broadcast in `make_move` (then `resign_game`,
   `join_game`, `cancel_game`).
1. [ ] pytest `test_move_broadcasts_game_update` + dead-socket variant.
1. [ ] `frontend/src/lib/wsEnvelope.ts` — envelope types.
1. [ ] `frontend/src/hooks/useGameSocket.ts` — singleton socket, auth,
   heartbeat, backoff, pub/sub, resync event.
1. [ ] `frontend/src/App.tsx` — open on token present, close on logout.
1. [ ] `frontend/src/hooks/useMultiplayerPolling.ts` — subscribe to
   `game.update`, throttle poll while socket open, resync on reconnect.
1. [ ] vitest `useGameSocket` test.
1. [ ] **IaC gate:** set api `timeout = 3600` and **pin
   `api_max_instances = 1`** for production in `iac/cloud_run`
   (main.tf api block / variables.tf default). Without this, push is
   silently broken in prod.
1. [ ] Browser-test two sessions at `https://dev.gomoku.games`: one move,
   both boards update without waiting a poll tick.

______________________________________________________________________

## Verifier notes (Jeff Dean)

1. **The single-instance assumption is not currently true in IaC.**
   `var.api_max_instances` **defaults to 5** (`iac/cloud_run/variables.tf`,
   consumed at `main.tf:143`) and there is **no** request `timeout` on the api
   service (defaults to 300 s). Both must be fixed *in this slice* or the
   feature is dead-on-arrival in production: a 300 s socket gets cut every 5
   min, and with 5 instances two players routinely never share a process. Build
   step 13 is **blocking**, not optional. **OPEN:** does production also front
   the api with the load balancer at `main.tf:290+`? Confirm the LB/Cloud Run
   path passes `Upgrade: websocket` (Cloud Run does; a misconfigured custom
   domain mapping can strip it). Verify in browser-test (step 14).

1. **WS bypasses ALL middleware** (`BaseHTTPMiddleware` does not run for
   websockets). That means no `RequestLoggingMiddleware` JWT decode (fine — we
   decode in-handler) **and no `ClientIPMiddleware`** (main.tf wrap at
   main.py:116) **and no telemetry span** from `instrument_app`. Hard Rule #1
   says telemetry is mandatory. **Action:** emit a manual OTel span around the
   socket lifecycle and around each broadcast, or explicitly document with the
   user that long-lived sockets are traced per-event, not per-request. Don't
   ship a transport that's invisible to Honeycomb.

1. **`broadcast_to_users` awaits sends sequentially.** At 100 connections a slow
   client backpressures the move handler's tail latency. Since the broadcast is
   after-commit and best-effort, prefer firing it via `asyncio.create_task` so
   the HTTP response returns immediately and a stuck socket can't delay the
   mover's 200. Trade-off: a task that outlives the request loses the request
   span context — tie it to note #2's manual span. **Recommend:** create_task +
   manual span.

1. **`guest_user_id` can be `None`.** In `make_move`/`resign` the game is
   `in_progress` so a guest exists, but the §5 sketch fanning out to
   `guest_id = str(updated_row.guest_user_id)` will produce the string
   `"None"` if ever called pre-join. Guard it; for `join_game` the guest *just*
   became non-None, for `cancel_game` (a `waiting` game) there is **no guest** —
   only push to the host. Don't blindly fan out to two ids everywhere.

1. **Echo-to-self ordering.** The mover gets both the POST response *and* a
   pushed `game.update` for the same `version`. The `version`-gate (apply only
   if newer) handles it, but make sure `useMultiplayerPolling.sendMove`
   (useMultiplayerPolling.ts:148) sets `versionRef` from the POST response
   *before* the echo can arrive, or the echo will momentarily look "newer than
   null". Initialize `versionRef` eagerly.

1. **Resync thundering herd.** If the single instance restarts (deploy), every
   client reconnects and each fires a `getGame`. At ≤100 users this is trivial,
   but note it so 004's lobby (which may add its own reconnect resync) doesn't
   multiply it into a stampede. Stagger resync with the existing reconnect
   jitter.

1. **`auth.ok` race.** A client could send a feature message between `onopen`
   and `auth.ok`. Server must **buffer/reject** anything before successful auth
   (only `auth` is accepted first). State this as an invariant in `ws.py`.
