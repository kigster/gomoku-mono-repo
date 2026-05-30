# WebSocket Migration Plan

> **Status:** draft for review — no code changes yet.
> **Author/date:** 2026-05-27.
> **Scope:** replace REST polling for multiplayer + chat + presence with
> server-pushed events over a single WebSocket per authenticated session.

## 1. Why now

Today every "did anything change?" loop in the frontend is a poller hitting
FastAPI on a fixed cadence:

| Concern | Endpoint | Cadence | Driver |
| ---------------------- | ----------------------------------------- | ----------------------- | -------------------- |
| Incoming invites | `GET /chat/incoming` | 5 s | `InviteAcceptModal` |
| Multiplayer game state | `GET /multiplayer/<code>?since_version=N` | 300 ms → 5 s tiered | `useMultiplayerGame` |
| Chat messages | `GET /chat/<code>/messages?since=N` | piggybacks on game poll | `useChatMessages` |
| Presence / `/who` | `GET /social/online` | on demand | chat slash-command |

Polling is what made the two bugs from the latest report possible:

**Bug A — duplicate invite modal.** `InviteAcceptModal` polls `/chat/incoming`
every 5 s. The dismissed-code set lives in a component ref — if the user
manages to create two `waiting` rows targeting the same guest (slow network +
retry, dev-mode strict effect double-fire, two clicks), the modal pops once
per row because the ref only suppresses codes the modal has already shown.
There is no server-side notion of "this invite was already presented to the
recipient." The polling design _cannot_ distinguish "new invite from same
person" from "redelivered invite I already accepted."

**Bug B — inviter never sees the acceptance.** The slash-command `/invite`
flow has no follow-up poll on the inviter's side. The recipient navigates to
`/play/<code>` and auto-joins (state flips `waiting → in_progress`), but the
inviter's tab never asks. The recipient's game is live, the inviter is still
staring at the chat panel with no idea anything happened.

Push semantics fix both for free:

- The server has authoritative knowledge of "this invite was delivered to
  this connected client" and can mark it as such. No duplicate dialogs.
- The state transition is published once, both sides receive it once. The
  inviter is notified in the same tick as the recipient.

Polling will continue to work as a degraded fallback (see §6.4), but it stops
being the primary correctness mechanism.

## 2. Architecture at a glance

```
                              ┌──────────────┐
   Browser ── wss:// ───────► │ FastAPI inst │ ──┐
                              └──────────────┘   │
                              ┌──────────────┐   │     ┌─────────┐
   Browser ── wss:// ───────► │ FastAPI inst │ ──┼───► │  Redis  │
                              └──────────────┘   │     │ pub/sub │
                              ┌──────────────┐   │     └────┬────┘
   Browser ── wss:// ───────► │ FastAPI inst │ ──┘          │
                              └──────────────┘              │
                                     ▲                      │
                                     └──── fan-out ─────────┘
```

- **Transport:** FastAPI's native `WebSocket` (Starlette under the hood).
  One persistent connection per authenticated browser tab.
