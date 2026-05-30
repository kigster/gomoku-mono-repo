<!--
CLAUDE.md Best Practices (use to validate this file):
- Not a linter: if a rule says "always/never do X" and a static analyzer could catch it, make it a linter rule instead.
- Progressive disclosure: stay lean here, link to detailed docs in subdirectories.
- Structure: Why (purpose) → What (description) → How (usage).
- Target: under 300 lines.

Reference: https://www.humanlayer.dev/blog/writing-a-good-claude-md
-->

# Gomoku Mono-Repo

Gomoku ("five in a row") is an abstract strategy board game played on a 15×15
or 19×19 grid. This repo ships the playable game across a TUI binary, an HTTP
daemon, a FastAPI/Postgres backend, and a React/Vite frontend — all built and
orchestrated from a single root `justfile`.

## Sub-systems

| Path | What it builds | Notes |
|------|----------------|-------|
| `gomoku-c/` | `gomoku` (TUI), `gomoku-httpd`, `gomoku-http-test` | C engine + daemon; built via `make` |
| `gomoku-httpd-rust/` | `gomoku-httpd-rust` | Rust port of the daemon; release binary copied to `./bin/` |
| `api/` | FastAPI server | Python 3.14, asyncpg (no SQLAlchemy), Alembic migrations, proxies AI moves to `gomoku-httpd[-rust]` |
| `frontend/` | React + TypeScript + Vite SPA | Talks only to the API; bundled into `api/public/` for deploy |
| `iac/` | Terraform | Cloud Run + Cloud SQL + Cloud Build wiring |
| `bin/gctl` | Local dev cluster orchestrator | Starts envoy/nginx + gomoku-httpd + api; see `gctl --help` |

A short-form schematic of what calls what:

```
React → FastAPI → gomoku-httpd[-rust]   (AI moves)
           ↓
       PostgreSQL                       (auth, multiplayer, scores)
```

## Build & Run

- **Everything:** `just build` (C engine + Rust httpd + frontend + copy assets)
- **Local cluster:** `bin/gctl start` (with `-r` or `GOMOKU_HTTPD_RUST=1` to use the Rust binary)
- **Smoke a UI change:** point a browser at `https://dev.gomoku.games` (hostfile alias for the local cluster). See **Hard Rules → Browser testing** below.

## Test

`just test` runs every component: C engine, daemon, Rust port, API, frontend.

- `just test-api` runs pytest in parallel across 5 xdist workers; each gets its own `gomoku_test_gw{N}` DB.
- `just test-frontend` runs vitest.
- `just test-rust` runs the Rust unit + doc tests.
- `just test-cypress` restarts the cluster and runs the e2e suite.

### Postgres port

