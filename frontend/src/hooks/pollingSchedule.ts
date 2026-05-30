// Tiered polling cadence for multiplayer GET /multiplayer/{code}.
// Driven by wall-clock elapsed time since polling started, NOT by the
// server's update/no-change reply stream. The schedule trades responsiveness early
// (300 ms while both players are likely actively engaged) for cheapness
// later (5 s after an hour, when the game is probably idle).
//
//   0  – 10 min  → 300 ms
//   10 – 30 min → 2 s
//   30 – 60 min → 3 s
//   60 min +    → 5 s

const MS_PER_MIN = 60_000

export function pollingIntervalForElapsedMs(elapsedMs: number): number {
  if (elapsedMs < 10 * MS_PER_MIN) return 300
  if (elapsedMs < 30 * MS_PER_MIN) return 2_000
  if (elapsedMs < 60 * MS_PER_MIN) return 3_000
  return 5_000
}
