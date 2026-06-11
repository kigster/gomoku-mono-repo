# Plan — 1.3.0 Board notation, undo limits, debug modal

## Steps

1. **Add board notation.** Map cells to human-readable coordinates and render them
   on the axes; accept notation in move references.
2. **Bound undo.** Track a configurable undo limit and enforce it in the game
   lifecycle and UI (#60).
3. **Add the JSON debug modal** (#58) to display raw state on demand.
4. **Optimize AI search** and fix the macOS/Apple-compiler build issues (#57, #58).
5. **Bump the frontend rollup dependency** (#59).
6. Bump to `1.3.0`, tag.

## Testing strategy

- Notation round-trip tests (cell ↔ coordinate string).
- Undo-limit tests asserting the cap is enforced.
- Cross-platform CI including macOS to lock in the compiler fixes.

## Deviations from the code

Notation and undo-limit are independent features bundled into one PR (#60).
Splitting them keeps each diff and its tests focused, and lets one ship if the
other needs rework.
