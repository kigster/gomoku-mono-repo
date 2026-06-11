# Spec — 1.0.0 JSON export, replay mode, documentation

**Span:** `d4788cd` → `30d2025` (7 commits, 2026-01-28)
**Version:** `0.5.0` → `1.0.0`

## Theme

Declare the terminal game stable at 1.0 with game serialization, replay, and a
documentation set.

## What was built

- **JSON game export** (#33) — completed games serialize to structured JSON,
  using Unicode symbols in the `board_state` representation.
- **Replay mode** (#33) — step through a saved game move by move.
- **AI improvements** (#33) — further search/eval refinement.
- **Player-selection fix** (#35) — the `-o` flag for choosing side and cursor
  display are corrected.
- **Documentation set** (#36) and reformatted code, refreshed README/screenshots
  (#34).

## Oracle: version-bump assessment

The jump to **1.0.0** is a *stability/maturity* statement rather than a breaking
change — the project signaling "this terminal game is feature-complete and
supported." Under strict SemVer the content (additive features: export, replay)
reads as a minor bump; promoting it to `1.0.0` is the legitimate convention for
"first stable release." Endorsed.
