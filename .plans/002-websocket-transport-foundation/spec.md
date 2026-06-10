# 002 — WebSocket transport foundation

## Goal

Stand up a single authenticated, lobby-wide WebSocket transport for the API
that every future real-time feature rides on. This slice delivers the bare
transport — connection lifecycle, JWT auth, a typed message envelope, a
connection manager keyed by `user_id`, and the **first real consumer**:
pushing the full updated game JSON to both players after a move. Everything
else (presence counts, matchmaking, ready/color negotiation, chat semantics,
timers) is a downstream consumer of the primitives built here and is
explicitly out of scope.

This is the foundational task in the umbrella plan: it has **no upstream
dependencies** and unblocks tasks 003–012.

## Why WebSocket over polling

The current multiplayer flow is HTTP long-polling:

- `frontend/src/hooks/useMultiplayerPolling.ts` polls `GET /multiplayer/{code}`
  on a tiered cadence (`pollingSchedule.ts`: 300 ms → 2 s → 3 s → 5 s) using
  `since_version` + a `304 / {no_change:true}` short-circuit.
- `useMultiplayerHostPolling.ts`, `useChatMessages.ts` each add their own
  independent poll loop.

Problems this creates, which a push transport eliminates:

1. **Latency floor.** Even the fastest tier is 300 ms; an opponent's move can
   take up to a full poll interval to appear. Push delivers it on the next
   event-loop tick after the move commits.
1. **N independent loops per screen.** A player watching a game runs a game
   poll *and* a chat poll *and* (for the host) a lobby poll. The umbrella spec
   is explicit: *"Switch to websocket instead of polling for ALL events that
   broadcast/update more than one screen."* One socket per user replaces all
   of them.
1. **Wasted requests + devtools noise.** The `304` branch in
   `get_game` (multiplayer.py:472-489) exists *only* to make idle polls cheap
   and quiet — a workaround a push channel makes unnecessary.
1. **No idle channel.** Polling only runs while a game screen is mounted. The
   umbrella spec requires the socket to *"stay open whether or not a game is
   being played; when idle it receives invitations to play and passes
   decisions back."* That needs a lobby-wide, always-on connection — which is
   exactly this transport.

Polling is **not** ripped out in this slice. The move `POST` stays HTTP, and
the polling hooks are demoted to a **fallback / resync** path (see non-goals).

## Requirements

### Server

- **R1.** A FastAPI WebSocket endpoint (proposed `GET /ws`) that authenticates
  with the **same JWT** (same secret, algorithm, and `sub`/`username` claims)
  used by the HTTP API — `app.security.decode_token` /
  `app.config.settings.jwt_secret` / `jwt_algorithm`.
- **R2.** An in-process **connection manager** keyed by `user_id`, supporting
  multiple concurrent sockets per user (multiple tabs/devices), with
  `connect`, `disconnect`, `send_to_user`, and `broadcast_to_users`.
- **R3.** **One logical lobby-wide socket per user**, not per game. The socket
  is opened at login and lives for the whole session; it is not scoped to a
  game `code`.
- **R4.** A typed **JSON envelope** `{ type, payload, v }`. This slice
  implements **only** lifecycle message types (`hello`, `auth.ok`,
  `auth.error`, `ping`, `pong`, `heartbeat`) plus a generic
  `broadcast(type, payload)` server primitive. All downstream namespaces are
  *reserved and documented* but not implemented here.
- **R5.** **Game-state push.** After the existing `POST /multiplayer/{code}/move`
  handler (`make_move`, multiplayer.py:513) mutates `multiplayer_games`, the
  server broadcasts the **full updated game view** — the exact serializer used
  by `GET /multiplayer/{code}` (`_build_view`, multiplayer.py:113) — as a
  `game.update` envelope to **both** participants.
- **R6.** A **heartbeat** mechanism (client ping → server pong, or server
  keepalive) that (a) keeps the connection alive through Cloud Run's idle
  timeout and (b) exposes a hook 003 can use to feed `users.last_seen_at`
  presence. This slice wires the hook; 003 owns the presence semantics.

### Client

- **R7.** A single React hook `frontend/src/hooks/useGameSocket.ts`, opened on
  login (when the `gomoku_auth_token` is present in `sessionStorage`), kept
  open lobby-wide, with **reconnect + exponential backoff** and a
  publish/subscribe dispatch of inbound envelopes to feature subscribers.
