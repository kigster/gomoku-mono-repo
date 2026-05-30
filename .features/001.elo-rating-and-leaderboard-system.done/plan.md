# Plan: Elo scoring + Top-100 leaderboard with conditional refresh

## Why now

The current scoring (`game_score(human_won, depth, radius, time)` → 0..7250) is a
deterministic function of the *parameters of one game*. It rewards beating the
AI at high depth with low time-to-win, but it has no notion of trajectory: a
player who beats depth=4 once and never plays again has the same "max_score"
forever. Elo gives a moving rating that converges to the player's true
strength against the AI ladder, naturally rewards consistent play, and
penalises sandbagging at low depth.

The work is split into three phases — phases can ship independently and each
adds value on its own.

______________________________________________________________________

## Phase 1 — Elo storage + math

### Schema additions (migration `0006-add-elo.py`)

```sql
ALTER TABLE users
  ADD COLUMN elo_rating       INT NOT NULL DEFAULT 1500,
  ADD COLUMN elo_games_count  INT NOT NULL DEFAULT 0,
  ADD COLUMN peak_elo         INT NOT NULL DEFAULT 1500;

ALTER TABLE games
  ADD COLUMN elo_before       INT,
  ADD COLUMN elo_after        INT,
  ADD COLUMN elo_delta        INT GENERATED ALWAYS AS (elo_after - elo_before) STORED,
  ADD COLUMN opponent_elo     INT;

CREATE INDEX idx_users_elo ON users (elo_rating DESC);
```

**Backfill**: leave `elo_before`/`elo_after` NULL for pre-Elo games. Don't
retroactively rate historical games — it would produce noisy ratings and the
old `score` column already captures their ranking.

### AI opponent rating

The AI is treated as a fixed-strength opponent at each (depth, radius) combo.
Initial table (calibrate from the depth-tournament eval data already in
`gomoku-c/tests/evals/`):

| depth | radius=2 | radius=3 | radius=4 |
|------:|---------:|---------:|---------:|
| 2 | 900 | 1000 | 1100 |
| 3 | 1200 | 1300 | 1400 |
| 4 | 1500 | 1600 | 1700 |
| 5 | 1800 | 1900 | 2000 |
| 6 | 2050 | 2150 | 2250 |

Implemented as `app/elo.py::ai_opponent_rating(depth, radius) -> int` and as a
parallel SQL function `ai_opponent_elo(depth INT, radius INT) RETURNS INT` so
both server-side computation and reporting queries can use it. The numbers are
seed values; tune after collecting ~1k Elo-rated games.

### Elo math

Standard Elo, K-factor scales with `elo_games_count`:

```python
def expected_score(player_elo: int, opponent_elo: int) -> float:
    return 1.0 / (1.0 + 10 ** ((opponent_elo - player_elo) / 400))

def k_factor(games_played: int, current_elo: int) -> int:
    if games_played < 30:    return 40   # provisional
    if current_elo >= 2400:  return 16   # masters tier
    return 24                              # established

def new_rating(elo: int, opponent_elo: int, score: float, games: int) -> int:
    expected = expected_score(elo, opponent_elo)
    k = k_factor(games, elo)
    return round(elo + k * (score - expected))
```

`score` is `1.0` for win, `0.0` for loss, `0.5` for draw.

### `/game/save` handler changes

Within the existing transaction in `routers/game.py::save`:

1. `SELECT elo_rating, elo_games_count FROM users WHERE id = $1 FOR UPDATE`
   (the row lock matters — without it concurrent saves from the same user race
   on the running counter)
1. Compute `opponent_elo`, `score`, `new_rating`
1. `UPDATE users SET elo_rating = $1, elo_games_count = elo_games_count + 1, peak_elo = GREATEST(peak_elo, $1) WHERE id = $2`
1. `INSERT INTO games (..., elo_before, elo_after, opponent_elo) VALUES (...)`
1. Return new `GameSaveResponse` fields: `elo_before`, `elo_after`, `elo_delta`

**Backwards compat**: keep the existing `score` column and `game_score()` SQL
function — they still drive the old leaderboard query. Elo and score coexist
during the transition. `LeaderboardEntry` model gains an optional `elo`
field; older clients ignore it.

### Tests

- Unit: `app/tests/test_elo.py` — symmetry (winner +N == loser -N), bounds
  (rating never < 0), K-factor transitions, expected-score for known pairs
  (1500 vs 1500 → 0.5, 1600 vs 1400 → ~0.76).
