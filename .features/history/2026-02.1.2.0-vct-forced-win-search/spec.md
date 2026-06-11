# Spec — 1.2.0 VCT forced-win search

**Span:** `fc67c50` → `4f1dff2` (3 commits, 2026-02-12)
**Version:** `1.1.1` → `1.2.0`

## Theme

Add Victory-by-Continuous-Threats search and clearer evaluation reporting.

## What was built

- **VCT forced-win search** (#54) — a dedicated threat-sequence search that finds
  forced wins (chains of must-answer threats) and plays them when available.
- **Scoring reports** (#54) — diagnostic output explaining position evaluation.
- **Narrowed blocking** (#54) — more precise defensive move selection.
- **`make release` fix.**

## Oracle: version-bump assessment

A **minor** bump (`1.1.x` → `1.2.0`) is correct. VCT is a meaningful new AI
capability that strengthens play, delivered additively without breaking the CLI
or HTTP contract. Minor is the right level.
