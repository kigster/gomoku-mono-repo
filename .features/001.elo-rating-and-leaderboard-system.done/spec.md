# Elo Rating and Top-100 Leaderboard

## Goal

Replace the deterministic per-game scoring formula
(`game_score(human_won, depth, radius, time)` → 0..7250) with a
moving Elo rating that converges to a player's true strength against
the AI ladder and naturally rewards consistent play. Surface the
top 100 by Elo as a freshly-maintained materialised view, then flip
the SPA leaderboard from "best single game" to "current rating".

## Motivation

The current score is a function of the parameters of **one** game.
A player who beats depth=4 once and never plays again has the same
`max_score` forever. It also rewards sandbagging at low depth.

Elo gives:

- A rating that moves with each game.
- A natural reward for consistent play across difficulty tiers.
- A penalty for sandbagging.
- Direct comparability with the wider Gomoku world via the
  Gomocup BayesElo parameters
  (`eloAdvantage=0`, `eloDraw=0.01`).

## Phasing

Phases ship independently and each adds value on its own.

### Phase 1 — Elo storage + math

- Schema: `users` gains `elo_rating`, `elo_games_count`, `peak_elo`;
  `games` gains `elo_before`, `elo_after`, `elo_delta` (generated),
  `opponent_elo`.
- AI opponent rating modelled as a fixed-strength rated opponent per
  `(depth, radius)` combo. Initial seed table calibrated from
  existing depth-tournament data in `gomoku-c/tests/evals/`.
- Standard Elo math, K-factor scales with `elo_games_count`:
  - \<30 games → K=40 (provisional)
  - ≥2400 rating → K=16 (masters)
  - else → K=24
- `/game/save` updates the rating atomically inside the existing
  transaction, returns `elo_before`, `elo_after`, `elo_delta` so the
  SPA can show "Your rating: 1547 (+12)".
- Backwards compat: keep `score` column and `game_score()` SQL
  function. They coexist with Elo during the transition.

### Phase 2 — Top-100 materialised view

- New `top_100_elo` materialised view (`elo_games_count >= 5` to
  exclude provisional players, ordered by `elo_rating DESC`).
- Unique index on `user_id` enables `REFRESH CONCURRENTLY`.
- New endpoint `GET /leaderboard/elo?limit=100` reads the view via
  a single index scan (~1 ms on Neon).

### Phase 3 — Conditional refresh

`REFRESH MATERIALIZED VIEW CONCURRENTLY top_100_elo` cannot run
inside a transaction, so a trigger is not an option. **Option A
(recommended)**: a FastAPI background task fires only when the
post-save Elo would change top-100 ordering
(`max(old_elo, new_elo) > min(top_100_elo.elo_rating)`). **Option B**
(DB trigger + `LISTEN/NOTIFY`) is documented but rejected because
Neon's pooled endpoint doesn't support `LISTEN` reliably.

Safety net: a 10-minute periodic `REFRESH CONCURRENTLY` runs in the
FastAPI lifespan so the view never drifts more than 10 min from
truth.

### Phase 4 — SPA leaderboard switch

- `LeaderboardModal` reads the new `/leaderboard` (now Elo-shaped).
- Columns: `# / Player / Rating / Peak / Games`.
- A "View: [Current Rating | Best Games]" toggle keeps the legacy
  "best score" available at `/leaderboard/best-games`; choice is
  persisted to `localStorage`.
- Empty state during transition: explains the 5-game minimum and
  links to "Best Games" view.
- Response cached `public, max-age=30, stale-while-revalidate=300`.

## Open questions to settle before Phase 1

1. **Initial rating: 1500 or 1200?** Recommend 1500 so the centre of
   the AI ladder doesn't trigger huge swings on a new player's first
   loss.
1. **Should depth-1 games count?** Recommend `WHERE depth >= 2` in
   addition to the 5-game minimum (depth-1 is essentially noise).
1. **Anonymous play**: `/game/play` is anonymous, `/game/save`
   requires auth — anonymous games don't count. Acceptable trade-off.
1. **Score column fate**: keep populating indefinitely. Cheap, useful
   for time-decay leaderboards.

## Quality criteria

- Phase 1 ships behind no flag — the new rating is the rating. The
  SPA shows the delta toast immediately.
- Concurrent saves from the same user must serialise via
  `SELECT … FOR UPDATE`; without the row lock the running counter
  races.
- Unit tests cover symmetry (winner +N ⇔ loser −N), bounds (rating
  never < 0), K-factor transitions, known-pair expected scores
  (1500 vs 1500 → 0.5; 1600 vs 1400 → ~0.76).
- Integration test posts a fake game via `/game/save` and asserts
  both `users` and `games` rows update correctly.

## Rollout

1. Phase 1 alone → validate math on real games.
1. ~1 week wait → collect ~100 rated games, retune AI rating table
   against actual win rates.
1. Phase 2 → view exists but nothing reads it; manual refresh via
   `python -m app.cli.main leaderboard refresh`.
1. Phase 3 → conditional + periodic refresh.
1. Phase 4 → flip SPA leaderboard. User-visible change.
1. Eventually drop the legacy `/leaderboard/best-games` and
   `game_score()` SQL function once metrics show \<1% usage.

## Out of scope

- Multiplayer-vs-multiplayer Elo (handled by the existing
  multiplayer plan; this spec is the AI ladder).
- BayesElo recalibration job (see
  `reference/gomocup-bayesian-elo-system.md`).
- A separate "season" reset / decay schedule.

## Cross-references

- Implementation phases, SQL, code, file-touch budget: `plan.md`.
- BayesElo design and parameter rationale:
  `reference/gomocup-bayesian-elo-system.md`.
- Multiplayer game flow:
  `.features/006.web-multiplayer-invite-flow.done/`.
