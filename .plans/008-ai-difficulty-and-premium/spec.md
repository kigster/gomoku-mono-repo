# 008 — AI difficulty modes & premium hardest

## Goal

Replace the free-form depth/radius knobs the web UI historically exposed
(capped at depth 5) with four named, opinionated difficulty modes. Three
of them ("Easy", "Intermediate", "Hard") run on the existing C
`gomoku-httpd` Cloud Run service. The fourth ("Hardest") is a **premium**
mode ($1, free during beta) that runs on a stronger, per-game ephemeral
Rust `gomoku-httpd-rust` container provisioned by task 011, is always
hard-capped at 15 minutes, and tears the backend down immediately when the
game ends or the cap is hit (the cap result is a draw).

This slice owns:

- The **single source of truth** mapping difficulty → `(depth, radius, engine)`, consumed by both the frontend (button labels) and the backend
  (engine routing).
- The **backend routing** decision (C vs the 011 Rust resolver) and the
  abstraction (`resolve_engine_url(difficulty, game_id)`) that 011 plugs
  the ephemeral path into.
- **Premium gating** with a beta-free bypass and a clean seam for real
  payment later, plus the `games`-row column that records premium/paid
  status.
- The **15-minute cap → draw** semantics for AI-hardest games (011 enforces
  the teardown; this slice sets the cap and the draw-on-cap outcome).
- The **Elo rating** for the new depth-9 tier.

## Difficulty → (depth, radius, engine) table

This table is **verbatim** from the umbrella spec's "Game Starting
Instructions" slice and is the canonical contract. It lives as a backend
constant (see plan.md) — nothing else may redefine these numbers.

| Difficulty | Radius | Depth | Engine | Container | Premium |
| ------------ | ------ | ----- | ---------------------------- | ------------------ | ------- |
| Easy | 2 | 3 | C `gomoku-httpd` | shared (Cloud Run) | no |
| Intermediate | 2 | 5 | C `gomoku-httpd` | shared (Cloud Run) | no |
| Hard | 2 | 7 | C `gomoku-httpd` | shared (Cloud Run) | no |
| Hardest | 2 | 9 | Rust `gomoku-httpd-rust` | per-game, 8 vCPU | **yes** |

Hardest-mode container requirements (consumed by 011):

- 8 vCPUs.
- Spun up for the game, torn down immediately after the game ends.
- The game is **always** capped to 15 minutes of wall-clock; at the cap the
  backend is destroyed and the result is recorded as a **draw**.

Button label for Hardest (verbatim, owned visually by 007):

> ...Hardest Mode (Premium Game: $1 — Play for Free during Beta Testing)

## Premium / beta-free rules

- Hardest mode is the only premium mode. Its nominal price is **$1**.
- A **beta flag** (`PREMIUM_BETA_FREE`, config/env, default `true` for now)
  bypasses payment entirely: a request for Hardest while the flag is on is
  admitted as a free premium game.
- When the flag is `false` (post-beta), the same code path becomes the seam
  where a real payment check is enforced before the Rust container is
  provisioned. Real payment integration is **out of scope** (future work) —
  this slice only leaves the seam and the recorded state.
- Every Hardest game records its premium/paid status on the `games` row
  (`is_premium`, `payment_status`) so we can later reconcile paid vs
  beta-free games and bill correctly.

## 15-minute hardest cap → draw + teardown

- A Hardest (depth-9, Rust) game has a hard 15-minute wall-clock cap, set at
  `/game/start` (`hardest_expires_at = started_at + 15 min`).
- If the cap is reached before a winner, the game is finalized as a **draw**
  and the per-game Rust backend is destroyed.
- **Who enforces what:**
  - This slice (008) defines the cap value, stores `hardest_expires_at`, and
    defines the draw-on-cap outcome + Elo treatment (draw → score 0.5).
  - 011 owns the lifecycle mechanics: provisioning the 8-vCPU container,
    the wall-clock teardown daemon/Cloud Run timeout that destroys it at the
    cap, and calling back to finalize the row as a draw.
  - 009 owns the generic human-game timer/overlay; the Hardest cap reuses
    the same "expires_at → terminal state" pattern but is AI-specific and
    non-negotiable (no per-move clock, just the 15-minute ceiling).

## Dependencies

- **007 (game-type modal redesign)** — renders the four difficulty buttons
  and the premium Hardest button; pulls labels/params from this slice's
  config endpoint/constant. 008 owns the data, 007 owns the layout.
- **011 (Cloud Run per-game Rust infra)** — implements
  `resolve_engine_url("hardest", game_id)` (provision 8-vCPU Rust container)
  and `teardown_hardest(game_id)`, and enforces the 15-minute teardown. 008
  defines the interface; 011 implements it.
- **009 (timed games & timeouts)** — generic human-vs-human timers. Overlaps
  only in the "expires_at → terminal state" mechanism; the Hardest cap is
  separate and AI-specific.

## Non-goals

- Modal layout / button styling (007).
- The ephemeral Rust container infrastructure itself (011) — only its
  contract is defined here.
- Generic human-game per-move/total timers (009).
- Real payment processing / Stripe / receipts (future work). Only the
  beta-free bypass and the payment seam are in scope.
- Exposing arbitrary depth/radius to the web UI — the four named modes are
  the only web surface. The TUI keeps its full range independently.
