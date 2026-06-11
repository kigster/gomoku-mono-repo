# Spec — 0.1.0 Terminal Gomoku, first playable release

**Span:** root `0c461c1` → `db7518b` (5 commits, 2025-07-06)
**Version:** `GAME_VERSION` established at `0.1.0` (then in `src/gomoku.h`)

## Theme

The span turns a single monolithic `main.c` prototype into a structured,
playable terminal Gomoku and ships it as the first tagged release.

## What was built

- **Engine decomposition.** The ~1,100-line `src/main.c` prototype is broken
  into cohesive translation units: `board.{c,h}` (grid state), `game.{c,h}`
  (turn/win/draw rules and game lifecycle), `ai.{c,h}` (move search), `ui.{c,h}`
  (terminal rendering), and `cli.{c,h}` (argument parsing and entry flow).
  `main.c` shrinks to a thin launcher.
- **AI opponent.** `ai.c` (~426 lines) introduces a depth-limited adversarial
  search with heuristic board evaluation — the computer looks a few plies ahead
  rather than playing randomly. Search depth is a tunable knob.
- **Terminal UI.** `ui.c` (~473 lines) renders the board, stones, and a movable
  cursor with ANSI styling; help and play screens are captured as PNGs under
  `doc/`.
- **Rules and lifecycle.** `game.c` owns five-in-a-row detection, draw
  detection, and turn alternation.
- **Continuous integration.** `.github/workflows/ci.yml` compiles the engine and
  runs the GoogleTest-based `tests/gomoku_test.cpp` on every push.
- **Release hygiene.** The committed binary `gomoku` is removed from version
  control; `.gitignore` and the README (with screenshots) are brought up to
  release quality.

## Surface / contracts introduced

- The `GAME_VERSION` macro in the engine header becomes the single source of
  truth for the game's version string (printed on the help/title screen).
- The CLI entry point and screen layout that every later terminal release builds
  on.

## Oracle: version-bump assessment

This is the **0.1.0 baseline** — the first release, so there is no prior version
to bump from. Had it followed an earlier tag, the scope (a complete playable
game with an AI, structured into modules) would itself justify a *minor* bump;
as the genesis release, `0.1.0` is the correct designation. No backwards-
compatibility surface exists yet to break.
