# 013 — Integration, Hardening & First Cloud Run Deploy

> Final slice of the umbrella spec
> ([`001-clarification-simplification/spec.md`](../001-clarification-simplification/spec.md)).
> This task owns nothing user-facing of its own — it is the **integration
> gate, production hardening, observability, and deploy runbook** that turns
> the work of 002–012 from "merged" into "green everywhere and live on Cloud
> Run."

## Goal (verbatim user goal)

> "all of the tests are passing and the new e2e Cypress tests are written and
> are able to play a game pretending to be humans." And finally: **deploy to
> Cloud Run** (which never happened before).

Two concrete outcomes:

1. **Green everything.** `just test` (C engine + gomoku-httpd + Rust unit/doc
   - API pytest including the new WS/matchmaking/handshake/timer/chat suites +
     frontend vitest) and `just e2e` (two-human Cypress) both pass on a clean
     checkout — and the same gate stays green in GitHub Actions.
1. **First-ever Cloud Run deploy.** The multiplayer re-architecture (which the
   previous version never shipped) reaches **staging then production** Cloud
   Run via `just deploy`, with WebSockets working through the load balancer, a
   documented single-instance guardrail, a smoke checklist, and a rollback
   plan.

This slice explicitly does **not** implement features 002–011, nor design the
e2e harness (012). It **verifies** the seams between them, hardens the runtime
for WebSockets on Cloud Run, adds the mandatory telemetry spans, and ships.

______________________________________________________________________

## Why this task exists

The previous multiplayer version "had MANY bugs and was NEVER deployed to
Cloud Run." The recurring failure mode was **integration between slices**, not
the slices in isolation: WS auth handing off to presence, presence feeding
matchmaking, matchmaking handing a proposal to the handshake, the handshake
creating a game that the timer service then has to own, the chat lifecycle
keying off the same `game.update` that drives the board, and Elo/animation
firing on the terminal transition. Each slice (002–011) tests itself; **nobody
tests the chain.** That chain is what 013 owns, plus the runtime facts that
only bite in production (WebSockets + Cloud Run autoscaling + an in-memory
connection manager).

______________________________________________________________________

## Test-surface inventory (everything that must be green)

Every surface below must pass before deploy. The canonical command is
`just test` + `just e2e`; the table maps each surface to the recipe that runs
it (recipes verified in `just/justfile.test` and `just/justfile.e2e`).

| # | Surface | Recipe | What it covers | New in 002–012? |
| - | ------- | ------ | -------------- | --------------- |
| 1 | C engine + gomoku-httpd protocol e2e | `just test-gomoku-c` (`make -C gomoku-c test`) | engine correctness, daemon HTTP protocol | no |
| 2 | gomoku-httpd daemon unit only | `just test-daemon` (`make -C gomoku-c test-daemon`) | daemon unit tests (also run by lefthook pre-commit) | no |
| 3 | Rust unit + doc tests | `just test-rust` (`cd gomoku-httpd-rust && just test`) | depth-9 engine used by AI-hardest (008/011) | engine unchanged; routing new |
| 4 | Rust integration smoke | `just test-rust-integration` (CI/`just ci` only, not `just test`) | daemon + two clients end-to-end | no |
| 5 | API pytest (5 xdist workers, per-worker `gomoku_test_gw{N}` DB) | `just test-api` | **WS lifecycle (002), presence counts (003), matchmaking selection (004), ready/color handshake (005), chat `/like` `/boo` lifecycle (006), timed-game deadlines (009), premium gating (008)** | **YES — the bulk of new coverage** |
| 6 | Frontend vitest | `just test-frontend` | `useGameSocket`, presence hook, modal routing (007), chat panel countdown (006), win animation (010) | **YES** |
| 7 | Ruby schema-validator | `just test-validate-games` (part of `test-all`) | stored-game JSON schema | no |
| 8 | Two-human e2e (012) | `just e2e` (restarts cluster `-r`, runs `npx cypress run --e2e`) | **two browsers match via Elo, handshake, play a full game, see win animation, chat closes** | **YES — the headline deliverable** |

**Single "all green" sequence:** `just test` (= surfaces 1,2-via-c,3,5,6,7) →
`just e2e` (= surface 8). The full CI gate `just ci` additionally runs `just check` (format) + `test-rust-integration` (surface 4). 013 requires **all of
`just ci` plus `just e2e` green**, and the same suites green in GitHub Actions
(`api-test.yml`, `c99.yml`, `frontend.yml`, `rust-build.yml`, `ruby.yml`,
`api-lint.yml`).

> **Note / risk:** `test-all` runs `test-gomoku-c` (engine + protocol) but NOT
> `test-daemon` (daemon-unit-only) — `test-daemon` is exercised by lefthook
> pre-commit and is a subset of the C build. 013 keeps both in the gate via
> pre-commit so the daemon-unit suite is never skipped.

