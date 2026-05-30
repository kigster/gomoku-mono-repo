# Plan: Multi-agent workflows for accelerating Gomoku development

## Why now

This repo has three independent surfaces — the C engine (`gomoku-c/`), the
FastAPI service (`api/`), and the TypeScript frontend (`frontend/`) — plus a
deploy/IaC layer (`iac/`, `bin/deploy`, `justfile`). They share contracts (the
HTTP JSON schema in `doc/`, the Elo migration story, etc.) but most day-to-day
work touches one surface at a time. That's the exact shape where multi-agent
orchestration pays off: independent work fans out, shared contracts gate
merging.

The "10x" claims circulating online conflate a few different things. This doc
separates them into patterns that are real, patterns that are situational, and
patterns that are mostly theatre — then proposes concrete experiments scoped to
this codebase.

______________________________________________________________________

## What "multi-agent" actually means

Five distinct patterns get lumped together. Each has a different cost/benefit
profile and a different failure mode.

### 1. Parallel read-only exploration

One coordinator spawns N read-only agents (Claude Code's `Explore` subagent,
for example) to answer independent questions about the codebase
simultaneously. Each returns a summary; the coordinator synthesises.

- **Win:** wall-clock speedup roughly linear in N for genuinely independent
  queries. Also keeps the coordinator's context clean — it sees summaries, not
  raw grep output.
- **Failure mode:** correlated questions ("find X" + "find callers of X")
  duplicate work. Agents miss content past their read window and confidently
  report absence.
- **When to use here:** "where is the move-scoring logic mirrored between
  `gomoku-c/` and `api/`?", "which files reference the JSON schema in
  `../../reference/httpd-rest-api-reference.md`?". Cheap, high-leverage.

### 2. Orchestrator / worker (write fan-out)

Planner agent decomposes a task, spawns workers each owning a slice, then
integrates. Workers write code in **isolated git worktrees** so they don't step
on each other.

- **Win:** real parallelism on disjoint slices. E.g. "add Elo to API" + "add
  Elo column to leaderboard UI" + "add Elo migration" can proceed in parallel
  if the contract (column names, endpoint shape) is nailed down first.
- **Failure mode:** if the contract isn't pinned down, workers diverge and the
  integration step costs more than the parallelism saved. Token cost is N×
  the single-agent baseline — you're trading money for wall-clock.
- **Hard rule:** write the contract (types, endpoint shape, schema) *before*
  fanning out. The contract is the synchronisation primitive.

### 3. Independent review / second opinion

A reviewer agent sees only the diff and the task description — never the
author agent's reasoning. This is the pattern behind `/ultrareview` and
`/security-review`.

- **Win:** catches errors the author rationalised away. Independence is the
  whole point — sharing context defeats it.
- **Failure mode:** reviewers without enough context produce generic "consider
  adding tests" noise. Brief them like a colleague (paths, line numbers, what
  changed and why).
- **When to use here:** before merging anything touching `bin/deploy`,
  Alembic migrations, or the C engine's threat detection. High-blast-radius
  surfaces.

### 4. Long-running background loops

An agent runs in the background watching CI, PR comments, or a test loop, and
surfaces only when something needs human attention. Claude Code supports this
via `run_in_background` + `Monitor`, and PR activity events via
`subscribe_pr_activity`.

- **Win:** removes the human polling tax. You get pinged on red CI instead of
  refreshing GitHub.
- **Failure mode:** chatty agents that surface every event. The value is in the
  filter, not the watching.

### 5. Recurring scheduled tasks (`/loop`)

Run a prompt on an interval — useful for "babysit PRs", "check deploy every
5m", "rerun flaky test 10×". Different from #4: this is poll-based and
human-initiated.

### What's mostly theatre

- **"Council of agents debating"** — N copies of the same model arguing rarely
  beats one good agent with a clear brief. Independence requires *different
  context*, not different invocations.
- **"AI pair programmer watching every keystroke"** — most of the value is in
  the review at task boundaries, not continuous narration.
- **Deep agent trees (agent → agent → agent → ...)** — context loss compounds.
  Two levels is usually the sweet spot.

______________________________________________________________________

## Honest cost model

Multi-agent setups trade tokens for wall-clock and for context-window
hygiene. A 4-worker fan-out costs roughly 4× the tokens of a single agent for
the same final diff. That's worth it when:

