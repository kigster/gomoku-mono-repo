# Spec — 3.0.0 UI refactor, leaderboard polish, deploy options

**Span:** `27deb12` → `db1bb4a` (19 commits, 390 files, 2026-04-27)
**Version:** `2.0.0` → `3.0.0`

## Theme

Polish the 2.0 web app: a substantial UI refactor, leaderboard correctness, and a
documented deployment strategy.

## What was built

- **Frontend refactor.** `App.tsx` heavily reworked (~861 lines), with
  `RulesModal`, `SettingsPanel`, and `JsonDebugModal` restructured; an ambient
  background and improved API config (#73).
- **Leaderboard correctness** (#79) — make the leaderboard unique per user
  (dedupe multiple entries to one ranked row).
- **Deployment options.** `iac/DEPLOY-OPTIONS.md`, refreshed `DEPLOYMENT.md` and
  `iac/cloud_run/README.md`; an nginx-configuration skill.
- **Project tooling/docs.** Claude Code skills and plugin caches; codebase-analysis
  documents (`claude-`/`codex-codebase-analysis.md`); routine dependency bumps
  (postcss, mako, pytest, vite).

## Oracle: version-bump assessment

The `2.0.0` → **3.0.0** jump is a *magnitude* signal more than a strict
breaking-change one. The leaderboard uniqueness change touches data semantics and
the UI refactor is sweeping, but no documented public API is broken. Under strict
SemVer this reads closer to a **minor** (additive polish + a bug-fix). The project
uses major bumps to mark "a visibly different release," which is a legitimate (if
liberal) convention — recorded as a deliberate, magnitude-driven major. Tag
preserved as `3.0.0`.
