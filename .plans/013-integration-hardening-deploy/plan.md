# 013 — Integration, Hardening & Deploy — plan

Derived from `spec.md`. Owner: Zeus; verifier: Jeff. This is the terminal
integration task — it consumes 002–012 and produces a green gate + a live
Cloud Run deployment. It changes runtime config (Terraform), adds telemetry
spans, and defines runbooks; it implements no user-facing feature.

## Decisions up front

- **ASSUMPTION:** the beta runs the API at **a single instance** (`min=1, max=1`). 002's connection manager is in-process; multi-instance fan-out is
  out of scope. The deploy *guardrail* below enforces this; raising max>1 is a
  follow-up that requires a shared backplane.
- **ASSUMPTION:** staging and production are separate Cloud Run services in the
  same project (`gomoku-api-staging` / `gomoku-api`), selectable via
  `bin/deploy staging|production` — confirmed by `bin/deploy` and
  `variables.tf` (the env-suffixed service names already exist).
- **OPEN:** does `just e2e` get a CI lane, or stay local-only? It currently
  restarts the local cluster (`bin/gctl start -r`) — heavy for GH Actions.
  Recommend: keep `just e2e` as a **mandatory local/dev pre-push gate** for
  013, file a follow-up to containerize it for CI. Flagged for the user.
- **OPEN:** Honeycomb separate environments for staging vs prod, or one env
  keyed by `deployment.environment` resource attr? `telemetry.py` already
  stamps `deployment.environment`; recommend one Honeycomb env for beta, split
  later. Flagged.

______________________________________________________________________

## 1. The "all green" command sequence

Run from a clean checkout, in order. Each must exit 0 before the next.

```bash
just check                 # format gate (check-all)
just test                  # surfaces 1,3,5,6,7 — see spec inventory
just test-rust-integration # surface 4 (daemon + two clients)
just e2e                   # surface 8 — two-human Cypress (restarts cluster -r)
```

Equivalent single command for surfaces 1–7: **`just ci`** (= `check` +
`test-all` + `test-rust-integration` + `e2e`). 013 requires `just ci` green
**and** the GitHub Actions suites green: `api-test.yml`, `c99.yml`,
`frontend.yml`, `rust-build.yml`, `ruby.yml`, `api-lint.yml`.

**What must hold:**

- `just test-api` runs 5 xdist workers, each on its own `gomoku_test_gw{N}` DB
  (`POSTGRESQL_PORT` default 5433). The NEW suites (WS/presence/matchmaking/
  handshake/timer/chat/premium) must be xdist-safe — no cross-worker shared
  state, each worker isolates its own connection manager and DB.
