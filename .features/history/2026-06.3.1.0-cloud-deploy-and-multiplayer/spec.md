# Spec — 3.1.0 (proposed) Cloud deploy, multiplayer, chat, presence

**Span:** `db1bb4a` (v3.0.0) → `3be3353` (HEAD) — 37 commits, 2026-04-27 → 2026-06-11
**Version:** `GAME_VERSION` **unchanged at `3.0.0`** — this span is **unreleased**.

## Theme

Production cloud deployment with telemetry, a Rust engine port, a Gomocup
tournament brain, and full human-vs-human multiplayer with presence and chat.

## What was built

- **Cloud Run deploy pipeline with Honeycomb telemetry** (#80) — production
  deployment with OpenTelemetry tracing; keep-warm `min_instance_count = 1` (#82);
  worker-count tuning and a revert for Cloud Run resource limits (#84, #85).
- **Human-vs-human multiplayer** (#90, #94) — the two-player architecture and data
  model: invite links, join flow, per-game state, and the `games.game_type`
  discriminator. `api/tests/test_multiplayer.py` (~1,175 lines) lands here.
- **Presence, targeted invites, in-game chat** (#95, #96) — Solo/Multi tabs, a
  chat panel with slash commands, "who's online" presence, and a default-modal
  flip.
- **Rust httpd port** — `gomoku-httpd-rust/` with `Cargo.lock` (~3,026 lines): a
  Rust re-implementation of the move daemon.
- **AI correctness** — threat-eval fix for broken patterns and the overline rule
  (#83); search tuning and dead-cache removal (#86).
- **Gomocup tournament brain** (#89) — `pbrain-kig-standard` for the standardized
  Gomocup protocol; executable-filename updates for submission.
- **Multi-agent dev workflow** (#81) and a large set of `.claude/skills/` (the
  "antigravity" persona skills), CI/env hardening, and README work.

## Oracle: version-bump assessment

**This span is materially under-versioned and should be released.** It contains at
least three independently major-worthy features — production cloud deployment,
human-vs-human multiplayer (a new real-time architecture and public surface), and
a second engine implementation in Rust.

- Strict SemVer: human-vs-human multiplayer is a large additive capability →
  **minor at minimum (`3.1.0`)**.
- By the project's own magnitude-driven convention (it promoted lesser changes to
  `2.0.0`/`3.0.0`), the combined weight here — new multiplayer architecture +
  cloud productionization + Rust port — is **major-worthy (`4.0.0`)**.

**Recommendation:** designate this span **`3.1.0`** conservatively, or **`4.0.0`**
if following the project's established "big release = major" pattern. Applying the
tag and (separately) bumping `GAME_VERSION` in `gomoku.h` is a deliberate release
action to be taken explicitly — this document does not perform it.
