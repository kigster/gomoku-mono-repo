# Realtime WebSocket Push Architecture

## Goal

Replace REST polling for multiplayer game state, in-game chat,
incoming invites, and online presence with server-pushed events over
a single WebSocket per authenticated session. Polling continues to
work as a degraded fallback (Phase 6 / blocked-environment escape
hatch) but stops being the primary correctness mechanism.

## Motivation — bugs polling cannot fix

The current frontend runs four pollers:

| Concern | Endpoint | Cadence |
| ---------------------- | ----------------------------------------- | ----------------------- |
| Incoming invites | `GET /chat/incoming` | 5 s |
| Multiplayer game state | `GET /multiplayer/<code>?since_version=N` | 300 ms → 5 s tiered |
| Chat messages | `GET /chat/<code>/messages?since=N` | piggybacks on game poll |
| Presence / `/who` | `GET /social/online` | on demand |

Two recently reported bugs are intrinsic to that design:

- **Bug A — duplicate invite modal.** The dismissed-code set is a
  component ref, so two `waiting` rows targeting the same guest pop
  the modal twice. There is no server-side notion of "this invite
  was already presented to the recipient".
- **Bug B — inviter never sees the acceptance.** `/invite` has no
  follow-up poll on the inviter's side. The recipient navigates and
  auto-joins; the inviter's tab never asks.

Push semantics fix both:

- Server has authoritative knowledge of "this invite was delivered to
  this connected client" and can mark it as such.
- State transitions are published once; both sides receive once.

## Users and use cases

- **Players** mid-multiplayer-game: see opponent moves with < 250 ms
  p95 latency instead of waiting for the next tier of the polling
  schedule.
- **Inviters**: receive an in-tab notification the moment the
  recipient accepts an invite.
- **Chat participants**: messages arrive within ~200 ms.
- **Anyone querying `/who`**: presence deltas patch in without
  manual refresh.

## Architecture overview

- **Transport:** FastAPI's native `WebSocket` (Starlette under the
  hood). One persistent connection per authenticated browser tab.
- **Pub/sub:** **Redis** (Memorystore on GCP, local Redis already
  running for dev). `LISTEN/NOTIFY` documented as Plan B if
  Memorystore cost is unwanted.
- **Auth:** existing JWT, sent during `Sec-WebSocket-Protocol`
  handshake (or `?token=` query-string fallback). Validated once on
  connect; connection closes on expiry — clients reconnect with a
  fresh token.
- **Connection registry:** per-instance map of
  `user_id → set[WebSocket]` and `subscription → set[WebSocket]`.
  Channels: `game:<code>`, `user:<id>:invites`, `presence`.

Cloud Run constraints honoured: WS supported and billed for the full
connection lifetime; `--timeout=3600` configured; no sticky sessions
so "broadcast to all of user X's tabs" must go through Redis even
within a single instance.

## Wire protocol

JSON frames, one event per message. Client → server is read-mostly:
`subscribe`, `unsubscribe`, `ping`. State-changing actions stay on
REST (move submission, resign, `/invite`, slash-commands) so we don't
re-implement validation/auth on a second surface.

Server → client events: `invite.incoming`, `invite.expired`,
`game.update`, `chat.message`, `presence.snapshot`, `presence.delta`.

`game.update` carries a monotonic `version` (already on the
`multiplayer_games` row); a client that missed frames during reconnect
issues the existing `?since_version=N` REST reconcile and resumes
the live stream. **Reconciliation path is identical to today's
polling code, just triggered by reconnect instead of cadence.**

## Functional requirements

### Phase 0 — Pre-migration cleanup (no WS code)

- Slash commands carry no user-typed messages; `/invite @user` echoes
  code locally to the inviter, modal-only on recipient.
- `/who [@user @user]` filters by usernames when provided.
- Server-side dedupe: `multiplayer_games.invite_delivered_at`
  stamped on first read of `/chat/incoming`. Kills Bug A even before
  WS lands.

### Phase 1 — WS foundation

- `api/app/routers/ws.py` with single `/ws` endpoint, JWT-authed.
- `app/realtime/registry.py` — connection table indexed by user id
  and subscription channel.
- `app/realtime/bus.py` — Redis pub/sub wrapper with
  `publish(channel, event)` and instance-level subscriber task.
- Heartbeat: client `ping` every 25 s; no `pong` for 60 s → server
  closes.
