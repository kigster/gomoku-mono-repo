# 009 — Timed games & timeouts

## Goal

Give human-vs-human multiplayer games a server-authoritative clock. Today a
multiplayer game has exactly one deadline: the 15-minute `expires_at` TTL that
only applies while the game is still `waiting` for a guest (lazy-expired on
poll — `_expire_if_stale` in `api/app/routers/multiplayer.py:184`). Once both
players are in, a game can sit `in_progress` forever; there is no per-move
clock and no whole-game cap.

This slice adds two new timing regimes for *in-progress* games, persists the
timing decision and all deadlines on the game row, enforces every deadline on
the **server** (clients are never trusted to expire a game), pushes timeout
events to both players over the WebSocket built in 002, and renders prominent
countdown timers at the very top of the board modal next to the
whose-turn indicator.

## The three timing regimes

A game's regime is fixed at creation time by the "Timed Game" checkbox
(rendered by 007, consumed here — see Dependencies). It never changes
mid-game.

1. **Timed** (`timed = true` — either player checked the box).

   - **15 seconds per move.** Each move resets the per-move clock for the next
     player. If the player on the clock does not move within 15 s, the
     per-move deadline fires (penalty: see **OPEN** below).
   - **5-minute whole-game cap.** From the moment the game goes
     `in_progress`, if neither player has won within 5 minutes, the game ends
     in a **draw**.
   - Both deadlines run concurrently; whichever fires first wins (see Edge
     cases in `plan.md`).

1. **Untimed** (`timed = false` — neither player checked the box).

   - **No per-move clock.**
   - **30-minute whole-game expiry.** From `in_progress`, if the game is still
     unfinished after 30 minutes, it ends. Recommended terminal state:
     **draw** (consistent with the timed cap and the AI-hardest cap; an
     `abandoned`/expired state would muddy Elo accounting, which only knows
     `X` / `O` / `draw`).

1. **AI-hardest 15-minute teardown** — *handled elsewhere* (008/011). The
   Rust per-game container is capped at 15 minutes and torn down with a draw.
   That cap is the same shape as our whole-game cap (persisted deadline →
   draw), and 009 owns the **reusable generic timer primitive** that 008/011
   call for their teardown. 009 does **not** own the container lifecycle.

Summary table:

| Regime | Per-move clock | Whole-game cap | Cap outcome | Trigger |
| -------------- | -------------- | -------------- | ----------- | -------------------- |
| Timed | 15 s / move | 5 min | draw | either player checks |
| Untimed | none | 30 min | draw (rec.) | neither checks |
| AI-hardest | n/a | 15 min | draw | premium AI (008/011) |

## Server-authoritative requirement (anti-cheat)

All deadlines are stored on the game row as absolute `TIMESTAMPTZ` values and
enforced exclusively by the server. The client receives deadlines and renders
a countdown, but a client clock that says "time's up" has **no** authority: it
must still call the server, and the server decides based on its own clock.
Conversely a slow/cheating client cannot extend its own clock — the move
handler rejects a move that lands after the per-move deadline (server time),
and the scheduler fires the timeout independently of whether the client ever
sends anything. This mirrors the existing version-conflict / turn-order guards
in `make_move` (`multiplayer.py:543-547`), which are already server-side.

## Move-timeout penalty — **OPEN**

When the **15 s per-move** deadline fires in a timed game, what happens to the
player who ran out of time?

- **Recommended: forfeit-loss.** The player on the clock loses; the opponent
  is recorded as the winner (`winner = opposite color`), the game goes
  `finished`, and the normal finished-games / Elo write-back runs (same path
  as `resign`, `multiplayer.py:592`). Rationale: a 15 s move clock is a
  speed-chess contract both players opted into; timing out is a real result,
  symmetric with resignation, and it keeps Elo meaningful.
- **Alternative: auto-random move.** The server plays a random legal move for
  the timed-out player and passes the turn. Keeps the game alive but is
  surprising (a stone you didn't place) and complicates win detection /
  history. Documented but not recommended.

This is flagged **OPEN** for the user to confirm. The plan is written assuming
**forfeit-loss**; switching to auto-random changes only the timeout handler
body, not the schema or scheduler.

Note: the **whole-game caps** (5 min timed, 30 min untimed) are **not** a
penalty — they are an unconditional draw, no fault assigned.

## Prominent-display requirement

Per the umbrella spec: *"All timeouts should be prominently displayed at the
very top of the board modal, next to whose turn it is."* The countdown(s) must
sit in the board header next to the turn indicator
(`MultiplayerGamePage.tsx` — the `PlayerHeader` / "Your move." block around
lines 339-344), large and legible, and switch to a visible warning state as a
deadline approaches (e.g. the per-move clock under ~5 s). For a timed game,
**both** the per-move countdown and the total-game countdown are shown; for an
untimed game, only the total-game countdown.

## Dependencies

- **002 — WebSocket transport.** Reuses the lobby-wide socket, the connection
  manager (`send_to_user` / `broadcast_to_users`), the `{type,payload,v}`
  envelope, and the `game.update` push. 002 explicitly reserves
  `game.move_rejected` / `game.ended` for 005/009 and lists 009 as a consumer
  of "`game.*` timer/ended push". 009 adds a `game.timeout` event and reuses
  `game.update`.
- **005 — match ready / color negotiation** (and the multiplayer create path,
  `POST /multiplayer/new`, `multiplayer.py:321`). 009 consumes the
  `timed: bool` decision produced by the create flow and persists it.
- **007 — game-type modal redesign.** Renders the "Timed Game" checkbox. 009
  does **not** build that UI; it consumes the resulting boolean at creation.

## Non-goals

- The "Timed Game" **checkbox UI** — owned by 007.
- The **WebSocket transport itself** (connection manager, envelope, auth
  handshake) — owned by 002. 009 only adds new event types and a producer.
- The **AI-hardest 15-minute container teardown** — owned by 008/011. 009
  provides the reusable timer primitive they call; it does not own Cloud Run
  per-game infra.
- The **win animation / Elo celebration** on game end — owned by 010. 009
  fires the terminal state; 010 reacts to it.
- **Multi-instance** scheduler coordination (multiple API replicas racing to
  fire the same timeout) — deferred under the single-always-on-instance
  assumption that 002 and the umbrella infra plan both make. See **OPEN** in
  `plan.md`.
