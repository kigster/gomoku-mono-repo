# Plan — 0.4.0 AI engine overhaul

## Steps

1. **Refactor move generation.** Separate candidate generation from scoring;
   order moves by threat value to improve alpha-beta cutoffs. Fix the minimax
   bugs uncovered in the process (#27).
2. **Rebuild the transposition table.** Proper Zobrist-style hashing, ~10x
   capacity, and a clear between moves so stale entries never poison a new
   search. Size it to avoid the Ubuntu segfault seen with the old table.
3. **Tune the search.** Add root-level alpha-beta narrowing; raise the move
   radius 2 → 3; remove the forward-pruning shortcut that dropped viable moves.
4. **Add game modes** (#28). A player-type selector mapping each side to human or
   AI for three configurations.
5. **Add a self-play benchmark.** Have the engine play itself and assert quality
   metrics, so strength changes are measurable in CI.
6. **Developer targets.** `make install`, `make run`; clear the warnings; define
   `SEARCH_MOVE_RADIUS`.
7. Bump `GAME_VERSION` to `0.4.0`, tag.

## Testing strategy

- The self-play benchmark as a strength regression gate.
- Targeted tactical positions (forced wins, must-block threats) to validate the
  search fixes.
- Cross-platform CI to catch memory-sizing regressions like the Ubuntu segfault.

## Deviations from the code

Tuning constants (table size, move radius, narrowing window) are discovered here
through trial and segfaults. The cleaner approach makes these compile-time or
runtime parameters with the self-play benchmark sweeping them, so the best values
are chosen by measurement rather than by reacting to a crash on one platform.
