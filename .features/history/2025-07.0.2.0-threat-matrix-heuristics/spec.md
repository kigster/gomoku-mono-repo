# Spec — 0.2.0 Threat-matrix heuristics and project polish

**Span:** `6e4df5e` → `6180808` (12 commits, 2025-07-14)
**Version:** `0.1.2` → `0.2.0`

## Theme

Give the AI a structured threat model derived from a published threat matrix,
and bring the project to a presentable state (LICENSE, images, CI).

## What was built

- **Threat-matrix evaluation.** `src/ai.c` is substantially reworked (~416 lines
  changed) to score positions against the canonical Gomoku threat patterns
  (open/closed fours and threes, etc.) taken from a reference PDF. The
  position-scoring heuristic becomes pattern-aware rather than ad hoc.
- **Game-rules surface.** `src/game.{c,h}` grows significantly (~339 / ~256
  lines) to support the richer evaluation and threat detection used by the
  search.
- **Project polish.** Adds a `LICENSE`, refreshes `.cursor/rules`, resizes
  documentation images (700w) including a new "play on hard" screenshot, fixes
  `make release`, and updates CI.

## Oracle: version-bump assessment

A **minor** bump (`0.1.x` → `0.2.0`) is well justified. The threat-matrix
heuristic is a substantive new capability that visibly changes how the opponent
plays — additive and backwards-compatible (same CLI, same game), so minor rather
than major is correct.
