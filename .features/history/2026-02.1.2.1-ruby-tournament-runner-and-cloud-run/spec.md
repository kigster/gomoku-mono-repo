# Spec — 1.2.1 Ruby tournament runner and Cloud Run workflow

**Span:** `4f1dff2` → `6f400dc` (3 commits, 2026-02-20)
**Version:** `1.2.0` → `1.2.1`

## Theme

Tooling for measuring AI strength (a tournament runner) and a cloud update path.

## What was built

- **Ruby tournament runner** (#56) — orchestrates AI-vs-AI matches and reports
  outcomes, with the evaluation scripts restructured around it; made more verbose
  for visibility.
- **Cloud Run update workflow** (#55) — a pipeline to push engine updates to Cloud
  Run; the local Envoy cluster is expanded.

## Oracle: version-bump assessment

Labeled a **patch** (`1.2.0` → `1.2.1`). The content is developer/ops tooling
(tournament harness, deploy workflow) rather than a player-facing runtime feature,
so patch is defensible, though a case exists for minor given the new tournament
capability. Tag preserved.