- **R8.** **Migration, not replacement.** The polling hooks remain as a
  fallback that activates if the socket is closed/unhealthy, and as the
  authoritative **resync** path after a reconnect (a socket gap may have
  dropped a `game.update`; the client re-fetches `GET /multiplayer/{code}`).
  The move `POST` stays HTTP.

### Quality bar

- **R9.** Auth parity with HTTP: an expired/invalid token is rejected at the
  handshake the same way HTTP returns 401.
- **R10.** No silent message loss across the API boundary: ordering is
  reconciled via the existing `version` field, and any gap forces a GET
  resync rather than trusting socket order.
- **R11.** Pytest coverage of the WS lifecycle via Starlette's `TestClient`
  WebSocket support, including the move→`game.update` broadcast to two
  connected users.

## Non-goals

- **Presence counts / online list** — owned by **003**. This slice only
  exposes the heartbeat hook.
- **Matchmaking / lobby queue** — owned by **004**.
- **Ready / color negotiation** — owned by **005**.
- **Chat semantics** (in-game 1-1, post-game "Great game… closing in 3-2-1",
  channel open/close lifecycle) — owned by **006**. This slice only reserves
  the `chat.*` namespace.
- **Game timers / clocks** — owned by **009**.
- **Invitations end-to-end** (sending an invite, accept/decline round-trip) —
  the `invite.*` namespace is reserved here; the flow is owned by **004/005**.
- **Replacing the move POST with a WS message** — per the umbrella spec the
  move `POST` *stays HTTP* (it is the authoritative, transactional mutation);
  only the resulting state *push* is over WS.
- **Multi-instance fan-out** (Redis pub/sub, Postgres LISTEN/NOTIFY) — see the
  scaling-boundary note. In-process is acceptable under the single-instance
  assumption; cross-instance delivery is deferred.

## Reserved message-type namespace

This slice **implements** only the `lifecycle` rows and the `game.update`
broadcast. Every other row is a **reserved contract** — documented here so
downstream tasks slot into the envelope without renegotiating the wire format.

| Namespace | Example types | Direction | Implemented here | Owner |
| ------------ | ---------------------------------------------- | ---------------- | ---------------- | ----- |
| `lifecycle` | `hello`, `auth.ok`, `auth.error`, `ping`, `pong`, `heartbeat` | both | **Yes** | 002 |
| `game.*` | `game.update` | server → client | **Yes** (`game.update`) | 002 |
| `game.*` | `game.move_rejected`, `game.ended` | server → client | reserved | 005/009 |
| `presence.*` | `presence.online`, `presence.count` | server → client | reserved | 003 |
| `lobby.*` | `lobby.queue_joined`, `lobby.queue_left` | both | reserved | 004 |
| `match.*` | `match.found`, `match.ready`, `match.cancel` | both | reserved | 004/005 |
| `chat.*` | `chat.message`, `chat.opened`, `chat.closing`, `chat.closed` | both | reserved | 006 |
| `invite.*` | `invite.sent`, `invite.accept`, `invite.decline`, `invite.expired` | both | reserved | 004/005 |

Envelope shape (frozen contract): `{ "type": string, "payload": object, "v": int }`
where `v` is the **envelope schema version** (starts at `1`), distinct from the
game-state `version` carried *inside* a `game.update` payload.

## Dependencies

**None.** This is the foundational transport task. It only reuses existing,
shipped primitives: the JWT helpers in `app/security.py`, the per-request
session decode in `app/middleware/request_logging.py`, the `_build_view`
serializer in `app/routers/multiplayer.py`, and the asyncpg pool from
`app/database.py`.

## Downstream consumers

| Task | Consumes from 002 |
| ---- | ----------------- |
| 003 presence & online counts | heartbeat hook → `last_seen_at`; `presence.*` namespace; connection-manager membership as the online set |
| 004 elo matchmaking lobby | lobby-wide socket as the idle channel; `lobby.*` / `match.*` / `invite.*` namespaces; `broadcast_to_users` primitive |
| 005 match ready / color | `match.*` round-trip; `game.*` rejection types |
| 006 chat simplification | `chat.*` namespace over the same socket; in-game-only gating |
| 009 timed games | `game.*` timer/ended push; heartbeat cadence for clock sync |
| 012 e2e two-human cypress | asserts two browsers both receive a pushed `game.update` after one player moves |
