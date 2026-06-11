# Spec — 0.3.2 GoogleTest harness and minimax board-size fix

**Span:** `958fb53` → `090fbd7` (21 commits, 2026-01-27)
**Version:** `0.3.1` → `0.3.2`

## Theme

Stabilize the test harness (GoogleTest builds reliably) and fix correctness bugs
in the minimax search, after a multi-month development gap.

## What was built

- **Reliable GoogleTest builds.** Fixes for "GoogleTest not building the first
  time" and a GoogleTest version update, so the suite runs deterministically from
  a clean checkout.
- **Minimax board-size fix.** "respect board size in minimax" corrects the search
  reasoning about off-board cells / sizes other than the default.
- **Robustness fixes.** Include `unistd.h` in the CLI, fix UI buffer warnings, add
  timing-reset assertions to the undo test.
- **Project scaffolding.** Adds the `.claude/` folder and `OVERVIEW`
  documentation; uses a "medium" difficulty label; fixes a README typo.

## Oracle: version-bump assessment

A **patch** bump (`0.3.1` → `0.3.2`). Despite 21 commits, the content is
test-infrastructure hardening and bug fixes — no new player-facing capability and
no contract change. Patch is the right call.
