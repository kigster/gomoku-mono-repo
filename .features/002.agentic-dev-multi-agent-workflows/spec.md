# Multi-Agent Workflows for Accelerating Development

## Goal

Evaluate which multi-agent orchestration patterns actually help us
ship features faster across the three independent surfaces of this
repo — the C engine (`gomoku-c/`), the FastAPI service (`api/`), and
the TypeScript frontend (`frontend/`) — plus the deploy/IaC layer.
The output of the work is **calibrated experience**, not new
infrastructure: we want to know which patterns pay off here so we
stop conflating them with the hype.

## Why now

The three surfaces share contracts (HTTP JSON schema, Elo migration
story) but most day-to-day work touches one at a time. That is the
exact shape where multi-agent orchestration _might_ pay off —
independent work fans out, shared contracts gate merging. Multiple
"10x" claims circulating online conflate distinct patterns, each with
different cost/benefit profiles and failure modes. We need a clear
read on which apply here before investing in infrastructure.

## Patterns under evaluation

1. **Parallel read-only exploration** — N read-only agents
   (`Explore`) answer independent questions in parallel; coordinator
   synthesises. Real win when queries are genuinely independent;
   correlated questions duplicate work.
1. **Orchestrator / worker (write fan-out)** — planner decomposes a
   task, workers in isolated git worktrees own disjoint slices.
   Real parallelism when the contract (types, endpoint shape, schema)
   is nailed down first.
1. **Independent review / second opinion** — reviewer agent sees only
   the diff and task description, never the author agent's reasoning.
   The pattern behind `/ultrareview` and `/security-review`.
1. **Long-running background loops** — agent watches CI, PR comments,
   or a test loop; surfaces only when human attention is needed.
1. **Recurring scheduled tasks (`/loop`)** — poll-based, human-
   initiated, for chores like babysitting deploys or rerunning flaky
   tests.

## What is mostly theatre (do not pursue)

- "Council of agents debating" — N copies of the same model arguing
  rarely beats one good agent with a clear brief.
- "AI pair programmer watching every keystroke" — value is at task
  boundaries, not continuous narration.
- Deep agent trees (3+ levels) — context loss compounds.

## Honest cost model

A 4-worker fan-out costs roughly 4× the tokens of a single agent for
the same final diff. Worth it when:

- Work is genuinely parallel (no shared files, no shared decisions).
- Wall-clock matters (you're blocked on the result).
- The coordinator would otherwise burn context on raw tool output.

**Not** worth it when:

- Slices share state and need constant resyncing.
- The task is small (< ~30 min of single-agent work).
- The contract between slices can't be articulated in one paragraph.

Plan for 2–3× on well-decomposed work; treat anything beyond that
as a bonus.

## Experiments (Phase 1)

Three self-contained experiments, run opportunistically, two weeks
each-of-the-way.

### 1.1 Parallel exploration sweep

Pick a cross-cutting question and answer it with 4 parallel
`Explore` agents vs. one sequential agent. Measure wall-clock +
subjective quality.

Candidate questions:

- "Where does the C engine's board representation diverge from the
  API's serialised form?"
- "Every place the Elo rating is read or written across `api/` +
  `frontend/`."
- "All env vars referenced at runtime vs. only at deploy time."

### 1.2 Worktree fan-out on a real ticket

Pick a ticket with 2–3 genuinely independent slices. Candidate:
phase 1 of the Elo plan (migration + backend math + frontend column).

Process: pin the contract first (stub PR or plan-doc section),
spawn three workers with `isolation: "worktree"`, integrate manually,
measure wall-clock vs. estimated single-agent time.

### 1.3 Independent review on a deploy-touching change

Next time `bin/deploy` or a migration changes, run `/ultrareview`
before merging. Track whether the reviewer catches anything the
author missed. If catch-rate is below ~1/5 over 10 reviews, the
briefing prompt is the problem, not the pattern.

## Standing infrastructure (Phase 2, **only if Phase 1 pays off**)

- `.claude/agents/*.md` for recurring roles: `gomoku-c-expert`,
  `api-contract-reviewer`, `migration-safety-reviewer`.
- `.claude/commands/*.md` for repeatable orchestrations: `/triage-ci`,
  `/contract-check`.
- A filtered PR activity watcher whose whole product is the filter.

## Explicit non-goals (Phase 3 — do not build)

- A "team" of always-on agents.
- Agent-to-agent chat protocols.
- Self-modifying agent prompts.
- Agent review _replacing_ (rather than augmenting) human code review.

## Success criteria

After Phase 1, we should be able to answer:

1. Which question shapes get a real speedup from parallel
   exploration?
1. What's the minimum contract size that prevents integration churn
   in worktree fan-out?
1. What's the catch-rate of independent review, and what briefing
   format maximises it?

If the answers are positive, Phase 2 is justified. If they're mixed,
keep the patterns we proved and skip the infrastructure.

## Open questions

- Worktree vs. branch fan-out — worktrees are cleaner but
  `just deploy` assumes a single tree. Do experiments stay
  feature-branch only?
- Test-database collisions — `pytest-xdist` already parallelises
  across 4 workers with `gomoku_test_gw{N}` databases; agents in
  separate worktrees need their own naming convention.
- Monthly token-spend ceiling for experiments — pick a number before
  starting, not after.

## Status

**Not started.** This is a proposal for the experiments to run, not
a record of results. The deliverable from Phase 1 is a results doc
(`./results.md`) with timings and
verdicts.

## Cross-references

- Full pattern analysis, cost model, phase plan: `plan.md`.
- Elo plan referenced as Experiment 1.2 candidate:
  `.features/001.elo-rating-and-leaderboard-system.done/`.