- **Pub/sub:** Redis. We already run Redis locally (see CLAUDE.md "Local
  Resources"); on GCP we add a small Memorystore for Redis instance into
  the existing Cloud Run VPC connector.
  - Alternative considered: Postgres `LISTEN/NOTIFY`. Lower ops cost (no
    new service) and good enough for a board game, but ties one Postgres
    connection per FastAPI instance to a long-running listener and caps
    notify payloads at 8 KB. **Recommended: Redis** for headroom; we
    keep `LISTEN/NOTIFY` as the Plan B if Memorystore cost is unwanted.
- **Auth:** the existing JWT, sent during the `Sec-WebSocket-Protocol`
  handshake (or `?token=` query string as a fallback for environments that
  strip headers). Validated once on connect; the connection is closed on
  expiry rather than refreshed mid-stream (clients reconnect with a fresh
  token after the standard `/auth/login` cycle).
- **Connection registry:** in-process per-instance map of
  `user_id → set[WebSocket]` and `subscription → set[WebSocket]`.
  Subscriptions are channel names like `game:<code>`, `user:<id>:invites`,
  `presence`.

Cloud Run notes:

- WebSockets are supported and billed for the full connection lifetime.
- Default idle timeout is **5 minutes**; we configure `--timeout=3600`
  (max 60 min) on the api service. Beyond that, the client reconnects
  transparently — see §6.3.
- Cloud Run does **not** offer sticky sessions, so any "broadcast to all of
  user X's tabs" message must go through Redis even if both tabs landed on
  the same instance. That's why pub/sub is mandatory rather than optional.

## 3. Wire protocol

JSON frames, one event per message. No binary, no compression at the
application layer (Cloud Run handles TLS-level compression).

### Client → server

```ts
{ type: 'subscribe',   channel: 'game:ABCDEF' }
{ type: 'unsubscribe', channel: 'game:ABCDEF' }
{ type: 'ping',        ts: 1717000000000 }
```

The server bounces `ping` back as `pong` (heartbeat for both sides — see
§6.3). All other state-changing actions stay on REST for simplicity (move
submission, resign, /invite, slash-commands). The WS is read-mostly from
the client's perspective; this keeps the existing routes as the canonical
write path and avoids re-implementing validation/auth on a second surface.

### Server → client

```ts
{ type: 'invite.incoming',
  payload: { code, host_username, expires_at, board_size } }

{ type: 'invite.expired',
  payload: { code } }

{ type: 'game.update',
  payload: { code, version, state, your_turn, board_diff, last_move, …} }

{ type: 'chat.message',
  payload: { code, id, speaker_username, message, created_at } }

{ type: 'presence.snapshot',
  payload: { users: OnlineUserEntry[] } }

{ type: 'presence.delta',
  payload: { username, state, opponent_username | null, last_seen_at } }
```

`game.update` carries a monotonically-increasing `version` (already on the
`multiplayer_games` row) so a client that missed frames during a reconnect
can request the slice it doesn't have via the existing `?since_version=N`
REST call. The reconciliation path is identical to today's polling code,
just triggered by "I just connected" instead of "300 ms elapsed."

## 4. Phased migration

Each phase ships independently. Polling stays on for the unmigrated
concerns; the frontend is the orchestrator that decides "use WS where
available, fall back to poll." This lets us roll back any single phase
without taking down the rest.

### Phase 0 — Pre-migration cleanup _(no WS code)_

Tighten the surface the WS code has to honour. Mostly already addressed
in the latest chat-simplification pass:

- Slash commands carry no user-typed messages. `/invite @user` returns a
  code which is echoed back into the inviter's transcript locally; the
  recipient sees a modal dialog only.
- `/who [@user @user]` — when usernames are passed, the response is
  filtered to those users (state from the view if present, `'offline'`
  otherwise). When none are passed, the existing paginated view is used.
  _(Backend: add `usernames=` query param to `GET /social/online`; expand
  the `OnlineUserEntry.state` Literal to include `'offline'`.)_
- Server-side dedupe for invite delivery: add
  `multiplayer_games.invite_delivered_at TIMESTAMPTZ NULL`. `/chat/incoming`
  stamps it on first read; subsequent reads from the same recipient skip
  rows already stamped — this kills Bug A even before WS lands.

### Phase 1 — WS foundation

`api/app/routers/ws.py`:

```python
@router.websocket("/ws")
async def ws_endpoint(
    websocket: WebSocket,
    token: str = Query(...),       # or extracted from Sec-WebSocket-Protocol
):
    user = await authenticate_jwt(token)     # raises -> close 4401
    await websocket.accept()
    conn = await registry.add(user.id, websocket)
    try:
        await registry.send(conn, {"type": "ready", "user_id": user.id})
        async for raw in websocket.iter_text():
            await handle_client_frame(conn, raw)
    finally:
        await registry.remove(conn)
```

Deliverables:

1. `app/realtime/registry.py` — per-instance connection table, indexed by
   user id and subscription channel.
1. `app/realtime/bus.py` — thin wrapper over `redis.asyncio.Redis` with
   `publish(channel, event)` and an instance-level subscriber task that
   listens to every channel any local connection is subscribed to and
   pushes events back through the registry.
1. Heartbeat: client sends `ping` every 25 s, server replies `pong`.
   No `pong` for 60 s → server closes.
1. Frontend: `src/realtime/wsClient.ts` — a single shared WS per tab,
   auto-reconnect with exponential backoff (250 ms → 8 s capped),
   exposes a `subscribe(channel, handler)` API.
1. Health endpoint: `GET /health/ws` returns the local connection count
   so dashboards can chart it.

Acceptance: a manual `wscat`-style test sees `ready` on connect and a
`pong` per `ping`. No feature behaviour changes.

### Phase 2 — Invite acceptance push _(replaces `/chat/incoming` polling)_

Smallest possible feature so we shake out the foundation against real UX.

- Backend: when `/chat/invite` allocates a game, also
  `bus.publish('user:<intended_guest_id>:invites', invite.incoming)`.
- Frontend: `InviteAcceptModal` subscribes to its own user's invite
  channel on mount; the existing `/chat/incoming` poll runs at a much
  slower cadence (60 s) as a reconciliation safety net.
- Server-side dedupe (Phase 0 dependency) means the publish marks the
  row as `invite_delivered_at = now()` inside the same transaction.
  Bug A is gone.

Acceptance: in a two-tab test, bob types `/invite @kig` and within
200 ms kig's modal renders. Accepting once never shows the modal a
second time even if a reconciliation poll fires.

### Phase 3 — Game state push _(replaces `/multiplayer/<code>` polling)_

The big one. The polling cadence schedule
(`frontend/src/hooks/pollingSchedule.ts`) goes away.

- Backend: every write path that updates a `multiplayer_games` row
  (`join`, `move`, `resign`, `cancel`, lazy-expiry sweep) ends with a
  `bus.publish('game:<code>', game.update)`. The payload mirrors what
  `GET /multiplayer/<code>` would have returned at that `version`.
- Frontend: `useMultiplayerGame` subscribes to `game:<code>` on mount,
  uses the same reducer it uses today for poll responses. On reconnect,
  it issues one REST `GET /multiplayer/<code>?since_version=<last>` and
  merges the result before resuming the live stream.
- Bug B is gone: the inviter (who never navigated to `/play/<code>`)
  also subscribes to `game:<code>` for games they host or were invited
  to. On `state: waiting → in_progress`, the App decides whether to
  redirect to `/play/<code>` or surface a "your invite was accepted"
  affordance.

Acceptance: a Cypress test that moves on tab A and asserts the move
appears on tab B within 250 ms p95.

### Phase 4 — Chat push _(replaces `/chat/<code>/messages` polling)_

Trivial after Phase 3 since chat already piggybacks on the game's
polling lifecycle.

- Backend: `POST /chat/<code>/messages` publishes
  `chat.message` to `game:<code>` after insert.
- Frontend: `useChatMessages` subscribes to the same channel, drops the
  poller, keeps the same "merge by id, sort by created_at" reducer.

Acceptance: messages typed in one tab appear in the other within
200 ms; no duplicate-id rows.

### Phase 5 — Presence push _(replaces `/social/online` polling)_

`/social/online` becomes the snapshot endpoint (initial load and
recovery only). Live deltas come over a `presence` channel.

- Backend: every `get_current_user` bump of `last_seen_at` publishes a
  `presence.delta` if the user's `state` (per the `online_users` view)
  changed OR if the time since the last publish exceeds 30 s. Plain
  heartbeats coalesced server-side to keep the channel calm.
- Frontend: the `/who` button does a one-shot REST fetch for the
  visible list, then subscribes to `presence` and patches in deltas.
  Per-user filtering (Phase 0's `/who @user @user`) is handled by the
  delta-handler reading the same shape.

Acceptance: kig logs in, bob's `/who` list shows kig within 1 s
without bob refreshing or clicking anything.

### Phase 6 — Cleanup

After Phases 2–5 have soaked for ≥ 1 week in production:

- Drop `pollingSchedule.ts` and the cadence-tiering logic.
- Drop the slow reconciliation poll on `/chat/incoming` (keep the
  endpoint itself; useful for clients without WS support).
- Inline the now-dead "first-load + reconcile" REST calls into a single
  helper.
- Document the WS contract in `doc/realtime-protocol.md`.

## 5. Schema / migration work

Minimal — the existing tables already carry the version columns we need.

1. `ALTER TABLE multiplayer_games ADD COLUMN invite_delivered_at TIMESTAMPTZ NULL` (Phase 0).
1. `ALTER TYPE online_state ADD VALUE 'offline'` _(only if we represent
   state as a Postgres enum — currently a string CHECK, so no migration
   needed beyond a CHECK relaxation; double-check before writing)._
1. Index: `multiplayer_games (host_user_id, state) WHERE state IN ('waiting','in_progress')` already exists — reuse for
   the inviter-subscribes-to-their-game lookup.

No data backfill. The schema additions are nullable / additive.

## 6. Risks & open questions

### 6.1 Cloud Run idle disconnect

Default 5 min idle disconnects every WS. With our 25 s heartbeat the
connection is never idle from Cloud Run's perspective, but we still
configure `--timeout=3600` so a maxed-out connection survives an
hour-long game without surprise drops. Beyond that, the client
reconnects and resyncs (Phase 3 recovery path).

### 6.2 Connection ceiling

Cloud Run defaults to **1000 concurrent connections per instance**. At
two tabs per player and 50 players online that's 100 — fine. If we
grow past ~400 concurrent users we configure
`--concurrency=80 --max-instances=N` and let Cloud Run scale; pub/sub
fan-out means it doesn't matter which instance a tab lands on.

### 6.3 Reconnect storms on deploy

`just deploy` rolls instances. Without care, all clients reconnect in
the same second and hammer the new instance with `GET /multiplayer/<code>?since_version=N` reconciles. Mitigation:

- Client-side jittered backoff (250 ms × random[0.5–1.5]).
- Server replies to `ready` with a `reconnect_token` and clients send
  it on re-connect; instances can rate-limit reconciliations per token.
- Optional: deploy with Cloud Run's gradual rollout (10% / 50% / 100%).

### 6.4 Fallback for blocked environments

Some corporate proxies block WS upgrades. The frontend keeps the
existing REST poll code paths in place under a feature flag
`VITE_USE_WS` (default true) and falls back if the WS handshake fails
three times. Polling stays a first-class supported mode; we just don't
optimise its cadence aggressively any more.

### 6.5 Testing surface

- New pytest fixture `ws_client` that wraps `httpx.AsyncClient` with
  a Starlette `TestClient.websocket_connect`. One fixture, ~40 lines.
- Vitest already exercises the chat hook; add a thin `MockWS` so
  per-hook tests can simulate frames without spinning up a server.
- Cypress: one new spec, two browsers (or two-tab harness), exercises
  the bob/kig flow end-to-end.

### 6.6 Memorystore vs LISTEN/NOTIFY (revisit before Phase 1)

If by the time we ship Phase 1 we don't already have other services
needing Redis, switching the pub/sub layer to `LISTEN/NOTIFY` is a
~1-day change that drops the Memorystore line item from the GCP bill.
Build `bus.py` against an abstract interface from day one so this
swap is mechanical.

## 7. Estimate

Working solo at the current pace, paid by calendar week:

| Phase | Effort | Notes |
| -------------- | -------------- | ------------------------------------------ |
| 0 — cleanup | ~½ week | Mostly already in flight in current branch |
| 1 — foundation | 1 week | Includes Redis wiring + Terraform |
| 2 — invites | ~½ week | Smallest feature; foundation shakedown |
| 3 — game state | 1 week | Biggest UX impact; needs Cypress soak |
| 4 — chat | ~½ week | Trivial after 3 |
| 5 — presence | ~½ week | Mostly delta plumbing |
| 6 — cleanup | ~½ week | Carve-out for documentation |
| **Total** | **~4.5 weeks** | Ships value at end of each phase |

## 8. What I'd want decided before writing any code

1. **Redis vs LISTEN/NOTIFY** (default: Redis; revisit before Phase 1).
1. **WS auth surface**: subprotocol header vs `?token=` query string.
   I lean subprotocol header for cleanliness; query string is easier
   to debug. Both are fine.
1. **Whether the inviter auto-redirects to `/play/<code>` on accept**,
   or surfaces a "@kig accepted — open the game" affordance and lets
   the inviter click. Affects the Phase 3 UX.
1. **Per-user concurrent-tab cap**. With Redis fan-out this is mostly
   a cost question; default proposal: no cap, but rate-limit each
   user-id's outbound frames at 50/s to prevent runaway.
