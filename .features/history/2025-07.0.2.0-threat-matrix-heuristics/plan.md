# Plan — 0.2.0 Threat-matrix heuristics and project polish

## Steps

1. **Encode the threat matrix.** Translate the reference PDF's threat patterns
   (open four, simple four, open three, broken three, …) into a scoring table the
   evaluator can apply to any line through a candidate cell.
2. **Rework the evaluator.** In `ai.c`, replace the ad-hoc position score with a
   pass that recognizes these patterns in all four directions and sums weighted
   threat values for attack and defense.
3. **Extend the rules surface.** Grow `game.{c,h}` with the helpers the evaluator
   needs (line extraction, pattern classification).
4. **Validate strength.** Confirm the AI now blocks open fours/threes and creates
   its own threats; capture a "play on hard" screenshot.
5. **Polish the project.** Add `LICENSE`, resize images, fix `make release`,
   update CI; bump `GAME_VERSION` to `0.2.0` and tag.

## Testing strategy

- Targeted positions: an open four must be blocked; a double-three should be
  recognized as winning pressure.
- Regression play-throughs at each difficulty.

## Deviations from the code

Encoding threats as a data-driven table (pattern → weight) rather than branching
code would make the evaluator easier to tune and test in isolation. If the
shipped version hard-codes pattern checks inline, extracting them into a table is
the cleaner long-term shape and would let unit tests assert each pattern's score
directly.
