# Replacing the Score-Based Ranking with Gomocup-Style Elo

Status: **Plan / proposal — not yet implemented.**
Author: research compiled from gomocup.org and a read of the current `api/` codebase.

______________________________________________________________________

## 1. How Gomocup actually rates engines

Gomocup does **not** use the K-factor "classical Elo" most people picture. They
use **Bayesian Elo (BayesElo)** — Rémi Coulom's open-source maximum-likelihood
fitter that takes a list of game results and solves for the rating of every
participant simultaneously, under a Bradley-Terry-with-draws model.

Verbatim from <https://gomocup.org/elo-ratings/>:

> All ratings are calculated using Bayesian Elo with `eloAdvantage = 0`,
> `eloDraw = 0.01`, and default prior.

Concretely:

| Parameter | Gomocup value | Meaning |
| -------------- | ------------- | ------------------------------------------------------------------------------------- |
| `eloAdvantage` | `0` | No first-mover bonus baked in. Rating differences fully explain results. |
| `eloDraw` | `0.01` | Draws are treated as essentially impossible. (Gomoku has very few draws in practice.) |
| Prior | default | A small virtual game count keeps brand-new engines from running off to ±∞. |

Other rules of the system:

- Ratings are recomputed in **batch** after each yearly tournament — the entire
  history is re-fit, ratings are not updated game-by-game.
- **Rule sets are pooled separately**: Freestyle, Fastgame, Standard, Renju, and
  Caro each maintain independent leaderboards. They are explicitly not
  comparable.
- **Inclusion thresholds**: an engine needs ≥50 freestyle games / ≥100 fastgames
  / ≥20 standard or renju games before it appears in the public list.
- Tournament time controls: ≤30 s per turn, ≤3 min per match.
- Win condition depends on rule set (5+ stones for Freestyle, exactly 5 for
  Standard/Caro, and Renju adds forbidden moves).

References:

- Gomocup Elo page: <https://gomocup.org/elo-ratings/>
- Tournament rules: <https://gomocup.org/detail-information/>
- Coulom, R. _Bayesian Elo Rating_ — <https://www.remi-coulom.fr/Bayesian-Elo/>
- Wikipedia, Elo rating system: <https://en.wikipedia.org/wiki/Elo_rating_system>

## 2. The current ranking system in this app

Located in `api/app/scoring.py:1`. It is **not Elo at all** — it is a
self-scoring formula based on the difficulty knobs the human chose:

```python
score = 1000 * depth + 50 * radius + time_bonus(human_seconds)   # only on win
rating = score * 100.0 / 7250                                    # 0..100 percentile
```

Surrounding plumbing:

- Schema: `games.score` (`db/migrations/versions/20260404-120002-create-games.py`).
- Leaderboard: a Postgres materialized view aggregating per-player **best
  single game** (`20260404-120003-create-leaderboard.py`).
- API: `POST /game/save` returns `{score, rating}`
  (`api/app/routers/game.py:87`); `GET /leaderboard` returns the matview
  (`api/app/routers/leaderboard.py:12`); `GET /user/me` shows the personal best
  (`api/app/routers/user.py:11`).
- Frontend: `LeaderboardModal.tsx` renders rank/score/rating.

The current "rating" measures **how hard the player asked the AI to be when
they won**, not skill. It cannot rank two players relative to each other and
cannot distinguish a 100-game grinder from someone who got one lucky win on
depth 6. That's the gap Elo closes.

## 3. Design decision: hybrid live-Elo + batch BayesElo

Pure BayesElo is a **batch** tool. For a live web app where users want to see
their rating jump after a single game, a batch-only model is bad UX. The
practical answer the chess and Go worlds settled on — and what we should adopt
— is:

1. **Live updates use classical Elo** (the K-factor formula), parameterised to
   match Gomocup's BayesElo philosophy: no first-move advantage, draws treated
   as half-points (rare anyway).
1. **A periodic batch job** (cron, or `just elo-recalibrate`) re-fits the
   entire history with BayesElo and rewrites the canonical ratings. This is
   the "ground truth" Gomocup itself relies on. Run nightly, weekly, or after
   each tournament — analogous to what gomocup.org does annually.
1. **Between batch runs**, classical Elo gives every player a live, slightly
   noisy estimate that converges on the BayesElo value once they've played
   enough games.

This matches Gomocup's stated parameters while remaining usable in real time.

### 3.1 Live Elo formula (classical)