- Integration: post a fake game via `/game/save`, assert users row updated,
  games row populated.

______________________________________________________________________

## Phase 2 — Top-100 materialized view

### Migration `0007-create-top-100-elo.py`

```sql
CREATE MATERIALIZED VIEW top_100_elo AS
SELECT
    u.id            AS user_id,
    u.username,
    u.elo_rating,
    u.peak_elo,
    u.elo_games_count,
    ROW_NUMBER() OVER (ORDER BY u.elo_rating DESC, u.id) AS rank
FROM users u
WHERE u.elo_games_count >= 5     -- exclude provisional players
ORDER BY u.elo_rating DESC
LIMIT 100
WITH NO DATA;

-- CONCURRENTLY refresh requires a unique index
CREATE UNIQUE INDEX idx_top_100_elo_user ON top_100_elo (user_id);
CREATE INDEX idx_top_100_elo_rank        ON top_100_elo (rank);

-- Initial population (acceptable to block on this once during deploy)
REFRESH MATERIALIZED VIEW top_100_elo;
```

### Query path

New endpoint `GET /leaderboard/elo?limit=100`:

```sql
SELECT user_id, username, elo_rating, peak_elo, elo_games_count, rank
FROM top_100_elo
ORDER BY rank
LIMIT $1
```

Single index scan, ~1 ms on Neon. The existing `/leaderboard` endpoint
continues to work; we'll deprecate it once the SPA migrates.

### "5-game minimum" rationale

Provisional players (< 5 games) have ratings dominated by Elo's K=40 bootstrap
behaviour. A first-game lucky win can push a brand-new player to 1540, which
would clutter the top 100 with noise. Five games is enough for the rating to
stabilise within ~50 points of the true value.

______________________________________________________________________

## Phase 3 — Conditional refresh

### The constraint

`REFRESH MATERIALIZED VIEW CONCURRENTLY top_100_elo` cannot run inside a
transaction (Postgres restriction), so it cannot live in an `AFTER INSERT`
trigger. Two viable options:

### Option A (recommended) — FastAPI background task with DB-evaluated condition

In `routers/game.py::save`, after the transaction commits:

```python
@router.post("/save")
async def save(...):
    async with pool.acquire() as conn:
        async with conn.transaction():
            # ... existing inserts/updates, returning new_elo and old_elo ...
            min_top_elo = await conn.fetchval(
                "SELECT COALESCE(MIN(elo_rating), 0) FROM top_100_elo"
            )

    # Schedule refresh outside the transaction. Cheap predicate avoids 99% of refreshes.
    if max(old_elo, new_elo) > min_top_elo:
        background_tasks.add_task(_refresh_top_100, request.app.state.db_pool)

    return GameSaveResponse(...)


async def _refresh_top_100(pool):
    async with pool.acquire() as conn:
        await conn.execute("REFRESH MATERIALIZED VIEW CONCURRENTLY top_100_elo")
```

**Why both `old_elo` and `new_elo`**: a player already in top 100 whose rating
*drops* still affects the ordering — must refresh.

**Race conditions**: two concurrent saves can both decide a refresh is needed
and both fire `REFRESH CONCURRENTLY`. Postgres serialises them on the view's
exclusive lock; readers continue to see the stale view through the refresh.
Worst case: a small queue of redundant refreshes. Acceptable.

**Debounce (optional polish for high traffic)**: add a 5-second coalescing
window — a module-level `asyncio.Event` + `asyncio.Lock` so multiple
near-simultaneous saves trigger exactly one refresh. Not needed at current
traffic; add when post-deploy metrics show > 1 refresh/sec.

### Option B — DB trigger emits `pg_notify`, app listens

```sql
CREATE OR REPLACE FUNCTION notify_top_100_dirty() RETURNS TRIGGER AS $$
DECLARE
    threshold INT;
    user_new_elo INT;
BEGIN
    SELECT COALESCE(MIN(elo_rating), 0) INTO threshold FROM top_100_elo;
    SELECT elo_rating INTO user_new_elo FROM users WHERE id = NEW.user_id;
    IF user_new_elo > threshold THEN
        PERFORM pg_notify('top_100_dirty', NEW.user_id::text);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_games_notify_top_100
AFTER INSERT ON games
FOR EACH ROW
WHEN (NEW.elo_after IS NOT NULL)
EXECUTE FUNCTION notify_top_100_dirty();
```

Lifespan task in FastAPI: dedicated connection (NOT through pool), `LISTEN top_100_dirty`, debounce 5s, refresh.

