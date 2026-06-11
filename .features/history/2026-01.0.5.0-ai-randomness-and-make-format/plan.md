# Plan — 0.5.0 AI randomness and `make format`

## Steps

1. **Add controlled randomness.** When several candidate moves score within a
   small margin of the best, choose among them with a seeded random pick so games
   vary without weakening play. Keep the seed controllable for reproducible tests.
2. **Optimize move generation.** Reduce redundant work in the candidate scan
   (e.g. limit to cells near existing stones, dedupe).
3. **Add `make format`.** Wire a formatter (clang-format) and a target; format the
   tree.
4. Bump `GAME_VERSION` to `0.5.0`, tag.

## Testing strategy

- Tests must seed the RNG so move choice is deterministic under test while random
  in normal play.
- Benchmark move-gen before/after to confirm the optimization.

## Deviations from the code

The formatting pass was partially reverted shortly after (commit `7b28869`),
which signals it was run without first agreeing the style config and isolating it
from logic changes. The clean approach lands `make format` and the one-time
reformat as a standalone commit (no behavior changes mixed in), so it never has
to be reverted.
