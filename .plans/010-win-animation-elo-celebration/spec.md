# 010 — Win Animation & Elo Level-Up Celebration

Slice of the umbrella spec
[`001-clarification-simplification/spec.md`](../001-clarification-simplification/spec.md)
that owns **the celebratory frontend that fires when a multiplayer game ends**:
the winning five-in-a-row stone animation, and the special "you levelled up your
Elo against a stronger opponent" fireworks moment.

This feature owns the *celebration*, plus the **minimal backend additions** that
expose the data the celebration needs (the winning-line coordinates and the
per-player Elo deltas) on the game JSON. It does **not** own the WebSocket /
polling transport (002), the Elo computation itself (004 / `api/app/elo.py` — we
only *consume* deltas it already computes), the timed-game / timeout flow (009),
or the game-over routing (we *enhance* the existing `GameOverPanel`, we do not
replace the routing around it).

______________________________________________________________________

## Goal

When a two-human game finishes with a winner, the frontend recognises the win
and plays a looping, slightly-different-every-time animation of the five winning
stones lifting off the board and settling back with a diamond shine — until the
player presses **Back**. When the winner is a human who beat a meaningfully
stronger human (the loser's pre-game Elo was **100 or more points above** the
winner's pre-game Elo), the winner additionally gets a fireworks overlay and a
large headline announcing exactly how many Elo points they gained.

This is pure celebration. There is no judgement of the loser, no "you lost
badly" messaging, and no celebration on a draw.

______________________________________________________________________

## Win-animation requirements

Triggered when the game state is `finished`, `winner ∈ {"X","O"}` (not `null`,
not `"draw"`), and the game JSON carries a non-empty `winning_cells` array of
exactly the five winning coordinates.

1. **Lift.** The five winning stones lift off the board (scale up + translate
   up, a soft shadow growing beneath them), staggered so they don't all move in
   lock-step.
1. **Replace.** They settle back onto their original points.
1. **Diamond shine.** As each stone lands, a diamond-shaped shine/sparkle
   emanates from it (a bright four-point star that scales and fades).
1. **Loop.** The lift → replace → shine cycle repeats indefinitely until the
   player presses **Back** (the existing "Back home" control in `GameOverPanel`).
   There is no "stop" button other than leaving the screen.
1. **Randomness — every loop iteration must look a little different.** The
   per-iteration parameters that vary:
   - stagger order and per-stone delay of the five stones,
   - lift height and lift duration (timing jitter, within bounds),
   - number, angular position, size, and delay of the diamond sparkles around
     each stone.
     The randomness must be **seedable** so tests are deterministic (a `seed` prop
     threads into a small PRNG; production uses a fresh random seed per mount, and
     re-seeds on each loop iteration so successive iterations differ).
1. **Performance.** Animate **transform and opacity only** — no animating of
   `width`/`height`/`x`/`y`/`top`/`left` or anything that triggers layout. The
   five animated stones render in an overlay layer above the static board so the
   board itself never re-lays-out. Target a steady 60fps on a mid-range laptop.
1. **Non-winning end states are untouched.** A draw shows no animation. A loss
   shows the existing "Game Over / Lost to @X" panel with no celebration.

## Elo level-up rule (the fireworks moment)

Let `winner_elo_before` and `loser_elo_before` be the two players' Elo ratings
*before* this game, and `winner_elo_after` the winner's rating after.

- **Trigger condition (all must hold):**
  - the game finished with a real winner (`winner ∈ {"X","O"}`),
  - **the viewing player is the winner** (`your_color === winner`),
  - both players are human (always true in multiplayer; no AI rows here),
  - `loser_elo_before − winner_elo_before ≥ 100`.
- **`X` (points gained)** = `winner_elo_after − winner_elo_before`. This is the
  exact integer Elo delta the winner earned this game — *not* the 100-point gap,
  and *not* a recomputation. We consume the delta the backend already wrote.
- **When triggered**, in addition to the standard winning-stone animation, the
  winner sees:
  - a **fireworks overlay** across the viewport, and

  - a large headline:

    > **Congratulations! You just levelled your Elo Rating by X.**

    where `X` is the integer above (e.g. *"… by 24."*). Singular/plural of any
    surrounding copy is fine to keep simple; the number is the load-bearing part.
- **No celebration for the loser**, and none when the gap is `< 100`, and none
  on a draw. The loser of an upset sees only the normal game-over panel.

## Accessibility — reduced motion

Honour `prefers-reduced-motion: reduce`. When the user prefers reduced motion:

- The winning five stones get a **static** distinguishing treatment (e.g. a
  steady golden ring / glow) instead of the looping lift+shine — no looping
  transforms, no flashing.
- The fireworks overlay is replaced by a **static** celebratory banner (the same
  "Congratulations! … by X." headline, shown without animated particles).
- The Elo headline text is always present in the DOM regardless of motion
  preference, so the information (the value of X) is never motion-gated.

______________________________________________________________________

## Dependencies (what this slice consumes)

- **Game JSON over the transport (002).** We read the participant game view
  (`MultiplayerGameView`) delivered by polling today / `game.update` over WS
  once 002 lands. We require two additions to that view (specified in
  `plan.md`): `winning_cells` and the winner/loser Elo deltas.
- **Elo deltas (004).** The numbers come from the Elo update that 004 /
  `_write_finished_games_rows` already computes (`elo_before` / `elo_after`).
  We only surface and read them; we never recompute Elo on the client.

## Non-goals

- WebSocket transport / polling cadence (002, 009).
- Elo computation, K-factor, matchmaking (004).
- Timed-game timeouts and the timeout-win path (009) — but see the **edge case**
  in `plan.md`: a win by timeout/resignation has **no** `winning_cells`, and the
  animation must degrade gracefully (no five-stone lift; the Elo celebration can
  still fire if the gap condition holds).
- Game-over routing and the surrounding page shell — we enhance `GameOverPanel`,
  not the routing.
- Any loser-facing or judgemental messaging.
- Sound effects.