**Why this is the *non*-recommended option**: Neon's pooled endpoint is in
transaction mode and **does not support LISTEN/NOTIFY** reliably — the
notification is tied to the backend connection, but the pooler may swap
backends between transactions. To use this option you'd need a second
connection through Neon's *direct* (unpooled) endpoint, plus the app keeps a
long-lived connection always open, which fights Cloud Run's scale-to-zero.

Use Option B only if you migrate off Neon to Cloud SQL and have a long-lived
worker process (not Cloud Run). For now: Option A.

### Safety net — periodic full refresh

Regardless of which option, register a background task in the lifespan that
unconditionally `REFRESH MATERIALIZED VIEW CONCURRENTLY top_100_elo` every
10 minutes. Costs nothing (CONCURRENTLY locks read-only readers), guarantees
the view never drifts more than 10 min from truth even if a notification or
background task is dropped.

```python
async def _periodic_refresh(pool):
    while True:
        await asyncio.sleep(600)
        try:
            async with pool.acquire() as conn:
                await conn.execute("REFRESH MATERIALIZED VIEW CONCURRENTLY top_100_elo")
        except Exception as exc:
            log.warning("periodic_top_100_refresh_failed", error=str(exc))
```

Started in `lifespan()` before `yield`, cancelled after.

______________________________________________________________________

## Phase 4 — Switch global leaderboard display to Elo

### Scope

Replace what `LeaderboardModal.tsx` shows: instead of "best single-game score
per player" pulled from `games`, render "current Elo ranking" pulled from
`top_100_elo`. The "best score" view doesn't disappear forever — it moves
into a secondary tab so deep-history fans can still find it.

### Backend

`api/app/routers/leaderboard.py`:

```python
@router.get("", response_model=LeaderboardResponse)
async def get_leaderboard(limit: int = Query(100, ge=1, le=100), pool=Depends(get_pool)):
    """Top players by current Elo rating, served from materialized view."""
    rows = await pool.fetch(
        """SELECT user_id, username, elo_rating, peak_elo,
                  elo_games_count, rank
           FROM top_100_elo
           ORDER BY rank
           LIMIT $1""",
        limit,
    )
    return LeaderboardResponse(entries=[
        LeaderboardEntry(
            rank=r["rank"],
            username=r["username"],
            elo_rating=r["elo_rating"],
            peak_elo=r["peak_elo"],
            games_played=r["elo_games_count"],
        ) for r in rows
    ])


# Keep the legacy "best game" view available at a sub-path for the
# secondary tab; reuses existing query against games table verbatim.
@router.get("/best-games", response_model=LegacyLeaderboardResponse)
async def get_best_games(limit: int = Query(100, ge=1, le=500), pool=Depends(get_pool)):
    # ... existing DISTINCT ON query body unchanged ...
```

`api/app/models/types.py`: split `LeaderboardEntry` (Elo shape) from
`LegacyLeaderboardEntry` (score shape, the current model). Both response
classes use the appropriate entry type.

**Why the materialized view is keyed by `username` and not `user_id` in the
HTTP response is a bug today** — the legacy query at line 35 uses
`COALESCE(user_id::text, lower(username))` to dedupe anonymous + signed-in
play. The new view drops that fallback because Elo only exists for
authenticated games (`/game/save` requires auth), so `user_id` is always set.
That's a small correctness win.

### Frontend

`frontend/src/components/LeaderboardModal.tsx`:

```tsx
interface LeaderboardEntry {
  rank: number
  username: string
  elo_rating: number
  peak_elo: number
  games_played: number
}

// Columns:  #  Player  Rating  Peak  Games
// (drops:  Score, Depth, Time, Location)
```

A small "View: [Current Rating ▼ Best Games]" toggle at the top switches
between the new endpoint and `/leaderboard/best-games`. Default is Current
Rating. Persist the choice in `localStorage` so power users land on their
preferred view.

`frontend/src/__tests__/LeaderboardModal.test.tsx`: update fixtures to the
new shape; add a test for the toggle.

### Empty state during the transition

Until enough players have ≥ 5 Elo-rated games, `top_100_elo` will be sparse
or empty. The modal already has a "No scores yet" empty state — extend it:

```tsx
{!loading && !error && entries.length === 0 && (
  <div className='py-8 text-center text-neutral-400'>
    <p>The Elo leaderboard is just getting started.</p>
    <p className='mt-2 text-xs'>
      Players need {MIN_GAMES_FOR_RANKING} rated games to appear here.
      <button onClick={() => setView('best-games')}>
        See all-time best games instead
      </button>
    </p>
  </div>
)}
```

