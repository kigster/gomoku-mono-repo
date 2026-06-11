# Plan — 0.1.0 Terminal Gomoku, first playable release

A step-by-step plan that would produce this milestone from the `main.c`
prototype.

## Steps

1. **Carve the monolith into modules.** Pull board state out of `main.c` into
   `board.{c,h}`; move rules and lifecycle into `game.{c,h}`; isolate rendering
   in `ui.{c,h}`; put argument parsing in `cli.{c,h}`. Leave `main.c` as a thin
   launcher that wires them together.
2. **Define the data model.** A fixed-size grid of cells (empty / black /
   white), a game struct tracking whose turn it is, move count, and terminal
   state. Centralize the version string as `GAME_VERSION` in the engine header.
3. **Implement the rules.** Five-in-a-row detection across the four directions,
   draw detection on a full board, and turn alternation. Cover these with
   GoogleTest cases.
4. **Build the AI.** A depth-limited adversarial search with a heuristic
   evaluation of board positions. Expose search depth as a difficulty knob.
   Validate that it blocks obvious threats and completes its own lines.
5. **Render the terminal UI.** Draw the board, stones, and a movable cursor with
   ANSI escape codes. Add a help screen. Capture screenshots for the README.
6. **Wire up CI.** A GitHub Actions workflow that compiles the engine and runs
   the test binary on every push, so regressions are caught immediately.
7. **Release hygiene.** Remove the committed binary, fix `.gitignore`, polish the
   README, set `GAME_VERSION` to `0.1.0`, and tag the release.

## Testing strategy

- Unit tests (GoogleTest) for win/draw detection and board mutation.
- A manual play-through against the AI at each difficulty to confirm it makes
  legal, non-trivial moves.
- CI as the regression backstop.

## Deviations from the code

None of note. The plan mirrors the shipped decomposition. One observation rather
than a deviation: the AI search, board evaluation, and the transposition-table
machinery that later releases add (see 0.4.0) are deliberately out of scope here
— 0.1.0 favors a correct, readable engine over a strong one, which is the right
ordering for a first release.
