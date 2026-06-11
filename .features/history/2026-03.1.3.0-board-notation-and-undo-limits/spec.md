# Spec — 1.3.0 Board notation, undo limits, debug modal

**Span:** `6f400dc` → `318c562` (5 commits, 2026-03-02)
**Version:** `1.2.1` → `1.3.0`

## Theme

Player-facing UX (notation, undo limits, debug inspection) plus AI and
build-portability fixes.

## What was built

- **Board notation + undo limit system + UI improvements** (#60) — named
  coordinates for the board and a bounded undo so moves can be taken back within
  limits.
- **JSON debug modal** (#58) — inspect raw game state; accompanied by AI search
  optimizations and a macOS build fix.
- **Apple compiler fixes** (#57) for newer toolchains.
- **Dependency bump** — rollup 4.57.1 → 4.59.0 in the frontend (#59), an early
  sign of frontend tooling entering the tree.

## Oracle: version-bump assessment

A **minor** bump (`1.2.x` → `1.3.0`) is appropriate. Notation, undo limits, and
the debug modal are additive user-facing features; combined with non-breaking AI
and build fixes, minor is the correct level.