### Cache headers

Add `Cache-Control: public, max-age=30, stale-while-revalidate=300` to the
`/leaderboard` response. The view is recomputed every game-save in top-100
range (Phase 3) and every 10 minutes unconditionally (Phase 3 safety net),
so 30s freshness is plenty. SWR=300s lets a CDN serve stale during a brief
backend hiccup. Cheap UX win and reduces DB load if the modal becomes
popular.

### Backwards compatibility

The current `/leaderboard` response has fields the SPA reads
(`score`, `rating`, `depth`, `human_time_s`, `geo_*`). Strict shape change.
Mitigation: bump the response shape on day one of Phase 4 — there's only
one consumer (the SPA we ship together) — and rely on the `/best-games`
sub-route for anything that wants the old shape. No external API consumers
yet, per `CLAUDE.md`.

______________________________________________________________________

## Migration order and rollout

1. **Ship Phase 1 alone** — Elo computation, no leaderboard changes. SPA can
   show the new "Your rating: 1547 (+12)" toast after each game. Validates
   the math on real games.
1. **Wait ~1 week** — collect ~100 rated games, eyeball the AI rating table
   against actual win rates, retune.
1. **Ship Phase 2** — `top_100_elo` view exists but nothing reads it yet.
   Manual refresh via `python -m app.cli.main leaderboard refresh` proves
   the view populates correctly.
1. **Ship Phase 3** — conditional refresh in `/game/save` + periodic safety
   refresh in lifespan. View now stays fresh on its own.
1. **Ship Phase 4** — flip the SPA leaderboard to read from the view, move
   the legacy view to `/leaderboard/best-games`. This is the user-visible
   change.
1. **Eventually** — drop the legacy `/leaderboard/best-games` and the
   `game_score()` SQL function once usage analytics show < 1% of leaderboard
   opens use the secondary tab. Two-phase: stop writing `score` first,
   delete after a retention window passes.

______________________________________________________________________

## Open questions to settle before Phase 1

1. **Initial rating: 1500 or 1200?** USCF/FIDE use 1200 for unrated; chess
   community defaults to 1500. Recommend **1500** so the centre of the AI
   ladder (depth=3 ≈ 1300) doesn't trigger huge negative swings on a new
   player's first loss.
1. **Should depth-1 games count?** Currently depth=1 is "AI plays randomly."
   Pure noise — recommend `WHERE depth >= 2` in the materialized view filter,
   in addition to the 5-game minimum.
1. **Anonymous play**: `/game/play` is anonymous, `/game/save` requires auth.
   What happens if a user plays 10 games anonymously then signs up? Today
   those games have `user_id = NULL` and don't count toward Elo. Acceptable
   trade-off; users learn to log in for credit.
1. **Score column fate**: keep `games.score` populated indefinitely (cheap,
   useful for time-decay leaderboards), or stop populating once Elo lands?
   Recommend **keep populating** — it's two SQL function calls, costs nothing.

______________________________________________________________________

## Files touched (estimated diff size)

| File | Phase | Lines |
|------|:-----:|------:|
| `api/db/migrations/versions/0006-add-elo.py` (new) | 1 | ~50 |
| `api/app/elo.py` (new) | 1 | ~80 |
| `api/app/routers/game.py` | 1 | +~30 |
| `api/tests/test_elo.py` (new) | 1 | ~80 |
| `api/db/migrations/versions/0007-create-top-100-elo.py` (new) | 2 | ~30 |
| `api/app/main.py` (lifespan periodic refresh) | 3 | +~15 |
| `api/app/routers/game.py` (background refresh task) | 3 | +~15 |
| `api/app/routers/leaderboard.py` (rewrite + sub-route) | 4 | +~40 |
| `api/app/models/types.py` (split entry types) | 4 | +~20 |
| `frontend/src/components/LeaderboardModal.tsx` | 4 | ±~60 |
| `frontend/src/__tests__/LeaderboardModal.test.tsx` | 4 | ±~30 |
| **Total** | | **~450 lines** |

| Phase | Lines | Backend / Frontend / DB |
|------:|------:|:------------------------|
| 1 | ~240 | python + SQL migration |
| 2 | ~30 | SQL migration only |
| 3 | ~30 | python only |
| 4 | ~150 | python + tsx + tests; user-visible flip |
