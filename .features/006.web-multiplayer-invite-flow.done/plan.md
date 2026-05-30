# 03 — Human vs Human on the Web

Two authenticated users can play each other over a shared invite link.
There is no websocket: both clients short-poll a single
`multiplayer_games` row keyed by a 6-character Crockford-base32 code,
and the API rejects out-of-turn or out-of-order moves with an
optimistic-concurrency version number.

## Starting a game (host's view)

1. Log in and click **New Multiplayer Game**. The "Choose Game Type"
   modal opens.
1. Pick **Another Player**. The moment that radio is selected the
   server creates the game and the modal renders:
   - Two extra radios — *who chooses the colour* (you or the
     opponent) and, if you chose, *which colour* (Black/X first or
     White/O).
   - Your invite URL with a copy button (`https://app.gomoku.games/play/AB7K3X`).
   - The bare 6-character code with its own copy button.
   - A **Start** button (large, greyed out until your opponent joins).
   - A "Paste opponent's code" input below.
1. Send the link or the code to your opponent (DM, SMS, anywhere).
   The link is valid for **15 minutes**; the modal counts the
   remaining time down.
1. When your opponent joins, the Start button lights up — click it
   to enter the game. (The modal also auto-navigates a beat later if
   you do nothing.)

If you change your colour preference while waiting, the existing
invite is cancelled server-side and a fresh one is created so the
URL the opponent sees always matches the visible config.

## Joining a game (guest's view)

A guest reaches the game one of two ways:

- **Click the host's link** — the SPA detects the
  `/play/<code>` route and auto-fires `POST /multiplayer/<code>/join`
  with the user's JWT. If the host let the guest pick the colour, a
  small picker shows first.
- **Paste the host's code** — open *New Multiplayer Game*, drop the
  code into the "Got an invitation?" input. The Start button greys
  out (you're joining, not hosting) and **Join** lights up amber.
  Click Join → land in the game.

Once both players are in, the SPA navigates to `/play/<code>` and the
in-game UI renders for both sides.

## Playing

The board is the same one used by the AI flow (15×15 by default,
SVG-rendered). Each `POST /multiplayer/<code>/move` submits the
move with the version number the client last saw; if the server's
version moved on (because the opponent moved meanwhile) the request
returns 409 and the client refetches and retries.

Both clients short-poll `GET /multiplayer/<code>?since_version=N` on
a wall-clock-tiered cadence
([`pollingSchedule.ts`](../frontend/src/hooks/pollingSchedule.ts)):

| Elapsed | Interval |
|---|---|
| 0–10 min | 300 ms |
| 10–30 min | 2 s |
| 30–60 min | 3 s |
| 60 min + | 5 s |

Hard caps: 15 min for `waiting` rooms, 8 h for `in_progress` games.
After the cap the SPA stops polling and surfaces "this game has
expired".

A win, draw, or resign moves the row to `state='finished'` and
records two `games` rows (one per participant) cross-linked by
`opponent_id`. The in-game panel then says either:

- *"@you wins against @opponent"* (winner), or
- *"Game Over"* + *"Lost to @opponent in N seconds."* (loser).

A **Resign** button is always available during play.

## Game lifecycle

```
waiting --(guest joins)--> in_progress --(win/draw/resign)--> finished
   |                                                            ^
   |--(host cancels / 15-min expiry)--> cancelled               |
                                                                |
                                              (8-h cap)--> abandoned
```

- **Lazy expiry**: every read of a `waiting` row past its
  `expires_at` flips it to `cancelled` in-line, no background
  sweeper.
- **Cancellation**: closing the modal while waiting calls
  `POST /multiplayer/<code>/cancel`.
- **Code generation**: 6 chars from the Crockford base32 alphabet
  (no `I/L/O/U/0/1`); collisions retried up to 8 times via a
  per-attempt asyncpg savepoint.

## Rating impact

Multiplayer games are rated against your opponent's actual Elo, not
against an AI tier. See
[doc/02-human-vs-ai-web.md → Scoring](../005.web-spa-ai-game-flow.done/plan.md#scoring-and-rating)
and [doc/gomocup-elo-rankings.md](../../reference/gomocup-bayesian-elo-system.md) for the
underlying formula and the BayesElo recalibration plan.

> The public leaderboard currently ranks **only** AI games (the modal
> says so explicitly). Multiplayer games show in your personal history
> and contribute to your Elo, but don't influence the leaderboard
> ordering yet.

## API endpoints

| Path | Purpose |
|---|---|
| `POST /multiplayer/new` | Create an invite (`host_color: null` defers colour to guest) |
| `POST /multiplayer/{c}/join` | Join — `chosen_color` required when host deferred |
| `POST /multiplayer/{c}/cancel` | Host marks the game `cancelled` |
| `GET  /multiplayer/{c}` | Polled with `?since_version=N`; returns 304 when no change |
| `POST /multiplayer/{c}/move` | Submit a move — server validates against `board_size` |
| `POST /multiplayer/{c}/resign` | End the game, opponent wins |

All endpoints require a `Authorization: Bearer <jwt>` header and the
caller must be a participant of the game.

## End-to-end testing

`frontend/cypress/e2e/multiplayer.cy.ts` drives the entire flow in
CI: signs up two random users, hosts as Alice (X), joins as Bob (O)
by visiting `/play/<code>`, alternates 9 moves through the SVG board
to a five-in-a-row Alice win, asserts the per-screen game-over copy,
and verifies the resulting `games` rows. Run it locally with:

```bash
just test-cypress    # restarts the cluster, then runs cypress
```

## See also

- [doc/multiplayer-modal-plan.md](../009.choose-game-type-modal-and-invite-link.done/plan.md) — modal
  UX spec.
- [doc/human-vs-human-plan.md](../003.multiplayer-architecture-and-data-model.done/plan.md) — original
  architecture and API contract.
- [doc/multiplayer-bugs.md](../008.multiplayer-pr-hardening-checklist.done/plan.md) — running list of
  issues that drove the current design.
- [api/app/routers/multiplayer.py](../api/app/routers/multiplayer.py)
  — server implementation.
