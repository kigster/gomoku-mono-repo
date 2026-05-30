# Web Multiplayer Invite Flow

## Goal

Two authenticated users can play Gomoku against each other over a
shared invite link, with no WebSocket dependency. Both browsers
short-poll a single `multiplayer_games` row keyed by a 6-character
Crockford-base32 code; the API rejects out-of-turn or out-of-order
moves with optimistic concurrency.

## Users and use cases

- **Host** wants to create a game and send a friend a link/code.
- **Guest** wants to click a link or paste a code and land in the game
  with no extra setup beyond logging in.
- **Both** want the game state to survive page reloads and tab
  navigation (server is the source of truth).

## Functional requirements

### Host flow

1. Click **New Multiplayer Game** → "Choose Game Type" modal opens.
1. Pick **Another Player** — server creates the game immediately and
   the modal reveals:
   - "Who chooses the colour" (host / opponent)
   - "Which colour" (Black/X or White/O) — only when host chose
   - Copyable invite URL (`/play/<6-char-code>`)
   - Copyable bare code
   - **Start** button (greyed until opponent joins)
   - "Paste opponent's code" input
1. Share the link or code; it is valid for **15 minutes** with a
   live countdown.
1. When the opponent joins, **Start** lights up — click it (or wait
   for auto-navigate).

Changing the colour preference while waiting cancels the existing
invite server-side and creates a fresh one so the visible config
always matches the URL the guest receives.

### Guest flow

- **Via link** — visiting `/play/<code>` auto-fires
  `POST /multiplayer/<code>/join` with the JWT.
- **Via code** — open "New Multiplayer Game", paste into "Got an
  invitation?". **Join** lights up amber; click → land in the game.

When the host deferred colour choice, a small picker shows before the
join completes.

### Playing

- 15×15 board, SVG-rendered, same component as the AI flow.

- Each `POST /multiplayer/<code>/move` carries the version the client
  last saw; a stale version → 409, client refetches and retries.

- Both clients short-poll `GET /multiplayer/<code>?since_version=N`
  on a tiered schedule:

  | Elapsed | Interval |
  |---|---|
  | 0–10 min | 300 ms |
  | 10–30 min | 2 s |
  | 30–60 min | 3 s |
  | 60 min + | 5 s |

  Hard caps: 15 min for `waiting`, 8 h for `in_progress`.

- Resign is always available during play.

- Win / draw / resign writes **two `games` rows** (one per participant)
  cross-linked by `opponent_id`. Each user's `/game/history` lists the
  game.

### Lifecycle states

```
waiting --(guest joins)--> in_progress --(win/draw/resign)--> finished
   |                                                            ^
   |--(host cancels / 15-min expiry)--> cancelled               |
                                                                |
                                              (8-h cap)--> abandoned
```

- **Lazy expiry**: every read of an expired `waiting` row flips it
  in-line; no background sweeper required.
- **Code generation**: 6 chars from Crockford base32 (no I/L/O/U/0/1);
  collisions retried up to 8 times via per-attempt asyncpg savepoint.

### Rating

- Multiplayer games rate against the opponent's actual Elo (not an
  AI tier).
- Public leaderboard currently ranks **only** AI games; the
  multiplayer modal carries an explicit "humans-vs-AI only" note.

## Quality criteria

- Server validates **every** move (not your turn, square occupied,
  out of bounds, version conflict, not a participant) and returns a
  precise 4xx code per situation.
- E2E coverage: `frontend/cypress/e2e/multiplayer.cy.ts` drives the
  full flow under `just test-cypress`.

## Out of scope

- Public lobby / matchmaking.
- Spectators.
- Move-time limits (turn clock).
- In-game chat (separately shipped).
- WebSocket transport (separately planned).
- Renju / Caro / 19×19 (schema supports them; UI does not yet).

## Cross-references

- Implementation plan, API contract, polling protocol: `plan.md`.
- Original architecture and data model:
  `.features/003.multiplayer-architecture-and-data-model.done/`.
- UX of the invite modal:
  `.features/009.choose-game-type-modal-and-invite-link.done/`.
- Production hardening:
  `.features/008.multiplayer-pr-hardening-checklist.done/`.