Local Postgres often listens on `5433` (Homebrew's `postgresql@18` default), not the standard `5432`. The repo-root `.envrc` exports
`POSTGRESQL_PORT=${POSTGRESQL_PORT:-5433}` as the single knob; every test
runner (pytest via `app/config.py`, cypress, `bin/db-test-setup`,
`api/justfile`) reads it. Override per-shell with `POSTGRESQL_PORT=5432`
before invoking the test command.

`api/.env.test` deliberately does **not** set `DATABASE_URL` — the DSN is
composed from `POSTGRESQL_PORT + DB_USER + DB_NAME` at runtime. The conftest
neutralizes any `DATABASE_URL` leaked into the process env by direnv loading
the repo-root `.env` (set `PYTEST_KEEP_DATABASE_URL=1` to keep a shell
override, e.g. pointing tests at a Neon branch).

## Deploy

`just deploy` is the canonical command — sources repo-root `.env`, runs
Alembic against the production DB, builds linux/amd64 Docker images, applies
Terraform, and posts a Honeycomb deploy marker. Logic lives in `bin/deploy`.

Required keys in repo-root `.env` (deploy-time only; never read at runtime —
production reads Cloud Run env vars set by Terraform):

- `PRODUCTION_DATABASE_URL` — Neon pooled DSN
- `PRODUCTION_JWT_SECRET` — HMAC key (`just jwt-secret` generates one)
- `HONEYCOMB_INGEST_API_KEY`, `HONEYCOMB_CONFIG_API_KEY`
- `PROJECT_ID`, `REGION`

## Multiplayer (human vs human)

`/multiplayer/*` in `api/app/routers/multiplayer.py` hosts the two-human flow.
`ChooseGameTypeModal` on the frontend generates 15-minute invite links
(`/play/<6-char>`).

- **No SQLAlchemy** — asyncpg + raw SQL throughout, with savepoints for the code-collision retry path.
- **Schema discriminator** — `games.game_type IN ('ai','multiplayer')` keeps the strict AI invariants (depth/radius/total_moves ≥1) while admitting `0/0/0` sentinels for multiplayer history rows.
- **Lazy expiry** — every read of a `waiting` game past its `expires_at` flips it to `cancelled`; no background sweeper.
- **Tiered polling** — `pollingIntervalForElapsedMs` ramps 300 ms → 2 s → 3 s → 5 s. Caps: 15 min waiting, 8 h in-progress.

Detailed design notes:
`.features/003.multiplayer-architecture-and-data-model.done/`,
`.features/009.choose-game-type-modal-and-invite-link.done/`,
`.features/008.multiplayer-pr-hardening-checklist.done/`.

Frontend specifics in `frontend/CLAUDE.md`.

______________________________________________________________________

## Feature workflow

Every new feature, bug-fix, or refactor follows the same shape so the work
is self-describing and parallelisable. The shipped record lives in
[`/.features/`](.features); the long-form reference material that
underpins it lives in [`/reference/`](reference).

### Directory shape

```
.features/
  NNN.<short-kebab-slug>[.done]/
    spec.md     — human-authored: what & why
    plan.md     — AI-derived: how (architecture, schema, tasks, tests)
```

- `NNN` is a zero-padded three-digit sequence (`001`, `002`, …). Stays the
  same forever, even as the work moves through review or gets paused.
- `<short-kebab-slug>` is a few words that read like a feature name, not a
  filename. Example: `realtime-websocket-push-architecture`.
- Append `.done` to the directory name once the feature is shipped (code
  in `main`, behaviour verified in the browser). The slug never changes.

Reference docs that explain *how something works* rather than *what we're
building next* go in `reference/`, using the same kebab-case convention
without a numeric prefix.

### Authoring loop

1. **Pick a number.** `ls .features | tail -1` + 1.
1. **Human writes `spec.md`.** Treat it as a brief to a smart colleague who
   hasn't seen the conversation: goal, users, requirements, quality bar,
   explicit non-goals, links to related features/reference docs.
1. **AI generates `plan.md`** from the spec — architecture, schema, file-by-
   file task list, test plan. Plan.md is owned by the AI; revise as the
   spec changes.
1. **Create a branch named after the slug** (drop the numeric prefix and
   the `.done` suffix): `git checkout -b kig/<slug>`.
1. **AI orchestrates the agents below**, producing one PR with multiple
   commits — each commit subject prefixed with the contributing agent
   (`zeus: …`, `jeff: …`, `webdes: …`).
1. **On merge, rename the directory** with the `.done` suffix in the
   merging commit (or immediately after). Cross-references in other
   `spec.md` / `plan.md` files must be updated in the same commit.

### Agents

- **Zeus — the architect.** Owns overall architecture, feasibility, and
  "glue" between sub-systems (C engine ↔ FastAPI ↔ frontend ↔ IaC). Writes
  the initial `plan.md` from the spec, makes the hard cross-cutting calls
  (Redis vs LISTEN/NOTIFY, migration shape, contract between slices), and
  rewrites the plan when reality pushes back.
- **Jeff Dean — the staff engineer.** Runs after every other agent's
  output — architecture, plan, code. Hunts for wrong assumptions,
  questions the spec didn't ask but should have, uncovered corner cases,
  weak test coverage, concurrency / threading issues, and silent-failure
  paths. Writes a `## Verifier notes` (or equivalent) appendix to `plan.md`
  or files PR review comments. Blocking on his sign-off is a feature.
- **Web designer.** Handles every frontend artefact. Uses the frontend
  skills available in `.claude/` and **leans on TailwindCSS utility
  classes over raw CSS** unless a one-off rule is genuinely unavoidable.
  Owns visual polish, responsive layout, accessibility, and component
  composition.

A single PR collects work from all three. Commits stay atomic; the agent
prefix in the subject and a `Co-Authored-By:` trailer make the attribution
clear. Jeff's review-driven fixups land as their own commits rather than
amending the original author's work.

______________________________________________________________________

## 🚨 Hard Rules

These are non-negotiable. Some are enforced by hooks in `.claude/settings.json`.

### 1. Telemetry is mandatory

Honeycomb (OpenTelemetry-compatible) traces every API request and Rust daemon
call. If `HONEYCOMB_INGEST_API_KEY` is missing, the SessionStart hook will
fail loudly — point teammates at 1Password rather than suggesting workarounds.
The hook is the workaround.

### 2. Browser-test before every push (rare exceptions only)

A `PreToolUse` hook blocks `git push` by default. Backend changes can break
the UI just as easily as frontend ones — assume any change might, and verify
before pushing. The intended flow:

1. `bin/gctl stop` (no-op if nothing's up) → `bin/gctl start` (add `-r` if `GOMOKU_HTTPD_RUST=1`).
1. Drive the affected feature in a browser at `https://dev.gomoku.games`.
1. Push.

Push is allowed without browser testing only when the diff is genuinely
doc/planning-only (`*.md`, `LICENSE`, `.gitignore`, files under `.claude/`)
or the user explicitly sets `CLAUDE_SKIP_BROWSER_TEST=1`. Don't unilaterally
bypass — surface the trade-off and let the user decide.

### 3. Wait for CI after every push — proactively

After every successful `git push`, start a CI watch via `Monitor` running
`bash .claude/scripts/ci-watch.sh <PR>` (one instance per PR — `TaskStop` any
prior one first). Wait for `CI_DONE:PASS`, `CI_DONE:FAIL`, or
`CI_DONE:PASS_PENDING_REVIEW`. On failure, fix proactively — read the logs,
push a fix, monitor again. Up to 3 fix cycles before stopping to ask the
user. Don't leave a session with red CI without a written explanation.

### 4. Clean architecture beats slop fixes

When the choice is between a band-aid and a real fix, propose the real fix
first.

- Don't catch+ignore exceptions to make CI green — fix the root cause.
- Don't add a feature flag or escape hatch to dodge a refactor the codebase actually needs.
- Don't introduce duplicate state or shadow workflows to avoid touching shared code.
- Don't paper over flaky tests with retries — diagnose, then fix.

If you're unsure whether a fix is clean enough, surface the trade-off (cost
of band-aid vs. real fix) in plain English and let the user choose. Defaulting
to slop because it's faster is a violation, not a stylistic choice.

### 5. Use LSP for symbol lookup, not grep

Use Claude Code's native `LSP` tool for `goToDefinition` / `findReferences` /
`hover` / `documentSymbol` / `incomingCalls`. Grep is for text substrings;
LSP is for code semantics. Repeatedly defaulting to grep for symbol work
misses re-exports, type-only imports, JSX prop matches that look identical
to comments — and produces false positives that waste turns. `ruby-lsp` and
`typescript-lsp` plugins are auto-enabled via `.claude/settings.json`.

### 6. Deprecations

`@deprecated` markers (in any form — JSDoc, comments, RuboCop deprecation
cops, README notes) are an explicit author signal: the replacement exists.

- **Calling deprecated code:** don't. Use the recommended alternative.
- **Fixing a bug in deprecated code:** check first whether the replacement already fixes it (or whether migrating would). If migration is feasible within the bug-fix PR, propose migration as the primary fix. Surface the trade-off — patching cost vs. migration cost — and let the user pick. Don't silently patch and ship.

______________________________________________________________________

## 🔒 Bash Safety (Hard)

- **Never modify files outside this repository.**
- **Never edit system or user configuration files** (shell rc files, PATH/env files, editor configs).
- **Never use in-place editors** (`sed -i`, `perl -pi`, overwrites) on non-repo files.

Allowed: read-only inspection (`cat`, `ls`, `printenv`), creating/modifying
files inside the repo, proposing changes to system files **as text output**
(not executing them).

If a change affects shell behavior, PATH, or environment variables: explain
the change, show the exact snippet, then stop and wait for explicit
confirmation. When unsure: do nothing. Prefer under-modification to over.

## `direnv` and environment

Realize that we use `direnv` in development only. So that any folder with `.envrc` file
may contain local environment overrides or a setup for whatever it's doing.
All `.envrc` files must load `dotenv` and `dotenv_if_exists .env.local` file,
and at the very end `[[ -f .envrc.local ]] && source .envrc.local`.

All files such as `.env.local`, `.envrc.local`, and `.envrc.encrypted` must be git-ignored.

The file `.env` should not contain any secrets, but should auto-load `.env.<environment>`
where environment is `development`, `staging`, `production` (based on the Rails environments).

The `.env` file can be checked into the repo as long it contains the listing of the
require variables with an = sign, but no values unless the value is not senstive at all.

So `.env` may look like:

```bash
GOMOKU_HTTPD_RUST=1`
GOMOKU_DEFAULT_DEPTH=7`
# etc.
```

## Using Encryption

Various sensitive tokens and API keys can be defined in the file `.env.encrypted` (git-ignored)
but committed into the repo as `.env.encrypted.enc` (the encrypted version).

`.envrc` must always check if `.env.encrypted` exists, and if it's newer than `.env.encrypted.enc`.\
If it is, it should ask the user whether they want to encrypted it.

Conversely, if there is a file `.env.encrypted.enc` but no `.env.encrypted` the `.envrc`
should automatically decrypt the `.enc` file and source `.env.encrypted` into the environment.

______________________________________________________________________

## Git

- **Never use `git push --force`** — always use `git push --force-with-lease` so you don't overwrite someone else's work on the same branch.
- **PR base branch:** always `main` unless the user explicitly says otherwise.
- **Merge-base for diffs:** local `main` is often stale, especially in worktrees. Use `git diff $(git merge-base HEAD origin/main)...HEAD` instead of `git diff main` for branch-vs-base comparisons.
- **Commit messages:** subject ≤ 50 chars, imperative mood ("add" not "added"), no trailing period. Body explains *why* at ≤ 75 columns. Keep commits atomic — one logical change each.

## 🧹 Context Hygiene

See [`.claude/context-hygiene.md`](.claude/context-hygiene.md) — rules
for avoiding the dominant context-bloat patterns (screenshot re-reads,
paginated `gh` dumps, transcript loops, large-file slurps, subagent return
duplication).

## Skills

Skills are auto-discovered from `.claude/skills/` and surfaced per session —
no manual listing here. Each skill's trigger conditions live in its own
frontmatter.

## MCP / LSP

- `.mcp.json` configures MCP servers.
- `LSP` is Claude Code's native code-intelligence tool. TypeScript uses
  `typescript-language-server`; Ruby (used in `schema-validator/` and a few
  evaluator scripts) uses `bundle exec ruby-lsp`. Both plugins are pinned
  in `.claude/settings.json` under `enabledPlugins` and auto-install on first
  session.

______________________________________________________________________

## Local toolchain conventions

- **Prefer modern CLIs:** `rg` over `grep`, `fd` over `find`, `gawk`/`gsed`/`gcat` over BSD variants, `bat` for syntax-highlighted file dumps. (BSD `find` is still fine in scripts that ship to CI — keep `/usr/bin/find` where portability matters; see `justfile`.)
- **PostgreSQL 18** runs locally on `localhost:${POSTGRESQL_PORT}` (default 5433). Connect as `postgres` for dev or `postgres@/gomoku_test` for tests. Watch the `PG*` env vars when shelling out to `psql` — `.envrc` exports them; override before running if needed.
- **memcached** on 11211, **redis** on 6379, **nginx** on 80/443 are expected to be running for the local cluster.
