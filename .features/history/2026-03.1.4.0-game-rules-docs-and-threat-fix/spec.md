# Spec — 1.4.0 Game-rules docs, AI threat fix, HTTP client

**Span:** `318c562` → `5e69e39` (2 commits, 2026-03-02)
**Version:** `1.3.0` → `1.4.0`

## Theme

Document the game's rule set and correct the AI's threat evaluation.

## What was built

- **Game Rules Documentation** (#61) — an authoritative description of the rule
  variant (capturing/overline/free-style specifics) so behavior is unambiguous.
- **AI threat fix** (#61) — corrects threat evaluation, improving both attack and
  defense.
- **HTTP client improvements** (#61) for the engine-server protocol.

## Oracle: version-bump assessment

A **minor** bump (`1.3.x` → `1.4.0`). The AI threat-evaluation fix changes play
behavior and the rules documentation pins down semantics; both are additive and
non-breaking. Minor is reasonable, though a pure bug-fix reading could argue for a
patch — the bundled HTTP-client improvements and rules formalization tip it to
minor.