```
expected_a = 1 / (1 + 10^((rating_b - rating_a) / 400))
new_a      = old_a + K * (score_a - expected_a)
```

`score_a` ∈ {0, 0.5, 1}. K-factor schedule (mirrors USCF/FIDE practice):

| Games played by player | K | Reason |
| ---------------------- | --- | --------------------------------------- |
| 0 – 19 ("provisional") | 40 | Quickly converge from starting estimate |
| 20 – 99 | 24 | Still actively calibrating |
| 100 + | 16 | Stable competitive rating |

Top engines (rating > 2400) drop K to 10, again following FIDE convention.

### 3.2 Batch BayesElo

Run `bayeselo` (Coulom's CLI, MIT licensed) over the full `games` table once a
day with `eloAdvantage=0 eloDraw=0.01` and write results back into the
`elo_ratings` table. Implementation options:

- Bundle the C++ source from <https://www.remi-coulom.fr/Bayesian-Elo/> into
  the api Docker image and shell out to it, OR
- Re-implement the fitter in Python (~200 LOC, MM algorithm) so the api stays
  single-language. Recommended for the first pass; it removes a build-time
  dependency.

## 4. Modelling the AI as a rated participant

Today the only "opponent" most users face is the C engine at a given
`(depth, radius, timeout)` tuple. To make the leaderboard meaningful, **each
distinct AI configuration is its own rated subject**, just like a separate
engine in a Gomocup tournament.

Concrete proposal — six AI tiers, seeded with rough strength estimates:

| Tier name | depth | radius | seeded Elo |
| ----------- | ----- | ------ | ---------- |
| `ai-easy` | 2 | 2 | 800 |
| `ai-novice` | 3 | 2 | 1200 |
| `ai-club` | 4 | 3 | 1600 |
| `ai-strong` | 5 | 3 | 2000 |
| `ai-expert` | 6 | 4 | 2400 |
| `ai-master` | 7 | 5 | 2800 |

Seeds get corrected within a few hundred games once humans play them.

## 5. Schema changes

New Alembic migration `20260501-120000-add-elo-ratings.py`:

```sql
-- A "rating subject" is anything that can have an Elo: a user or an AI tier.
CREATE TABLE rating_subjects (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         TEXT NOT NULL CHECK (kind IN ('user', 'ai')),
  user_id      UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  ai_key       TEXT UNIQUE,                       -- e.g. 'ai-strong-d5-r3'
  display_name TEXT NOT NULL,
  rule_set     TEXT NOT NULL DEFAULT 'freestyle', -- future-proofing
  CHECK ((kind = 'user' AND user_id IS NOT NULL) OR
         (kind = 'ai'   AND ai_key  IS NOT NULL))
);

CREATE TABLE elo_ratings (
  subject_id   UUID PRIMARY KEY REFERENCES rating_subjects(id) ON DELETE CASCADE,
  rating       INTEGER NOT NULL DEFAULT 1500,
  games_count  INTEGER NOT NULL DEFAULT 0,
  peak_rating  INTEGER NOT NULL DEFAULT 1500,
  last_played  TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-game audit trail so BayesElo recalibration can reread history.
ALTER TABLE games
  ADD COLUMN white_subject_id UUID REFERENCES rating_subjects(id),
  ADD COLUMN black_subject_id UUID REFERENCES rating_subjects(id),
  ADD COLUMN white_rating_before INTEGER,
  ADD COLUMN black_rating_before INTEGER,
  ADD COLUMN white_rating_after  INTEGER,
  ADD COLUMN black_rating_after  INTEGER,
  ADD COLUMN rule_set TEXT NOT NULL DEFAULT 'freestyle';

CREATE INDEX games_subjects_idx
  ON games (white_subject_id, black_subject_id, played_at);
```

Drop the `score` column? **No, keep it.** Backfill it as a derived field from
`game_score()` so the existing UI and history don't break during the
transition. Mark it deprecated in code comments.

The leaderboard materialized view is replaced by a much simpler one that just
joins `rating_subjects` + `elo_ratings` and orders by `rating DESC`.

## 6. Code changes

### Backend — `api/app/`

| File | Change |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `scoring.py` | Keep `game_score()` for legacy display; add `elo.py` for the new system. |
| `elo.py` _(new)_ | `expected(a, b)`, `update(a, b, result, k_a, k_b)`, `k_factor(games_played, rating)`. |
| `models/rating.py` _(new)_ | SQLAlchemy models for `rating_subjects`, `elo_ratings`. |
| `routers/game.py:save_game` | After save, look up both subjects, apply Elo update in same transaction. |
| `routers/leaderboard.py` | Switch query to `elo_ratings JOIN rating_subjects` ordered by rating. |
| `routers/user.py:get_me` | Return `rating`, `peak_rating`, `games_count`, recent rating delta. |
| `cli/elo.py` _(new)_ | `recalibrate` (run BayesElo over history), `seed-ai` (insert AI subjects with seeds). |
| `bayeselo.py` _(new)_ | Pure-Python MM fitter for BayesElo. Used by `cli elo recalibrate`. |
| `tests/test_elo.py` _(new)_ | Symmetric updates sum to 0; expected ∈ [0,1]; +400 ⇒ ~91% expectation; etc. |

### Frontend — `frontend/src/`

| File | Change |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `components/LeaderboardModal.tsx` | Replace `score`/`rating (0-100)` columns with `rating` (Elo int) + `Δ` last-30-day delta. |
| `components/DifficultySettingsModal.tsx` | Replace "score formula" explainer with "you'll gain or lose Elo against the AI tier". |
| `components/PostGameModal.tsx` | After game: "Rating: 1480 → 1494 (+14)" instead of "Score: 5300 / Rating: 73.1". |
| `App.tsx` | Wire up `rating_before` / `rating_after` from `POST /game/save` response. |

## 7. Backfill plan for existing games

The `games` table already has every result and the `human_player` column
saying who was X vs O. To bootstrap:

1. Migration creates `rating_subjects` for every existing user and the six AI
   tiers (seed values from §4).
1. Sort all existing `games` rows by `played_at`.
1. For each row, look up which AI tier matches `(depth, radius)` (snap to
   nearest if exact tier doesn't exist), then run the live Elo update.
1. Run BayesElo recalibration once at the end and overwrite the live ratings —
   this gives a clean canonical starting state.

This whole process is idempotent: rerunning it should yield the same numbers.

## 8. Choices that are open and need your call

1. **Rule-set separation.** Gomocup keeps freestyle/standard/renju Elo lists
   apart. Today the app only plays freestyle. Add the column now (cheap) and
   only ever populate `'freestyle'` for the foreseeable future? _(Recommended:
   yes — costs nothing.)_
1. **Board size separation.** 15×15 vs 19×19 are arguably different games. Keep
   one Elo across both, or split? _(Recommended: one Elo, note the board size
   in the game record only.)_
1. **AI tier granularity.** Six tiers as proposed, or one per `(depth, radius)`
   pair (would be 25–50 subjects)? _(Recommended: six. Easier to display and
   the depth-5/depth-4 difference is small enough that pooling is fine.)_
1. **Showing the legacy "score" anywhere?** Recommend dropping it from the UI
   in the same release that ships Elo, but leaving the column in the DB.
1. **Initial human rating.** 1200 (forgiving) or 1500 (chess-standard)?
   _(Recommended: 1500 with K=40 provisional — converges fast either way.)_
1. **Anti-abuse.** Without it, anyone can spawn a bot client and farm an
   `ai-easy` opponent. Minimum mitigation: rate-limit Elo-affecting games per
   account per hour; don't award Elo for repeat games against the same
   subject within N minutes.

## 9. Rollout sequence

1. Schema migration + AI seeding + Python BayesElo + unit tests. **No** UI
   change yet; new tables run silently in parallel with the old `score`.
1. `POST /game/save` starts dual-writing: existing `score` field preserved,
   new Elo update applied. Verify by querying both for consistency.
1. Backfill historical games into the new tables; recalibrate with BayesElo.
1. New leaderboard endpoint + frontend modal swap. Old endpoint kept for one
   release as `/leaderboard/legacy`.
1. Schedule weekly `just elo-recalibrate` cron.
1. Remove legacy endpoint and `score`-based UI in the following release.

## 10. Estimated effort

| Step | Estimate |
| --------------------------------------------------- | ------------- |
| Schema migration + models | 0.5 day |
| `elo.py` + tests | 0.5 day |
| Backend wiring (`save_game`, leaderboard, user) | 0.5 day |
| Pure-Python BayesElo + recalibrate CLI | 1 day |
| Frontend leaderboard / post-game / settings updates | 1 day |
| Backfill script + verification | 0.5 day |
| Cron + ops | 0.5 day |
| **Total** | **~4.5 days** |
