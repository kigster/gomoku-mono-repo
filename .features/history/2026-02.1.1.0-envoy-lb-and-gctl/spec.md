# Spec — 1.1.0 Envoy load balancer and gctl cluster manager

**Span:** `503ddba` → `02db6db` (30 commits, 2026-02-05)
**Version:** `1.0.1` → `1.1.0`

## Theme

Make the multi-server daemon deployment operable: Envoy load balancing and a
unified cluster-management CLI.

## What was built

- **Envoy load-balancer support** (#44) with cluster management, alongside the
  existing HAProxy path; reliability fixes (revert maxconn to drain/ready, add
  503-retry in the test client, #43).
- **Cluster management consolidation.** `bin/gomoku-cluster` (~665 lines) and a
  comprehensive cluster-management script replace the earlier `start-cluster`;
  Envoy docs added to `HTTPD.md`.
- **`board` → `board_size` rename** across the engine/UI for clarity; high-CPU fix
  and color updates.
- **AI evaluation corpus.** Many recorded game JSONs under `games/` (draws and
  wins) plus `tests/eval/llm_eval.py` (~301 lines) for LLM-assisted evaluation.

## Oracle: version-bump assessment

A **minor** bump (`1.0.x` → `1.1.0`) is appropriate. The work is additive
operational tooling (Envoy, `gctl`/cluster manager) plus an internal rename and
eval corpus — backwards-compatible for players and the HTTP contract. Minor fits.
