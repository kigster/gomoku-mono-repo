# Spec — 0.1.1 Build/CI plumbing and depth tuning

**Span:** `db7518b` → `6610c3e` (14 commits, 2025-07-08)
**Version:** `0.1.0` → `0.1.1`

## Theme

Harden the build and CI so the game compiles and tests cleanly off the author's
machine, and re-tune AI search depth per difficulty.

## What was built

- **Makefile.** A first-class build recipe ("Add the goddamn Makefile") so the
  engine compiles with a single command instead of ad-hoc invocations.
- **CI stabilization.** A long sequence of iteration commits ("Another attempt",
  adding then removing the Ubuntu runner) converges the GitHub Actions matrix on
  the platforms that actually build, ending with a working pipeline and a CI
  status badge in the README.
- **Difficulty/depth tuning.** Search-depth values per difficulty level are
  adjusted so the AI's look-ahead matches the intended easy/medium/hard feel.
- **Wording/doc fixes** throughout the README and help text.

## Oracle: version-bump assessment

A **patch** bump (`0.1.0` → `0.1.1`) is correct. The changes are build- and
CI-facing plus a gameplay tuning tweak; no new user-facing feature and no
contract change. Nothing here breaks compatibility.