______________________________________________________________________

## Cross-task integration-risk list (the seams that hid bugs)

These are the inter-slice boundaries 013 must verify with explicit e2e/integration
coverage. Each is a place where two independently-green slices can disagree on
the wire contract, ordering, or state ownership.

1. **WS auth ↔ session.** Does `/ws` (002) reject the same expired/invalid JWT
   the HTTP API rejects (R9 parity)? A token good for HTTP but mishandled at
   the WS handshake silently drops a player out of every realtime feature.
1. **WS connect ↔ presence set (002→003).** On socket connect, is the user
   added to the online set *before* the first `presence.count` is pushed, and
   removed on disconnect? Two-tab dedup (one person, not two) must hold.
1. **Presence set ↔ matchmaking pool (003→004).** Matchmaking eligibility reads
   "online and not playing." If presence and matchmaking disagree on who is
   online/in-game, you match against a ghost or skip a live player.
1. **Matchmaking proposal ↔ handshake (004→005).** 004 hands 005
   `{requester, candidate, elos}`; 005 must emit `match.found` to both and
   handle decline/expire back to 004's re-offer loop without leaking a
   half-created game.
1. **Handshake ↔ game creation ↔ game.update (005→002).** 005 creates the
   `multiplayer_games` row `in_progress` with both player ids and color
   assignment, then `game.start`; from there moves flow over the HTTP POST and
   push `game.update`. The seam: does the row 005 writes match exactly what
   `_build_view` serializes, including the new `game_type='multiplayer'`,
   `timed`, and color fields?
1. **game.update ↔ chat lifecycle (002→006).** Chat panel injects the system
   message on the waiting→in_progress transition and runs the 3-2-1 countdown
   on the terminal transition — both keyed off `game.update`. A missed or
   duplicated transition flashes or strands the chat.
1. **Chat `/boo` ↔ matchmaking pool (006→004).** A `/boo` writes `blocks` and
   wipes friendships; 004 must exclude blocked users on the *next* match. Seam:
   block written mid-game must not affect the in-progress game but must affect
   the next selection.
1. **Game creation ↔ timers (005/007→009).** The "Timed Game" checkbox (007)
   sets `timed` at creation (005); 009 must read it and arm per-move + whole-game
   deadlines. Seam: deadline columns populated atomically with the row, enforced
   server-side, pushed over WS.
1. **Timer fire ↔ game.update ↔ Elo (009→004→010).** A timeout-draw and a real
   win must both produce a terminal `game.update` that (a) triggers Elo
   transaction (004, single DB transaction subtract/add) and (b) triggers the
   win animation + Elo-celebration (010) on the right client.
1. **Win detection ↔ winning-cells animation (engine→010).** The 5 winning
   stones must be identified server-side and carried in the payload so the
   frontend can lift/shine them; a client-only win detector drifts from the
   authoritative engine.
1. **AI-difficulty routing ↔ engine (008→C/Rust).** Easy/Intermediate/Hard →
   C `gomoku-httpd`; Hardest → Rust per-game container (011). Seam:
   `resolve_engine_url(difficulty, game_id)` must route correctly and the
   15-min cap → draw must fire and tear the Rust container down.
1. **Reconnect ↔ resync (002).** After a socket gap, the client GET-resyncs;
   presence, chat, timers must reconcile to server truth rather than trust a
   possibly-dropped frame.

An **integration test matrix** mapping each seam to its verification lives in
`plan.md`.

______________________________________________________________________

## WebSocket-on-Cloud-Run production constraints

These are hard runtime facts the previous (never-deployed) version never had
to confront. They constrain the deploy.

