# 011 — Cloud Run topology & per-game ephemeral Rust backend

## Goal

Define and implement the **Cloud Run deployment topology** that runs the
Gomoku stack in production, and add the **per-game ephemeral 8-vCPU Rust
backend** that powers AI "Hardest" (depth-9) games. This slice owns the
infrastructure: Terraform service definitions, Dockerfile/packaging strategy,
deploy wiring (`bin/deploy`, `iac/cloud_run/deploy.sh`, `just deploy`), and
the concrete implementation of the engine-resolution / teardown contract that
008 declared.

It does **not** own difficulty mapping, premium gating, the `games`-row
columns, or the in-app 15-minute timer/draw semantics — 008 (and 009) own
those. 011 guarantees that when 008 asks for a Hardest engine URL it gets one
backed by 8 vCPUs, and that the backend is gone after the game ends or the
15-minute cap fires.

## Target topology

Three runtime tiers, all on Cloud Run in one GCP project + region
(`us-central1`), per-environment state isolated by Terraform backend prefix:

1. **`gomoku-api` — always-on API + static assets (single warm instance).**
   FastAPI + bundled React SPA. Serves the SPA, auth, scoring, leaderboard,
   multiplayer, and proxies AI moves to the engines. Production runs
   **min-instances = 1** so the front page and (future) WebSocket connections
   land on a warm instance. Sized to hold up to **100 concurrent connections**
   on a single instance (the WebSocket fan-in target for 002/003), with
   session affinity on and request/stream timeout maxed so long-lived
   connections survive. Public (`allUsers` invoker).

1. **`gomoku-httpd` — C engine, shared, IAM-restricted.** Handles AI
   **Easy / Intermediate / Hard** (depths 3/5/7). Unchanged from today:
   `concurrency = 1`, `1 vCPU / 512Mi`, `min = 0` scale-to-zero,
   `max = 80`, invoker restricted to the API service account. The API
   reaches it via `GOMOKU_HTTPD_URL`.

1. **`gomoku-httpd-rust` — Rust engine, 8 vCPU, ephemeral per game.** Handles
   AI **Hardest** (depth 9) only. Scaled-to-zero dedicated Cloud Run service
   (the recommended option — see plan.md for the A/B/C evaluation). Sized at
   **8 vCPU** with the memory floor Cloud Run requires at that CPU count,
   `concurrency = 1`, `min = 0`, IAM-restricted to the API service account.
   The API resolves its URL through the 008 seam and is responsible (with
   008/009) for ensuring the game ends — at which point the instance idles
   back down to zero ("destroyed immediately" ≈ scale-to-zero for a solo-dev
   beta).

```
                       allUsers (public, custom domain)
                                  │
                          ┌───────▼────────┐
                          │   gomoku-api   │  min=1, concurrency≈100,
                          │  FastAPI + SPA │  session affinity, timeout maxed
                          └───┬────────┬───┘
              easy/inter/hard │        │ hardest (depth 9)
                              ▼        ▼
                  ┌────────────────┐  ┌──────────────────────┐
                  │  gomoku-httpd  │  │  gomoku-httpd-rust    │
                  │  C, 1 vCPU     │  │  Rust, 8 vCPU         │
                  │  conc=1 min=0  │  │  conc=1 min=0         │
                  │  IAM: api only │  │  IAM: api only        │
                  └────────────────┘  └──────────────────────┘
                                       (scale-to-zero ⇒ ephemeral)
```

## Hardest lifecycle requirement

- A Hardest game runs on an **8-vCPU** Rust backend.
- The game is **always** wall-clock-capped at **15 minutes** (cap value set by
  008 at `/game/start`; result on cap = **draw**).
- The 8-vCPU backend must be **gone after the game ends** (win/loss/draw) or
  when the 15-minute cap fires. 011 guarantees teardown so a runaway Hardest
  game can never hold 8 vCPUs longer than the cap.
- 011 implements the 008-declared seam:
  - `resolve_engine_url("hardest", game_id) -> url` — return a URL backed by
    8 vCPUs for this game.
  - `teardown_hardest(game_id)` — release the 8-vCPU capacity for this game.

## Dependencies

- **008 — AI difficulty & premium.** Declares the resolver/teardown interface
  (`resolve_engine_url(difficulty, game_id)`, `teardown_hardest(game_id)`),
  the difficulty→(depth,radius,engine) table, the `is_premium` /
  `payment_status` / `hardest_expires_at` columns, and the draw-on-cap
  outcome. 011 implements the infra side of that interface.
- **009 — timed games.** Shares the "expires_at → terminal state" mechanism;
  011 wires the teardown into the cap path 008/009 own.
- Current production Terraform (`iac/cloud_run/main.tf`) and deploy scripts
  (`bin/deploy`, `iac/cloud_run/deploy.sh`).

## WebSocket-on-Cloud-Run implications for the API service

The always-on API tier is the long-lived-connection host (WS push lands in
002/003). Cloud Run supports WebSockets but with constraints that this slice's
Terraform must satisfy so the API is WS-ready:

- **min-instances = 1** (already true in prod) — avoids cold-start dropping the
  first connection; keeps a warm pool member for pings.
- **Request timeout maxed (3600s)** — a WS connection counts as one long
  request; the default 300s would sever idle games. 15-min Hardest and 8-h
  multiplayer caps both fit under 3600s.
- **Session affinity on** — best-effort sticky routing so a client's WS and
  its polling/HTTP calls prefer the same instance (matters once in-memory
  presence/fan-out exists in 003).
- **Concurrency sized for ~100** — one warm instance must hold the target
  connection count; today's `80` is the AI-move fan-out contract and is raised
  here toward the 100-connection goal.
- Caveat carried into 002/003: Cloud Run still load-balances new connections
  across instances and can drain an instance on deploy/scale-down, so the WS
  layer must tolerate reconnects regardless of affinity. 011 only sizes the
  service; the reconnect protocol is 002/003's.

## Non-goals

- Difficulty→params mapping, premium gating, `games` columns, Elo (008).
- The in-app 15-minute countdown UI and draw finalization logic (008/009);
  011 only guarantees backend teardown at/under the cap.
- Real payment processing (future work).
- The WebSocket protocol / reconnect logic itself (002/003) — 011 only makes
  the API service WS-capable in infra terms.
- e2e Cypress topology (012 runs against local `gctl`, not Cloud Run).
