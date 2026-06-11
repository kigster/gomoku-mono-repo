# Version history

This tree compacts the project's 237-commit history (2025-07-06 → 2026-06-11) into a sequence of cohesive **version milestones**. Each milestone folder documents the span of commits between one release tag and the next, mapped to the semantic `GAME_VERSION` from `gomoku.h`.

It is a **documentation-only** record. Nothing here rewrites history or edits source files — the `GAME_VERSION` values and the `v*` git tags already existed on the remote; this tree narrates them. (The one exception, where applicable, is creating *missing* tags as new refs — never force-moving existing ones.)

## Folder scheme

```
.features/history/YYYY-MM.A.B.C-slug/
  intro.md   — the idea explained to a smart person who never went to college
  spec.md    — what was actually built across the commit span + the Oracle's
               version-bump assessment
  plan.md    — a step-by-step plan for the work, with an optional
               "Deviations from the code" section
```

- `YYYY-MM` — year and month of the version's tag commit.
- `A.B.C` — the semantic version (`GAME_VERSION`) that the span culminates in.
- `slug` — a short, readable theme for the span.

Provenance of the three documents follows the multi-agent convention: **Morpheus** writes `intro.md`, **Neo** writes `spec.md`, **Trinity** writes `plan.md`, and **the Oracle** renders the version-bump assessment recorded at the foot of each `spec.md`.

## Milestone timeline

| Version | Folder | Date | Commits | Theme |
| ------- | ------ | ---- | ------- | ----- |
| 0.1.0 | [2025-07.0.1.0-terminal-gomoku-first-release](2025-07.0.1.0-terminal-gomoku-first-release/) | 2025-07-06 | 5 | First playable ASCII-terminal Gomoku + CI |
| 0.1.1 | [2025-07.0.1.1-build-ci-and-depth-tuning](2025-07.0.1.1-build-ci-and-depth-tuning/) | 2025-07-08 | 14 | Makefile, CI plumbing, search-depth tuning |
| 0.1.2 | [2025-07.0.1.2-ui-fixes](2025-07.0.1.2-ui-fixes/) | 2025-07-08 | 4 | UI fixes and release tooling |
| 0.2.0 | [2025-07.0.2.0-threat-matrix-heuristics](2025-07.0.2.0-threat-matrix-heuristics/) | 2025-07-14 | 12 | Threat-matrix AI heuristics, LICENSE, polish |
| 0.3.1 | [2025-07.0.3.1-cmake-build-system](2025-07.0.3.1-cmake-build-system/) | 2025-07-18 | 4 | CMake build system + help screen |
| 0.3.2 | [2026-01.0.3.2-googletest-and-minimax-boardsize-fix](2026-01.0.3.2-googletest-and-minimax-boardsize-fix/) | 2026-01-27 | 21 | GoogleTest harness, minimax board-size fix |
| 0.4.0 | [2026-01.0.4.0-ai-engine-overhaul](2026-01.0.4.0-ai-engine-overhaul/) | 2026-01-27 | 34 | AI overhaul: game modes, minimax fixes, transposition table |
| 0.4.1 | [2026-01.0.4.1-docs-and-version-bump](2026-01.0.4.1-docs-and-version-bump/) | 2026-01-27 | 1 | Docs/version bump |
| 0.5.0 | [2026-01.0.5.0-ai-randomness-and-make-format](2026-01.0.5.0-ai-randomness-and-make-format/) | 2026-01-28 | 2 | AI randomness, move-gen optimization, `make format` |
| 1.0.0 | [2026-01.1.0.0-json-export-and-replay-mode](2026-01.1.0.0-json-export-and-replay-mode/) | 2026-01-28 | 7 | 1.0: JSON export, replay mode, documentation |
| 1.0.1 | [2026-02.1.0.1-http-daemon-and-cluster](2026-02.1.0.1-http-daemon-and-cluster/) | 2026-02-02 | 5 | Stateless HTTP daemon, Docker/K8s, IaC, HAProxy cluster |
| 1.1.0 | [2026-02.1.1.0-envoy-lb-and-gctl](2026-02.1.1.0-envoy-lb-and-gctl/) | 2026-02-05 | 30 | Envoy load balancer + `gctl` cluster manager |
| 1.1.1 | [2026-02.1.1.1-schema-validator-and-dynamic-config](2026-02.1.1.1-schema-validator-and-dynamic-config/) | 2026-02-12 | 21 | JSON schema validator, dynamic cluster config |
| 1.2.0 | [2026-02.1.2.0-vct-forced-win-search](2026-02.1.2.0-vct-forced-win-search/) | 2026-02-12 | 3 | VCT forced-win search, scoring reports |
| 1.2.1 | [2026-02.1.2.1-ruby-tournament-runner-and-cloud-run](2026-02.1.2.1-ruby-tournament-runner-and-cloud-run/) | 2026-02-20 | 3 | Ruby tournament runner, Cloud Run workflow |
| 1.3.0 | [2026-03.1.3.0-board-notation-and-undo-limits](2026-03.1.3.0-board-notation-and-undo-limits/) | 2026-03-02 | 5 | Board notation, undo limits, JSON debug modal |
| 1.4.0 | [2026-03.1.4.0-game-rules-docs-and-threat-fix](2026-03.1.4.0-game-rules-docs-and-threat-fix/) | 2026-03-02 | 2 | Game-rules docs, AI threat fix, HTTP client |
| 2.0.0 | [2026-04.2.0.0-fullstack-auth-scoring-leaderboard](2026-04.2.0.0-fullstack-auth-scoring-leaderboard/) | 2026-04-03 | 7 | 2.0: Full-stack web app — auth, scoring, leaderboard |
| 3.0.0 | [2026-04.3.0.0-ui-refactor-and-leaderboard-polish](2026-04.3.0.0-ui-refactor-and-leaderboard-polish/) | 2026-04-27 | 19 | 3.0: Modal/UI refactor, leaderboard polish, deploy options |
| 3.1.0 (proposed) | [2026-06.3.1.0-cloud-deploy-and-multiplayer](2026-06.3.1.0-cloud-deploy-and-multiplayer/) | 2026-06-11 | 37 | Cloud Run + Honeycomb, human-vs-human multiplayer, chat, presence |

The final row is **unreleased**: `GAME_VERSION` still reads `3.0.0`, but 37 post-`v3.0.0` commits added Cloud Run deployment with Honeycomb telemetry, a Gomocup tournament brain, and full human-vs-human multiplayer with presence and chat. The Oracle's assessment for that span (see its `spec.md`) recommends a version designation; applying it is a separate, explicit decision.

## A note on tag anomalies

The remote carries two cosmetic tag glitches worth cleaning up separately (not touched here): the early releases `0.1.0` / `0.1.1` lack the `v` prefix that every later tag uses, and `vv0.1.2` is a duplicate typo of `v0.1.2`. Both point at valid commits; only the names are off.