1. **In-memory connection manager is single-instance.** 002's connection
   manager is in-process (no Redis / LISTEN-NOTIFY — explicitly deferred in
   002's non-goals). A `game.update`, `presence.count`, or `match.found` only
   reaches sockets **on the same instance**. At >1 API instance, two players
   load-balanced to different instances **never see each other's events** —
   silent, total breakage of every realtime feature. **Guardrail for beta: cap
   the API service at `min=1, max=1`.**
1. **Request/stream timeout.** Cloud Run's default request timeout (300 s)
   terminates idle streams; a WS connection must be kept alive by 002's
   heartbeat (R6) AND the service timeout raised toward the 3600 s max so
   long-lived idle sockets aren't culled mid-game.
1. **Session affinity.** With max=1 affinity is moot, but it must be **on** as
   defense-in-depth and as the prerequisite for ever raising max>1 — and it is
   currently **not set** in `iac/cloud_run/main.tf`.
1. **100-connection ceiling.** The umbrella spec sizes the always-on API for
   "up to 100 connections." `max_instance_request_concurrency` is currently
   `80` on the API; WS connections count as in-flight requests for the whole
   socket lifetime, so the concurrency limit *is* the connection ceiling. Must
   be set to ≥100 for the single instance to hold the stated load.
1. **min-instances=1 (always-on).** Already the production default
   (`api_min_instances=1`); required so the socket endpoint and presence set
   are never cold. Staging defaults to 0 — must be raised to 1 for any
   meaningful WS smoke test.
1. **Reconnect storms.** A deploy/instance-restart drops every socket at once;
   all clients reconnect simultaneously. 002's exponential backoff (R7) plus
   the GET-resync path (R8) must absorb this without a thundering herd against
   `GET /multiplayer/{code}`.

The hardening checklist (Terraform diffs + guardrail) is in `plan.md`.

______________________________________________________________________

## Observability (HARD RULE: telemetry mandatory)

Honeycomb/OTEL is mandatory (CLAUDE.md Hard Rule 1; `api/app/telemetry.py`
wires the TracerProvider + OTLP exporter, auto-instrumenting FastAPI/httpx/
asyncpg). The new realtime paths are **not** HTTP requests, so FastAPI
auto-instrumentation does not cover them — they need **explicit manual spans**.
The required span list is in `plan.md`; without them, WS connect/disconnect,
matchmaking, handshake, and timeout events are invisible in production, which
violates Hard Rule 1.

______________________________________________________________________

## Definition of Done — mapped to umbrella-spec bullets

Each umbrella requirement must be provable by a named test or smoke step (full
table with the proving test in `plan.md`). Summary of what must be true:

- [ ] Load-time modal shows **real** "N online / M playing", pushed over WS (001 ¶1; 003).
- [ ] Top toggle "Play with AI | Play with a Elo-Matched Human" routes correctly (001 ¶2; 007).
- [ ] Elo-matched human flow: closest non-playing opponent, both see "Ready?" with correct wording (001 ¶3-4; 004/005).
- [ ] Color negotiation truth table (black/white/dontcare, dice on collision) resolves and assigns (001 ¶4.i-iv; 005).
- [ ] Move push: both players receive full game JSON over WS (001 caution; 002).
- [ ] Six stacked 75%-width buttons with verbatim copy (001 ¶25; 007).
- [ ] Timed-game checkbox → 15 s/move + 5 min draw cap; untimed → 30 min expiry (001 ¶34-36; 009).
- [ ] Timers shown at top of board next to whose-turn (001 ¶38; 009).
- [ ] Win animation: 5 stones lift + diamond shine, loops until Back (001 ¶40; 010).
- [ ] Upset celebration: A beats B where B's Elo ≥ A+100 → fireworks + level-up message (001 ¶42; 010).
- [ ] AI difficulty → (depth,radius,engine) per table; Hardest on Rust 8-vCPU per-game, 15-min cap → draw (001 ¶46-49; 008/011).
- [ ] Chat reduced to `/boo` + `/like` + `/help` + free text; system join message; 3-2-1 post-game close (001 chat section; 006).
- [ ] `/boo` excludes from future matchmaking; everyone starts Elo 1500; Elo recorded in single transaction (001 chat/feature changes; 004).
- [ ] No-humans-available branch offers AI buttons (001 ¶79-86; 007/004).
- [ ] WS stays open idle for invitations (001 ¶23; 002).
- [ ] **Two humans match + play a full game in Cypress e2e** (user goal; 012).
- [ ] **`just ci` + `just e2e` green locally and in GitHub Actions** (user goal).
- [ ] **Deployed to Cloud Run staging then production with WS working** (user goal; 013).

______________________________________________________________________

## Dependencies

**All of 002–012.** This is the terminal integration task; it cannot be
verified until every upstream slice is merged:

| Task | What 013 depends on it for |
| ---- | -------------------------- |
| 002 WS transport | the socket every realtime feature and every WS span rides on |
| 003 presence | online/playing counts; the online set matchmaking consumes |
| 004 matchmaking + Elo | candidate selection; the transactional Elo award |
| 005 ready/color handshake | the match→game creation seam |
| 006 chat | `/boo`/`/like` lifecycle; the post-game countdown |
| 007 modal redesign | the launcher that routes every click |
| 008 AI difficulty + premium | engine routing; premium gating; 15-min cap |
| 009 timed games | per-move + whole-game deadlines, server-enforced |
| 010 win animation + Elo celebration | terminal-state animation + upset fireworks |
| 011 Cloud Run per-game Rust infra | the ephemeral 8-vCPU hardest path + topology |
| 012 e2e two-human Cypress | the harness `just e2e` drives (013 owns the green gate, not the harness design) |

______________________________________________________________________

## Non-goals (owned elsewhere)

- Implementing any 002–011 feature behaviour.
- Designing the e2e harness / Cypress page objects (012).
- Multi-instance WS fan-out (Redis / LISTEN-NOTIFY) — explicitly deferred;
  013 documents the limit and the max=1 guardrail instead of solving it.
- Real payment for premium hardest (008 keeps the beta-free bypass).
