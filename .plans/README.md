# Clarification & Simplification — Execution Plan

Umbrella spec: [`001-clarification-simplification/spec.md`](001-clarification-simplification/spec.md).

This is a re-architecture of the multiplayer experience. The prior
version had too many bugs to deploy; this plan rebuilds it around a real
WebSocket transport with a true two-human e2e test as the acceptance
harness, and ends with the **first-ever Cloud Run deploy**.

Each `NNN-*/` directory holds a `spec.md` (what/why for that slice) and a
`plan.md` (architecture, schema, file-by-file tasks, tests). They were
authored to compose into one ordered build.

## Tasks

| # | Slice | Owns |
|---|-------|------|
| [002](002-websocket-transport-foundation/) | WebSocket transport foundation | Auth'd FastAPI WS endpoint, in-process connection manager, `{type,payload,v}` envelope, `game.update` broadcast after the move POST, client `useGameSocket` hook |
| [003](003-presence-and-online-counts/) | Presence & online counts | Realtime `presence.update {online,playing}` from the live socket set; `usePresence()` |
| [004](004-elo-matchmaking-lobby/) | Elo matchmaking | Closest/above/below non-playing human minus blocks; no-humans→AI fallback; match-proposal contract; transactional Elo audit |
| [005](005-match-ready-color-negotiation/) | Ready + color handshake | Ready?→accept→color (Black/White/Don't-Care) truth table + dice; creates the game from a match |
| [006](006-chat-simplification/) | Chat de-slop | Only `/boo`+`/like` (+`/help`); chat over WS during game; join system-message; post-game countdown close |
| [007](007-game-type-modal-redesign/) | Game-type modal | Realtime counts header, AI/Human toggle, 6 stacked 75%-width buttons, Timed checkbox, no-humans fallback |
| [008](008-ai-difficulty-and-premium/) | AI difficulty + premium | Easy/Inter/Hard→C(d3/5/7,r2); Hardest→Rust(d9,r2); $1 premium free-in-beta; engine-URL resolver seam |
| [009](009-timed-games-and-timeouts/) | Timed games & timeouts | Timed 15s/move+5min draw; untimed 30min; server-authoritative scheduler; prominent board timers |
| [010](010-win-animation-elo-celebration/) | Win animation + level-up | Lift-5-stones + diamond shine (randomized, loops to Back); fireworks + "levelled your Elo by X" on 100+ upset |
| [011](011-cloud-run-per-game-rust-infra/) | Cloud Run topology | Always-on API+assets; C httpd; ephemeral 8-vCPU Rust for hardest; resolve/teardown impl |
| [012](012-e2e-two-human-cypress/) | Two-human e2e | The acceptance gate — two live UIs play a full game; whole suite green |
| [013](013-integration-hardening-deploy/) | Integration & deploy | All-green gate, WS-on-Cloud-Run hardening, observability, deploy runbook |

## Dependency / build order

```
002 (WS transport) ─┬─ 003 (presence) ─── 004 (matchmaking) ─── 005 (ready/color)
                    ├─ 006 (chat over WS)
                    ├─ 009 (timers)              007 (modal) ── consumes 003/004/005/008/009
                    └─ 010 (game.update → win)   008 (AI difficulty) ── 011 (Rust infra)
                                                                 │
012 (two-human e2e) ── gates on 002–010 + test seams ── 013 (integration + deploy)
```

Recommended landing order: **002 → 003 → 004 → 005 → 006 → 007 → 008 →
009 → 010 → 011 → 012 → 013**, each behind `lefthook run pre-commit`.
006 was authored first as the de-slop reference; it ships after 002.

## Locked architectural decisions

- **In-process WS connection manager**, in-memory online set. Valid only
  at **1 API instance** — see the deploy gate below.
- **Move POST stays HTTP**; the server broadcasts the full game JSON as
  `game.update` after the transaction commits. Everything else
  multi-screen goes over WS.
- **WS auth via a first-frame `auth` message** (not `?token=`), reusing
  the HTTP JWT secret/claims — keeps tokens out of logs/spans.
- **Elo: everyone starts 1500** (already the DB default) and updates in a
  **single transaction** (already correct in `_write_finished_games_rows`).
- **Host = Black (X)** at insert; color resolution sets `host_color`.
- **Ephemeral Rust = Option A**: a scale-to-zero dedicated 8-vCPU Rust
  Cloud Run service built from a combined C+Rust image; 15-min cap
  enforced in-app; resolver seam lets us move to per-game services later.
- **Two-human e2e = Playwright** (two `BrowserContext`s) for the one
  dual-UI realtime test; Cypress keeps the single-client tests.

## OPEN decisions — need Konstantin's call before/while implementing

1. **Does "23 playing" count AI games?** (003) — recommend **human-vs-human
   only**; one-line UNION to include AI later.
1. **Block exclusion direction** (004) — recommend exclude **both
   directions** (I-blocked-them AND they-blocked-me), matching the
   existing `/social/who`. Spec literally says only my-blocks.
1. **Per-move 15s timeout penalty** (009) — recommend **forfeit-loss**;
   alternative is auto-random move. Spec says "at most 15 seconds to
   think" without naming the penalty.
1. **Untimed 30-min cap terminal state** (009) — recommend **draw**.
1. **Win-stone lift animation: winner only, or both players see it?**
   (010) — recommend **both** see the winning line animate.
1. **`games` CHECK constraint** (008) — verify it admits `winner='draw'`
   for AI rows, or relax it in the premium-column migration.

## Deploy gate (must hold before `just deploy`)

The realtime design assumes one API process. Current IaC breaks that:

- `api_max_instances` defaults to **5** → players land on different
  instances and never see each other's `game.update`. **Pin to 1 for beta.**
- API Cloud Run service has **no `session_affinity`** and **no request
  `timeout`** (300s default) → idle WS cut every 5 min. **Add affinity;
  set `timeout=3600`.**
- `max_instance_request_concurrency=80` vs the spec's 100-connection
  ceiling → **raise to ≥100** (it's the WS connection cap).

These are tracked in [013](013-integration-hardening-deploy/) (H1–H5) and
[011](011-cloud-run-per-game-rust-infra/).