- The work is genuinely parallel (no shared files, no shared decisions).
- Wall-clock matters (you're blocked on the result).
- The coordinator would otherwise burn its context window on raw tool output.

It is **not** worth it when:

- The slices share state and need constant resyncing.
- The task is small (< ~30 minutes of single-agent work).
- You can't articulate the contract between slices in one paragraph.

The "10x" headline is real for specific shapes of work and a marketing number
for the average task. Plan for 2–3× on well-decomposed work; treat anything
beyond that as a bonus.

______________________________________________________________________

## Phase 1 — Low-risk experiments (this repo)

Each is a self-contained experiment we can run without committing to
infrastructure changes.

### Experiment 1.1 — Parallel exploration sweep

Pick a cross-cutting question and answer it with 4 parallel `Explore` agents
vs. one sequential agent. Measure wall-clock + subjective quality.

Candidate questions:

- "Where does the C engine's board representation diverge from the API's
  serialised form?"
- "Every place the Elo rating is read or written across api/ + frontend/."
- "All env vars referenced at runtime vs. only at deploy time."

Deliverable: a short writeup in `./results.md`
with timings and a verdict on which questions benefit.

### Experiment 1.2 — Worktree fan-out on a real ticket

Pick a ticket with 2–3 genuinely independent slices. Candidate: the Elo
leaderboard plan (`../001.elo-rating-and-leaderboard-system.done/plan.md`) — phase 1 has migration +
backend math + frontend column as three slices.

Process:

1. Pin the contract: column names, endpoint shape, response schema. Commit it
   as a stub PR or a section of the plan doc.
1. Spawn three worker agents with `isolation: "worktree"`, one per slice.
1. Integrate manually; measure wall-clock vs. the estimated single-agent time.

Deliverable: PR with the actual feature + retro notes on what the contract
missed.

### Experiment 1.3 — Independent review on a deploy-touching change

Next time `bin/deploy` or a migration changes, run `/ultrareview` (or a
manually-spawned reviewer agent) before merging. Track whether the reviewer
catches anything the author missed.

Deliverable: a running tally in the results doc — review-catches /
review-runs. If the rate is below ~1/5 over 10 reviews, the briefing prompt is
the problem, not the pattern.

______________________________________________________________________

## Phase 2 — Standing infrastructure (only if Phase 1 pays off)

Don't build any of this until the experiments justify it.

### 2.1 — Project-level subagent definitions

Add `.claude/agents/*.md` for the recurring roles this repo needs:

- `gomoku-c-expert` — knows the C engine layout, threat detection, eval
  function. Spawned for any change under `gomoku-c/`.
- `api-contract-reviewer` — reads diffs that touch `api/` against the JSON
  schema in `doc/`. Independent of the author.
- `migration-safety-reviewer` — reviews Alembic migrations specifically for
  concurrency, lock duration, backfill safety. Mirrors the pattern in
  `../001.elo-rating-and-leaderboard-system.done/plan.md` Phase 1.

Each agent definition is ~30 lines of frontmatter + system prompt. The win is
that briefing context lives in the file, not in every invocation.

### 2.2 — Slash commands for common fan-outs

Add `.claude/commands/*.md` for repeatable orchestrations:

- `/triage-ci` — when CI goes red, fan out: one agent reads the failing test
  log, one diffs against the last green commit, one checks for flake history.
  Coordinator synthesises a likely cause.
- `/contract-check` — given a PR touching either `api/` or `frontend/`,
  verify the JSON contract still matches both sides.

### 2.3 — Background PR watcher

Subscribe to PR activity on long-lived feature branches. The watcher's only
job is filtering: it surfaces CI failures, review comments that aren't
nits, and merge conflicts. Everything else is silent.

Implementation note: this is `subscribe_pr_activity` + a tightly-scoped
filter prompt. The filter is the whole product.

______________________________________________________________________

## Phase 3 — Things to explicitly *not* build

Listed because they're tempting and they don't pay off:

- **A "team" of always-on agents** — burns tokens on idle, produces stale
  context. Spawn on demand instead.
- **Agent-to-agent chat protocols** — JSON in/JSON out via the orchestrator is
  simpler, cheaper, and easier to debug.
- **Self-modifying agent prompts** — the determinism loss is not worth the
  marginal gain. Edit the prompt files in git like any other code.
- **Replacing code review with agent review** — agent review is *additional*,
  not *substitute*. The signal is different.

______________________________________________________________________

## Success criteria

After Phase 1 (target: 2 weeks of opportunistic experiments), we should be
able to answer:

1. On parallel exploration: which question shapes get a real speedup, and
   which just produce four redundant summaries?
1. On worktree fan-out: what's the minimum contract size that prevents
   integration churn?
1. On independent review: what's the catch-rate, and what briefing format
   maximises it?

If the answers are positive, Phase 2 is justified. If they're mixed, we keep
the patterns we proved and skip the infrastructure.

______________________________________________________________________

## Open questions

- Worktree fan-out vs. branch fan-out: worktrees are cleaner but the deploy
  pipeline (`just deploy`) assumes a single tree. Do experiments stay
  feature-branch only, or do we teach the pipeline about multiple worktrees?
- How do we handle agents that need the test database? `just test-api` already
  parallelises across 4 workers via pytest-xdist with per-worker
  `gomoku_test_gw{N}` databases — agents in separate worktrees would need
  their own naming convention to avoid collisions.
- Cost ceiling: at what monthly token spend do we cap experiments? Worth
  setting a number before we start, not after.