- Frontend `src/realtime/wsClient.ts`: single shared WS per tab,
  auto-reconnect with jittered exponential backoff (250 ms → 8 s
  cap), exposes `subscribe(channel, handler)`.
- `GET /health/ws` returns local connection count.

### Phase 2 — Invite acceptance push

Replaces `/chat/incoming` polling. `/chat/invite` allocates the game
and publishes `invite.incoming` to `user:<intended_guest_id>:invites`.
`InviteAcceptModal` subscribes on mount; the existing poll runs at
60 s as a reconciliation safety net.

### Phase 3 — Game state push

Replaces `/multiplayer/<code>` polling — the polling cadence
schedule goes away. Every write path that updates a
`multiplayer_games` row publishes `game.update` to `game:<code>`.
`useMultiplayerGame` subscribes on mount, runs the existing reducer.
Bug B is gone: the inviter also subscribes to games they host or
were invited to.

### Phase 4 — Chat push

Replaces `/chat/<code>/messages` polling. `POST /chat/<code>/messages`
publishes `chat.message`. `useChatMessages` subscribes, drops the
poller.

### Phase 5 — Presence push

`/social/online` becomes the snapshot endpoint (initial load and
recovery only). Live deltas come over a `presence` channel; coalesced
server-side so plain heartbeats don't spam.

### Phase 6 — Cleanup

After Phases 2–5 have soaked for ≥ 1 week in production: drop
`pollingSchedule.ts`, drop the slow `/chat/incoming` reconciliation
poll, inline first-load + reconcile REST calls into a single helper,
document the WS contract in `reference/realtime-protocol.md`.

## Non-functional requirements

- p95 move-visible latency < 250 ms (Cypress assertion in Phase 3).
- Invite-modal latency on recipient < 200 ms (Phase 2 acceptance).
- WS auth validated on connect; failed handshake closes with `4401`.
- Reconnect storm protection: jittered backoff + optional
  `reconnect_token` returned on `ready` for server-side rate-limit.
- Blocked-environment fallback: `VITE_USE_WS` feature flag (default
  true); REST poll paths stay in place and re-engage after three
  failed WS handshakes.

## Quality criteria

- New pytest fixture `ws_client` wrapping
  `TestClient.websocket_connect` (~40 lines).
- Vitest `MockWS` for per-hook tests.
- New Cypress spec with a two-browser harness exercising the
  bob/kig flow end-to-end.
- `bus.py` built against an abstract interface from day one so
  swapping Redis ↔ `LISTEN/NOTIFY` later is mechanical.

## Open questions to settle before writing code

1. **Redis vs LISTEN/NOTIFY** — default Redis; revisit before
   Phase 1.
1. **WS auth surface** — subprotocol header (cleaner) vs `?token=`
   query string (easier to debug). Both fine.
1. **Inviter auto-redirect on accept?** — auto-jump to
   `/play/<code>`, or surface a "@kig accepted, open the game"
   affordance and let the inviter click. Affects Phase 3 UX.
1. **Per-user concurrent-tab cap** — default proposal: no cap, but
   rate-limit each user-id's outbound frames at 50/s.

## Schema work (minimal)

- `ALTER TABLE multiplayer_games ADD COLUMN invite_delivered_at TIMESTAMPTZ NULL` (Phase 0).
- Possible CHECK relaxation on `online_users` state to add
  `'offline'` (string CHECK today, no enum migration needed).
- Reuse existing partial index
  `multiplayer_games (host_user_id, state)  WHERE state IN ('waiting','in_progress')`.

## Estimate

| Phase | Effort | Notes |
| -------------- | -------------- | ---------------------------------------- |
| 0 — cleanup | ~½ week | Mostly in flight already |
| 1 — foundation | 1 week | Includes Redis wiring + Terraform |
| 2 — invites | ~½ week | Smallest feature; foundation shakedown |
| 3 — game state | 1 week | Biggest UX impact; Cypress soak required |
| 4 — chat | ~½ week | Trivial after 3 |
| 5 — presence | ~½ week | Mostly delta plumbing |
| 6 — cleanup | ~½ week | Documentation carve-out |
| **Total** | **~4.5 weeks** | Ships value at end of each phase |

## Status

**Draft — no code changes yet.** Plan dated 2026-05-27.

## Cross-references

- Full plan, wire protocol, risk analysis: `plan.md`.
- Underlying multiplayer flow:
  `.features/003.multiplayer-architecture-and-data-model.done/`.
- Final user-facing UX:
  `.features/006.web-multiplayer-invite-flow.done/`.
