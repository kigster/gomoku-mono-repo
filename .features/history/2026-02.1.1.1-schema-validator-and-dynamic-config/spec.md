# Spec — 1.1.1 Schema validator and dynamic cluster config

**Span:** `02db6db` → `fc67c50` (21 commits, 2026-02-12)
**Version:** `1.1.0` → `1.1.1`

## Theme

Validate the game-JSON contract and make cluster configuration dynamic.

## What was built

- **Game JSON schema validator** (#53) — a script that checks saved game files
  against the expected schema, catching malformed exports.
- **Dynamic cluster config** (#51) — `gctl` is refactored to generate its
  configuration dynamically rather than from static files.
- **Observability/UX.** Show wait/server/queue time; simplify `htop` observation.
- **Docs** — better images (#52), multiple README updates; remove `.idea`.

## Oracle: version-bump assessment

Labeled a **patch** (`1.1.0` → `1.1.1`), though the JSON schema validator is a
genuine new (developer-facing) capability that would read as a **minor** under
strict SemVer. The under-numbering is mild and defensible — the validator is
tooling, not a runtime feature. Noted, tag preserved.
