# 003 — Presence & realtime online counts

## Goal

When Gomoku first loads, show the player two live numbers — **how many
people are online** and **how many are currently playing** — and keep
those numbers up to date in real time without polling. The umbrella spec
phrases it as a load-time modal:

> [ 53 People Online, 23 Are playing ] — these numbers must be real time
> pushed via the websocket.

This slice owns the *data* behind those numbers and the *push* mechanism
that keeps them fresh. It does **not** own the modal's visuals (007) or
the websocket transport itself (002).

The authoritative "who is online right now" set produced here is also the
input to matchmaking (004), so it must be exposed cleanly as a set of
user ids, not just an aggregate count.

## Background — what exists today

Presence today is a `last_seen_at` heuristic, refreshed on every
authenticated HTTP request inside `get_current_user`, and surfaced through
the `online_users` SQL view (migration `0014`,
`api/db/migrations/versions/20260513-001000-online-users-view.py`) and the
`/social/online` + `/social/who` endpoints. A user "counts" as online if
their `last_seen_at` is inside an 8-hour window — i.e. as long as a tab
made a request recently. This is *lazy* and *stale*: it over-counts (a
tab that loaded 7 hours ago and went to lunch still counts) and lags
(nothing changes until the next poll).

With websockets (002) we get something far better: a **live connection**
is ground truth for "this person has Gomoku open right now."

## Requirements

### Realtime

- Whenever the online set changes — a socket connects, a socket
  disconnects, a multiplayer game starts, or a game ends — every
  connected client must receive an updated count **pushed** to it. No
  client-side polling for these numbers.
- A client that has *just* connected must receive the current numbers
  immediately (so the load-time modal shows real values, not zeros that
  fill in a second later).

### Accurate

- "Online" = a user who currently has at least one **live websocket
  connection** (per 002's connection manager). Not the `last_seen_at`
  heuristic. `last_seen_at` is retained as a fallback / analytics signal
  and for the existing `/social/*` endpoints, but it is **not** the
  source of truth for these counts.
- A user with **two tabs open** (two sockets) counts as **one** online
  person.
- "Playing" = the number of distinct users who are in an **in-progress
  game**. See **OPEN: AI games** below for exactly what "in-progress
  game" includes.
- `playing ≤ online` must always hold for what we push (a player who is
  in a game necessarily has a socket; if a game row says a user is
  playing but they have no socket, they are mid-reconnect and we still
  treat them as playing — see plan's edge cases).

### Cheap

- Steady-state cost must be near-zero. Counting "online" is an in-memory
  `len()` over the connection manager's keys — no DB. Counting "playing"
  must not turn every connect/disconnect into a table scan; the push is
  **coalesced** so we emit at most ~1 update per second regardless of how
  many events fire (mass reconnect after a deploy, a lobby of tabs
  refreshing, etc.).

## Wire payloads (reserved `presence.*` namespace from 002)

Both messages use 002's envelope `{ type, payload, v }`.

### `presence.snapshot`

Sent **once**, to a single client, immediately after that client's
socket authenticates and is registered. Carries the current numbers so
the load modal renders real data with no round-trip.

```jsonc
{
  "type": "presence.snapshot",
  "v": 1,
  "payload": { "online": 53, "playing": 23 }
}
```

### `presence.update`

**Broadcast** to all connected clients whenever the online or playing
count changes (coalesced to ≤ ~1/sec). Identical payload shape to the
snapshot — the only difference is snapshot is unicast-on-connect, update
is broadcast-on-change. A client treats both the same way (overwrite its
local counts).

```jsonc
{
  "type": "presence.update",
  "v": 1,
  "payload": { "online": 54, "playing": 23 }
}
```

`payload` is deliberately just the two integers. No per-user data crosses
the wire here — the online-user-id *set* that feeds matchmaking (004) is
consumed in-process on the server, never shipped to browsers.

## Non-goals

- **WS transport** (auth, connection manager, envelope, heartbeat,
  reconnect) — owned by **002**. This slice consumes 002's primitives.
- **The modal's layout / styling** — owned by **007**. This slice exposes
  a hook + a typed contract; 007 renders it.
- **Matchmaking pool selection / Elo filtering** — owned by **004**. This
  slice only guarantees a clean, in-process accessor for the live
  online-user-id set (and, by extension, "who is online and *not* in a
  game" = matchmakable).
- **Per-user presence dots / "@bob is online" indicators** — the existing
  `/social/online` + `/social/who` endpoints keep serving those off
  `last_seen_at`; we do not move them onto websockets in this slice.
- **Cross-process / multi-instance presence aggregation** — single
  in-process connection manager only (matches 002's stated scope). See
  the plan's "server restart / multi-instance" note for what breaks and
  why it's acceptable for now.

## Dependencies

- **002 — websocket transport foundation.** Hard dependency. This slice
  needs, from 002:
  - the in-process connection manager keyed by user id, exposing the set
    of currently-connected user ids (and `len`);
  - a `broadcast(type, payload)` primitive (envelope-wrapping handled by
    002);
  - a way to send a single message to one just-connected socket
    (for the snapshot);
  - connect / disconnect lifecycle hooks we can subscribe to.
  - the reserved `presence.*` type namespace.

## Consumers

- **004 — Elo matchmaking lobby.** Consumes the in-process live
  online-user-id set (minus users already in a game) to pick a match.
  This slice must expose that set without forcing 004 to reach into 002's
  internals.
- **007 — game-type modal redesign.** Consumes the frontend
  `usePresence()` hook and the `{ online, playing }` contract to render
  the load-time "[ N people online, M playing ]" modal.
- **012 — e2e two-human Cypress.** Drives two browsers and asserts the
  counts update live; this slice's test plan stubs the Cypress contract
  it will rely on.
