# Spec — 2.0.0 Full-stack web app: auth, scoring, leaderboard

**Span:** `5e69e39` → `27deb12` (7 commits, 349 files, 2026-04-03)
**Version:** `1.4.0` → `2.0.0`

## Theme

The transformation from a terminal/daemon project into a full-stack web
application with accounts, persistence, scoring, and a leaderboard.

## What was built

- **Full-stack auth, scoring, leaderboard, and AI improvements** (#65) — user
  accounts and authentication, a backend with a database, game scoring, and a
  global leaderboard. The frontend (`frontend/`, with `package-lock.json`) and the
  Python API (`api/`, with `uv.lock`) enter the tree here.
- **Web UI** (#64) — navigation modals, responsive layout, game history, and a new
  font; the browser becomes the primary play surface.
- **Architecture/config** (#63) — `CLAUDE.md` future plans and Dockerfile config.
- **Quality signals** — C99 test-suite badge; recorded `networked-games-*.json`
  corpora.

## Architecture shift

```
Browser (React) → Web API (auth, scores, DB) → gomoku-httpd (AI moves)
                              ↓
                          Database
```

The C engine remains the AI move oracle; everything about identity, persistence,
and presentation is new.

## Oracle: version-bump assessment

A genuine **major** bump (`1.x` → `2.0.0`), correctly applied. This is the
clearest major in the project's history: a new application architecture, a new
runtime (web + DB), and new public surfaces (auth, leaderboard). Even though the
game rules are unchanged, the product category changed — major is unambiguous.
