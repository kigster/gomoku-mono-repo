# Plan — 1.2.0 VCT forced-win search

## Steps

1. **Implement VCT search.** From a position, generate the player's threats that
   force a reply, recurse on the forced replies, and detect a chain that ends in
   five. Bound depth/time so it stays responsive.
2. **Integrate with move selection.** If a forced win is found, prefer it over the
   heuristic move.
3. **Add scoring reports.** Emit a breakdown of how a position was valued.
4. **Narrow blocking.** Tighten defensive candidate selection to the moves that
   actually refute the opponent's threats.
5. Bump to `1.2.0`, tag.

## Testing strategy

- A suite of known forced-win positions the engine must solve.
- Defensive positions where exactly one block survives.

## Deviations from the code

VCT is easy to let run too long. Capping it by node budget and exposing that
budget as a difficulty parameter (so easy levels search less) would make strength
tunable and keep worst-case latency bounded for the HTTP daemon.