- `just e2e` two-human flow must pass deterministically (no sleep-based flakes;
  drive on WS pushes / `cy.intercept`, per Hard Rule 4 "no retries to paper
  over flakes").
- lefthook pre-commit (which runs `just test-api`, `just test-daemon`,
  `just test-frontend`, rust fmt/clippy/test/doc, ruff, ty, codespell,
  detect-secrets) must pass — it is the commit/push gate.

______________________________________________________________________

## 2. Integration test matrix

Each seam from `spec.md` → how it is verified → which test owns the proof.
Where a seam has no existing owner, 013 adds the integration test (marked
**[013]**).

| # | Seam | How verified | Test |
| - | ---- | ------------ | ---- |
| 1 | WS auth ↔ HTTP auth parity | connect `/ws` with expired + invalid + valid JWT; assert reject == HTTP 401 shape | pytest `test_ws_auth` (002) |
| 2 | WS connect ↔ presence set | connect 2 sockets/1 user → online==1; disconnect → 0; assert push on each | pytest `test_presence_*` (003) |
| 3 | presence ↔ matchmaking pool | seed online users with elos; request `closest`/`above`/`below`; assert ghost/offline excluded | pytest `test_matchmaking_pool` (004) |
| 4 | matchmaking ↔ handshake | inject proposal → assert `match.found` to both; decline → re-offer; no orphan game row | pytest `test_handshake_from_match` (005) **[013 asserts no orphan]** |
| 5 | handshake ↔ game.update | run handshake → row created → assert `_build_view` output == `game.start` payload fields (color, timed, game_type) | pytest `test_match_creates_game` (005) **[013 cross-check serializer]** |
| 6 | game.update ↔ chat lifecycle | drive waiting→in_progress→won; assert join system msg once + 3-2-1 countdown once | vitest `ChatPanel` (006) + e2e |
| 7 | `/boo` ↔ next-match exclusion | A `/boo` B mid-game; finish; A re-matches → B excluded | pytest `test_block_excludes` (004/006) **[013]** |
| 8 | timed checkbox ↔ deadlines | create timed game; assert per-move + whole-game `TIMESTAMPTZ` armed atomically | pytest `test_timed_deadlines` (009) |
| 9 | timer fire ↔ game.update ↔ Elo | force per-move + 5-min timeout; assert draw `game.update` + Elo txn (subtract==add) | pytest `test_timeout_draw_elo` (009/004) **[013 chain]** |
| 10 | win cells ↔ animation | engine reports 5 cells; assert payload carries them; frontend lifts them | pytest engine + vitest `WinAnimation` (010) |
| 11 | AI difficulty ↔ engine routing | `resolve_engine_url(d,id)` → C for easy/intermediate/hard, Rust for hardest; cap→draw | pytest `test_resolve_engine` (008) + Rust (011) |
| 12 | reconnect ↔ resync | drop socket mid-game; reconnect; assert GET-resync reconciles board+timer+chat | e2e (012) + vitest `useGameSocket` (002) |
| **E2E** | **full two-human chain** | **two browsers: match by Elo → ready/color → play to win → animation → chat closes** | **`just e2e` (012)** |

The **headline integration proof** is row E2E: it exercises seams 1–6, 9–10,
and 12 in one run. The pytest rows give fast, deterministic coverage of the
same seams below the browser.

______________________________________________________________________

## 3. Migration ordering & consolidation review

The umbrella work adds several migrations (presence, timed columns, premium
column, winning_cells, etc.) on top of the shipped chain ending at
`20260526-180000-online-users-opponent-presence.py`. Review before
`just deploy` runs `alembic upgrade head` against the prod DB.

**Review checklist (do BEFORE staging deploy):**

1. **Linear chain, no branch.** `cd api && uv run alembic heads` returns
   **exactly one** head. Branching heads (two slices both branching off the
   same `down_revision`) is the classic merge-conflict failure — resolve with
   an `alembic merge` revision, do **not** hand-edit `down_revision`.
1. **Timestamped, ordered filenames.** New revisions follow the
   `YYYYMMDD-HHMMSS-slug.py` convention and sort *after* `20260526-180000`.
1. **Forward-only & additive.** Every new migration is **additive** (new
   tables / nullable columns / new index) so it is safe to apply to the live
   prod DB *before* the new image is serving. Columns the new code requires
   non-null must ship nullable-with-default first (expand), backfill, then
   tighten in a later migration (contract) — never a non-null add on a
   populated table in one shot.
1. **Consolidation:** if 003/008/009/010 each added a one-column migration to
   the same table (`games` / `multiplayer_games`), prefer leaving them as
   separate atomic revisions (cleaner history, each reversible) **unless** they
   were authored on diverging branches — then a single merge revision is
   required to linearize. Do not squash already-shipped revisions.
1. **`downgrade()` present and correct** on each new revision (rollback depends
   on it — see runbook).
1. **`just deploy` Alembic-on-prod risk:** `bin/deploy` runs
   `alembic upgrade head` against `PRODUCTION_DATABASE_URL` (Neon) **before**
   the new image is deployed. Mitigations: (a) additive-only rule above makes
   old code tolerate new schema; (b) run the **staging** deploy first against
   `STAGING_DATABASE_URL` to prove the migration applies cleanly on a
   prod-shaped DB; (c) Neon branch the prod DB immediately before prod
   migrate so rollback is a branch-restore, not a hand-written `downgrade`.

______________________________________________________________________

## 4. WebSocket production hardening checklist (Terraform)

All diffs land in `iac/cloud_run/main.tf` / `variables.tf`. Current state
(verified): API service has **no** `session_affinity`, **no** explicit request
`timeout`, `max_instance_request_concurrency = 80`, `api_min_instances`
default 1, `api_max_instances` default **5**.

| # | Change | Current | Target | Why |
| - | ------ | ------- | ------ | --- |
| H1 | **API max instances = 1 (beta guardrail)** | `api_max_instances=5` | `1` | in-memory connection manager: >1 instance silently breaks all realtime delivery (see failure mode below) |
| H2 | min instances = 1 | already 1 (prod) | 1 (prod **and** staging for smoke) | always-on socket + presence set never cold |
| H3 | Request/stream `timeout` | unset (300 s default) | `timeout = "3600s"` on the API `template` | 300 s default culls idle WS mid-game; heartbeat (002 R6) + raised timeout keep it alive |
| H4 | `session_affinity = true` | unset | `true` | defense-in-depth; prerequisite for ever raising H1 |
| H5 | `max_instance_request_concurrency` | 80 | **≥100** | WS connections are in-flight requests for the whole socket lifetime; this *is* the connection ceiling the umbrella spec sizes at 100 |
| H6 | API CPU/memory | `1000m / 512Mi` | keep (revisit if 100 idle sockets pressure memory) | sockets are cheap idle; watch in Honeycomb |

**Documented >1-instance failure mode (the guardrail's reason):**

> 002's `ConnectionManager` lives in process memory. `send_to_user` /
> `broadcast_to_users` only reach sockets registered on **the same instance**.
> With `max>1`, Cloud Run round-robins/affinity-routes the two players of a
> match to potentially different instances. Result: player A's move commits and
> pushes `game.update`, but player B (on another instance) is not in A's
> instance's manager and **never receives the frame** — board freezes,
> presence counts diverge per-instance, `match.found` never arrives. This is
> silent (no error, no log), which is exactly how the previous version "had
> many bugs." **Mitigation for beta: H1 caps at 1.** Lifting the cap requires a
> shared backplane (Redis pub/sub or Postgres LISTEN/NOTIFY) — explicitly out
> of scope (002 non-goal), tracked as the post-beta scaling task.

**Reconnect-storm guardrail:** on deploy/restart every socket drops at once.
Rely on 002's exponential backoff (R7) + GET-resync (R8). Verify in the smoke
checklist by redeploying staging while two clients are connected and confirming
they reconnect + resync without a board desync.

______________________________________________________________________

## 5. Observability — spans to add

`api/app/telemetry.py` installs the TracerProvider + OTLP→Honeycomb exporter
and auto-instruments FastAPI (HTTP server spans), httpx (engine calls), and
asyncpg (DB). The realtime paths are **not** HTTP requests → no auto-coverage →
add **manual spans** via `trace.get_tracer("gomoku.ws")` (Hard Rule 1:
telemetry mandatory). Attach attributes, not PII beyond `user_id`.

| Span name | Where | Key attributes |
| --------- | ----- | -------------- |
| `ws.connect` | `/ws` handshake (002), after JWT decode | `user.id`, `auth.ok`, `conn.count_for_user` |
| `ws.disconnect` | connection-manager teardown | `user.id`, `reason`, `duration_ms` |
| `ws.send` (or count metric) | `send_to_user` / `broadcast_to_users` | `msg.type`, `recipient_count` (sample, don't span every frame) |
| `presence.recompute` | online/playing recompute (003) | `online`, `playing` |
| `matchmaking.select` | candidate selection (004) | `mode`, `pool_size`, `chosen.elo_delta`, `result` (found/empty) |
| `handshake.run` | ready/color state machine (005) | `outcome` (matched/declined/expired), `color_assignment`, `dice_used` |
| `game.timeout_fired` | timer service (009) | `regime` (timed/untimed/ai-hardest), `kind` (per-move/whole-game), `game.id` |
| `elo.apply` | Elo transaction (004) | `winner.delta`, `loser.delta`, `game.id` (assert subtract==add) |
| `engine.resolve` | `resolve_engine_url` (008/011) | `difficulty`, `engine` (c/rust), `premium`, `ephemeral` |

Propagation note: `telemetry.py` already injects W3C `traceparent` into httpx
calls to gomoku-httpd, so AI-move spans correlate across the C/Rust hop. The
WS spans give the otherwise-invisible realtime path the same visibility.
Honeycomb deploy markers are posted by `bin/deploy` (needs
`HONEYCOMB_CONFIG_API_KEY`).

______________________________________________________________________

## 6. Deploy runbook

Order is mandatory. Hard Rules: browser-test before push, lefthook pre-commit
must pass, wait for CI after push, never `--force` (use `--force-with-lease`),
PR base always `main`.

**Phase A — local verification**

1. `just check && just test && just test-rust-integration` → all green.
1. `bin/gctl stop || true; bin/gctl start -r` then `just e2e` → two-human flow
   green.
1. **Browser-test on `https://dev.gomoku.games`** (Hard Rule 2): two browser
   profiles, match by Elo, play to a win, watch animation + chat close; start
   one AI-hardest game and confirm it provisions + tears down.

**Phase B — commit, push, CI**

4. Commit on the feature branch (NOT main). lefthook pre-commit runs the full
   suite — must pass. Atomic commits, agent-prefixed subjects.
1. `git push --force-with-lease` (never `--force`). Open PR with base `main`.
1. **Wait for CI** (Hard Rule 3): `Monitor` running
   `bash .claude/scripts/ci-watch.sh <PR>` until `CI_DONE:PASS`. On red, fix
   the root cause (Hard Rule 4 — no band-aids), push, re-watch; ≤3 cycles then
   ask the user.

**Phase C — staging deploy + smoke**

7. Pre-migrate review: `cd api && uv run alembic heads` → single head (§3).
1. `just deploy staging` (= `bin/deploy staging`): GCP creds → Alembic on
   `STAGING_DATABASE_URL` → frontend build → images + `terraform apply` (with
   H1–H5 applied, staging `min=1`) → Honeycomb marker.
1. **Staging smoke checklist** (§7) — must pass before prod.

**Phase D — production deploy**

10. Neon-branch the prod DB (rollback safety net, §"rollback").
01. `just deploy production` (= `bin/deploy production`): Alembic on
    `PRODUCTION_DATABASE_URL` → images → `terraform apply` → Honeycomb marker.
01. Re-run the smoke checklist (§7) against `app.gomoku.games`.

**Rollback plan**

- **App/image rollback:** Cloud Run keeps prior revisions; roll back traffic to
  the last-good revision (`gcloud run services update-traffic … --to-revisions <prev>=100`) — instant, no rebuild. Terraform uses
  `TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST`, so confirm traffic pinning vs. a
  re-apply that would re-point to latest.
- **Schema rollback:** preferred = **restore the pre-migrate Neon branch**
  (step 10). Fallback = `alembic downgrade -1` *only if* every new revision has
  a correct `downgrade()` (§3.5) and the additive rule held (so old image
  tolerates the half-state during the window).
- **Reconnect impact:** any rollback restarts instances → drops sockets →
  clients backoff-reconnect + GET-resync (acceptable; verified in smoke).

______________________________________________________________________

## 7. Staging smoke checklist

Run against `https://staging.gomoku.games` after `just deploy staging`. Each
must pass before promoting to prod.

- [ ] `/health` returns 200; front page loads (min=1, no cold blank tab).
- [ ] Two distinct logged-in browsers see the **same** live online/playing
  counts update in realtime (proves presence push over WS, single instance).
- [ ] Two humans **match by Elo** (closest), both get "Ready?", both accept,
  color negotiation resolves, game starts.
- [ ] One player moves → the OTHER browser's board updates over WS (no manual
  refresh) — the core push.
- [ ] `/like` and `/boo` work; post-game chat shows the 3-2-1 countdown and
  closes; a `/boo`'d player is excluded from the next match.
- [ ] Timed game: per-move 15 s + 5 min cap render at top and a timeout ends
  the game as a draw; Elo applied in one transaction.
- [ ] Win: 5-stone lift + shine animation loops; an upset (≥100 Elo) shows
  fireworks + level-up.
- [ ] **AI-hardest** game **provisions** the Rust 8-vCPU container, plays, hits
  the 15-min cap → draw, and the container **tears down** (verify in Cloud
  Run + Honeycomb `engine.resolve`/teardown spans).
- [ ] Redeploy staging while two clients are connected → both reconnect +
  resync without a board desync (reconnect-storm guardrail).
- [ ] Honeycomb shows the new WS/matchmaking/handshake/timeout spans + the
  deploy marker.

______________________________________________________________________

## 8. Definition-of-Done — proof per umbrella requirement

| Umbrella requirement | Proof |
| -------------------- | ----- |
| Real-time online/playing counts (001 ¶1) | pytest `test_presence_*` + smoke counts update |
| AI ↔ Human toggle routing (001 ¶2) | vitest modal-routing (007) + e2e |
| Closest non-playing Elo match + "Ready?" wording (001 ¶3-4) | pytest matchmaking + handshake; e2e two-human |
| Color truth table + dice (001 ¶4.i-iv) | pytest `test_color_resolution` (005) |
| Move pushed as full JSON to both (001 caution) | pytest `test_move_broadcast` (002) + e2e |
| Six 75%-width buttons, verbatim copy (001 ¶25) | vitest modal snapshot (007) |
| Timed 15 s/5 min, untimed 30 min (001 ¶34-36) | pytest `test_timed_deadlines` (009) + smoke |
| Timers at top next to turn (001 ¶38) | vitest board-header (009) + e2e |
| Win animation lift+shine loop (001 ¶40) | vitest `WinAnimation` (010) + e2e + smoke |
| Upset fireworks ≥100 Elo (001 ¶42) | pytest Elo-delta + vitest celebration (010) |
| AI difficulty table + Rust hardest 8-vCPU 15-min→draw (001 ¶46-49) | pytest `resolve_engine` + Rust (011) + smoke teardown |
| Chat = /boo //like //help only; join msg; 3-2-1 close (001 chat) | pytest chat lifecycle + vitest countdown (006) |
| /boo excludes future matches; Elo 1500 start; single-txn Elo (001) | pytest `test_block_excludes` + `test_elo_txn` (004) |
| No-humans branch → AI buttons (001 ¶79-86) | vitest + e2e empty-pool path |
| Idle WS receives invitations (001 ¶23) | pytest `test_idle_invite` (002/004) |
| Two humans play a full e2e game | **`just e2e` green (012)** |
| All tests green locally + CI | **`just ci` + GH Actions green** |
| Deployed to Cloud Run staging + prod, WS working | **smoke checklist §7 passes on both** |

______________________________________________________________________

## 9. Risk register

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| `api_max_instances>1` lets a realtime feature silently break | High if H1 forgotten | Critical | **H1 hard guardrail = 1**; document failure mode; alert if revision shows >1 |
| Cloud Run 300 s timeout culls idle WS | High (default) | High | H3 `timeout=3600s` + 002 heartbeat |
| Migration branches into two Alembic heads | Medium (parallel slices) | High | §3.1 `alembic heads`==1, merge revision, staging-first |
| Non-additive migration breaks prod during deploy window | Medium | High | additive-only/expand-contract rule §3.3; Neon branch §10 |
| New pytest suites flaky under xdist (shared CM/DB) | Medium | Medium | per-worker DB + isolated CM; no sleep-based waits |
| Reconnect storm on deploy hammers GET-resync | Medium | Medium | backoff (R7) + resync (R8); verified in smoke |
| WS connections exhaust concurrency at ~80 | Medium | Medium | H5 raise to ≥100 |
| `just e2e` not in CI → e2e regressions slip | Medium | Medium | OPEN: mandatory local pre-push gate now, containerize for CI later |
| Honeycomb key missing → SessionStart hook fails / no spans | Low | High (Hard Rule 1) | point at 1Password, never bypass; marker needs `HONEYCOMB_CONFIG_API_KEY` |
| AI-hardest container fails to tear down → cost leak | Medium | Medium | 15-min cap + teardown verified in smoke + `engine.resolve` span |

______________________________________________________________________

## 10. Open questions / assumptions (rolled up)

- **ASSUMPTION:** beta = single API instance (`min=max=1`); multi-instance
  fan-out deferred.
- **ASSUMPTION:** staging + prod are env-suffixed Cloud Run services in one
  project, deployed via `bin/deploy staging|production`.
- **ASSUMPTION:** new migrations are additive / expand-contract; no destructive
  one-shot non-null adds.
- **OPEN:** add a CI lane for `just e2e`, or keep it as a local pre-push gate?
- **OPEN:** one Honeycomb environment (keyed by `deployment.environment`) vs.
  separate staging/prod Honeycomb environments.
- **OPEN:** does Terraform's `TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST` need to
  change to support pinned-revision rollback, or is `gcloud run update-traffic` sufficient between applies?
