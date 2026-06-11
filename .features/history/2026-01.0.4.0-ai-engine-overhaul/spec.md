# Spec — 0.4.0 AI engine overhaul

**Span:** `090fbd7` → `ea1c1ff` (34 commits, 2026-01-27)
**Version:** `0.3.2` → `0.4.0`

## Theme

A broad rebuild of the AI search and move generation, plus configurable game
modes and a self-play quality benchmark.

## What was built

- **Move generation refactor + minimax fixes** (#27). `src/ai.c` is heavily
  reworked (~169 lines) to fix bugs in the adversarial search and how candidate
  moves are produced and ordered.
- **Transposition table.** Enlarged ~10x with proper hashing and cleared between
  moves, so previously analyzed positions are reused safely — a major search
  speedup. A prior table size is also reduced to fix an Ubuntu segfault, showing
  the memory tuning was load-bearing.
- **Search tuning.** Alpha-beta narrowing at the root, move-generation radius
  raised 2 → 3, and removal of a dangerous forward-pruning shortcut that could
  skip good low-priority moves.
- **Configurable player types** (#28) — three game modes selecting which side is
  human vs AI.
- **Self-play AI quality benchmark** — an automated game-against-itself test
  (~390 lines added to the test suite) to measure strength.
- **Developer ergonomics.** `make install`, `make run`; fix a missing
  `SEARCH_MOVE_RADIUS` define and unused-parameter warnings.

## Oracle: version-bump assessment

A solid **minor** bump (`0.3.x` → `0.4.0`). This is the largest gameplay-quality
change so far — new modes and a markedly stronger, faster AI — but it remains
backwards-compatible (same CLI, same game rules). Minor is correct; it is not a
breaking change, so not a major.
