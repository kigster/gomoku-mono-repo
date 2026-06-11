# 008 — AI difficulty modes & premium hardest — plan

> Owner: Zeus (architecture) · Verifier: Jeff Dean · UI: web designer (007)
> Authored from `spec.md` in this directory.

## 1. Architecture overview

Four named difficulty modes collapse the historical free-form
`(depth, radius)` web knobs into a fixed, opinionated set. A single backend
constant is the source of truth; the frontend reads it (via a small config
endpoint) for button labels and to know which params to send. The backend
routes the AI move request to the correct engine: the existing shared C
`gomoku-httpd` for Easy/Intermediate/Hard, or — for Hardest — a per-game
ephemeral Rust container resolved through an abstraction that 011 implements.

```
007 modal ── GET /game/difficulties ──▶ DIFFICULTIES (008 constant)
   │                                         (labels + depth/radius/premium)
   ▼
POST /game/start { difficulty } ──▶ persist row (depth,radius,is_premium,
   │                                 payment_status, hardest_expires_at)
   ▼
POST /game/play  ──▶ resolve_engine_url(difficulty, game_id)
                       ├─ easy/intermediate/hard → settings.gomoku_httpd_url (C)
                       └─ hardest → 011.resolve_hardest_engine_url(game_id) (Rust 8-vCPU)
   ▼
game ends OR 15-min cap ──▶ /game/save (draw on cap) + teardown_hardest(game_id) [011]
```

## 2. Single-source difficulty config

New module **`api/app/difficulty.py`** — the one place the four modes are
defined. Modeled on the existing `app/elo.py` constant style.

```python
from dataclasses import dataclass
from enum import StrEnum

class Difficulty(StrEnum):
    EASY = "easy"
    INTERMEDIATE = "intermediate"
    HARD = "hard"
    HARDEST = "hardest"

@dataclass(frozen=True, slots=True)
class DifficultySpec:
    key: Difficulty
    label: str          # short label, e.g. "Easy"
    depth: int
    radius: int
    engine: str         # "c" | "rust"
    is_premium: bool

DIFFICULTIES: dict[Difficulty, DifficultySpec] = {
    Difficulty.EASY:         DifficultySpec(Difficulty.EASY,         "Easy",         3, 2, "c",    False),
    Difficulty.INTERMEDIATE: DifficultySpec(Difficulty.INTERMEDIATE, "Intermediate", 5, 2, "c",    False),
    Difficulty.HARD:         DifficultySpec(Difficulty.HARD,         "Hard",         7, 2, "c",    False),
    Difficulty.HARDEST:      DifficultySpec(Difficulty.HARDEST,      "Hardest",      9, 2, "rust", True),
}

HARDEST_CAP_SECONDS = 15 * 60  # wall-clock ceiling for premium Hardest games
```

The numbers are **verbatim** from spec.md's table. Nothing else may inline
depth/radius for the web flow.

**How the frontend gets labels.** New read-only route
`GET /game/difficulties` in `api/app/routers/game.py` returns the list
(key, label, depth, radius, is_premium, price_usd, beta_free) so 007 renders
buttons without hard-coding numbers. The full Hardest button string
("...Hardest Mode (Premium Game: $1 — Play for Free during Beta Testing)")
is composed on the frontend from `is_premium + price_usd + beta_free`; the
backend supplies the data, 007 owns the copy/layout.

## 3. "Resolve engine URL for difficulty" abstraction

New module **`api/app/engine_routing.py`** — the seam between 008 and 011.

```python
async def resolve_engine_url(difficulty: Difficulty, game_id: str, request) -> str:
    """Return the base URL of the engine to use for this game's AI moves.

    - C tiers (easy/intermediate/hard): the shared gomoku-httpd
      (settings.gomoku_httpd_url) — same engine the proxy uses today.
    - hardest: delegate to the 011-provided resolver, which provisions
      (or reuses) the per-game 8-vCPU Rust container and returns its URL.
    """
    spec = DIFFICULTIES[difficulty]
    if spec.engine == "c":
        return get_settings().gomoku_httpd_url
    return await resolve_hardest_engine_url(game_id)  # implemented by 011

async def resolve_hardest_engine_url(game_id: str) -> str:  # 011 implements
    raise NotImplementedError("provisioned by task 011")

async def teardown_hardest(game_id: str) -> None:           # 011 implements
    raise NotImplementedError("provisioned by task 011")
```

008 ships the stubs + the C branch (which works today). 011 fills in the two
`NotImplementedError` bodies and wires the teardown into the lifecycle. Until
011 lands, requesting Hardest returns a clean "Hardest mode is warming up"
503 rather than crashing (see edge cases).

Note: today `/game/play` uses a single long-lived `request.app.state.httpx_client`
with a fixed base URL (`api/app/main.py:36`). To support a per-game variable
URL, `/game/play` must issue the POST against the **resolved** URL. For the C
tiers it can keep using the shared client (base URL = `gomoku_httpd_url`); for
Hardest it builds a short-lived `AsyncClient(base_url=resolved)` (011 may
refine connection reuse). The current `client.post("/gomoku/play", ...)` call
moves behind `resolve_engine_url`.

## 4. Request/response flow per difficulty

### `POST /game/start` (`api/app/routers/game.py` `start`)

- Extend `GameStartRequest` (`api/app/models/game.py`) with
  `difficulty: Difficulty | None = None`. Back-compat: if `difficulty` is
  set, it **wins** and overrides `depth`/`radius` from the `DifficultySpec`;
  if absent (legacy clients), keep the existing `depth`/`radius` defaults.
- Resolve `spec = DIFFICULTIES[difficulty]` → write `depth=spec.depth`,
  `radius=spec.radius`, `is_premium=spec.is_premium`.
- Premium gating happens here (see §5). For Hardest, also compute and store
  `hardest_expires_at = now() + HARDEST_CAP_SECONDS` and set
  `payment_status` (`'beta_free'` when the beta flag is on).
- The existing INSERT gains the new columns. Returns `game_id` as today.

### `POST /game/play` (`api/app/routers/game.py` `play`)

- Today it is body-only and stateless. To route per-difficulty it needs the
  game's difficulty. Two options (ASSUMPTION resolves):
  - **Preferred:** the client includes `game_id` in the play body (it already
    holds it from `/game/start`); the route looks up `difficulty`/`is_premium`
    from the row, calls `resolve_engine_url`, and proxies to that URL.
  - **Fallback:** the client sends `difficulty` directly in the play body.
- Easy/Intermediate/Hard resolve to `gomoku_httpd_url` (current behavior,
  zero functional change). Hardest resolves to the 011 Rust URL.

### `POST /game/save` (`api/app/routers/game.py` `save`)

- Unchanged for C tiers. For Hardest:
  - On normal finish: after writing the completed row, call
    `teardown_hardest(game_id)` (011) to destroy the container.
  - On cap (a `winner == "draw"` save, or a cap-triggered finalize path):
    record `winner='draw'`, Elo `score_a = 0.5`, then `teardown_hardest`.
  - The existing Elo block already handles opponent rating via
    `ai_tier_rating(ai_depth, radius)` — depth 9 gets a seeded rating (§7).

## 5. Premium gating: flag + games-row column + migration

### Config flag

Add to `api/app/config.py` `Settings`:

```python
# Premium / payment
premium_beta_free: bool = True   # env: PREMIUM_BETA_FREE — bypass $1 charge during beta
hardest_price_usd: int = 1       # nominal price of Hardest mode
```

Gating logic in `/game/start` for `is_premium` specs:

```python
if spec.is_premium:
    if settings.premium_beta_free:
        payment_status = "beta_free"
    else:
        # SEAM: real payment check lands here (future). For now, reject.
        raise HTTPException(402, "Premium payment required")  # future: verify receipt
else:
    payment_status = "free"
```

This keeps a single, obvious seam: when `premium_beta_free` flips to
`false`, the `else` branch becomes the payment-verification call site.

### `games` row columns + migration

New migration **`api/db/migrations/versions/20260609-120000-add-premium-and-hardest-cap.py`**
(revision `0016`, down_revision `0015` — current head is
`20260526-180000` rev `0015`). Sketch:

```python
revision = "0016"
down_revision = "0015"

def upgrade():
    op.execute("""
        ALTER TABLE games
            ADD COLUMN is_premium BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'free',
            ADD COLUMN hardest_expires_at TIMESTAMPTZ
    """)
    op.execute("""
        ALTER TABLE games
            ADD CONSTRAINT games_payment_status_chk
            CHECK (payment_status IN ('free','beta_free','paid','refunded'))
    """)
    # Premium games are always Rust depth-9; sanity guard (not enforced on
    # legacy/non-premium rows which default is_premium=false).
    op.execute("CREATE INDEX games_premium_idx ON games (is_premium) WHERE is_premium")

def downgrade():
    op.execute("DROP INDEX IF EXISTS games_premium_idx")
    op.execute("ALTER TABLE games DROP CONSTRAINT IF EXISTS games_payment_status_chk")
    op.execute("""
        ALTER TABLE games
            DROP COLUMN IF EXISTS is_premium,
            DROP COLUMN IF EXISTS payment_status,
            DROP COLUMN IF EXISTS hardest_expires_at
    """)
```

Existing rows backfill to `is_premium=false / payment_status='free'`. The
`game_type` CHECK relaxations from migration 0013 are untouched.

## 6. Hardest-mode lifecycle (provision → play → cap → teardown)

| Step | Trigger | Action | Enforced by |
| ---- | ------- | ------ | ----------- |
| Provision | first `/game/play` for a Hardest `game_id` (or eagerly at `/game/start`) | `resolve_hardest_engine_url(game_id)` boots 8-vCPU Rust container, returns URL | 011 (008 calls it) |
| Play | each `/game/play` | proxy move to resolved Rust URL | 008 routing |
| Cap set | `/game/start` | store `hardest_expires_at = now()+15m` | 008 |
| Cap enforce | wall-clock reaches `hardest_expires_at` | finalize row as `winner='draw'`, then teardown | 011 lifecycle (daemon / Cloud Run request timeout) calls 008's finalize-as-draw helper |
| Teardown | normal finish OR cap | `teardown_hardest(game_id)` destroys container | 011 (008 calls on save) |

008 provides a small `finalize_hardest_draw(game_id, conn)` helper (in
`game.py` or a `hardest.py` module) so 011's cap path and the normal save
path share one draw-writing routine. ASSUMPTION: cap enforcement is a 011
concern; 008 only guarantees the row is correctly finalized when something
(011 or the client) reports the cap.

## 7. Elo rating for depth 9

Add the depth-9 tier to `AI_TIER_RATINGS` in `api/app/elo.py`. Current top
seeded tier is `(6,4): 2500`; the closed-form fallback for `(9,2)` would be
`600 + 250*9 + 50*2 = 2950`, which is too high for a 9-ply/radius-2 engine.
Seed an explicit, sane value and intermediate depths used by the web modes:

```python
    # depth 7 (hard, web)
    (7, 2): 2300,
    # depth 9 (hardest, premium — Rust 8-vCPU)
    (9, 2): 2600,
```

(depth 3/5 with radius 2 are already covered: `(3,2)=1200`, `(5,2)=1950`.)
This keeps the curve monotone and avoids the fallback's overshoot. The save
path already calls `ai_tier_rating(ai_depth, radius)`, so no routing change
is needed — only the seed.

## 8. File-by-file (real paths)

- **`api/app/difficulty.py`** (new) — `Difficulty` enum, `DifficultySpec`,
  `DIFFICULTIES`, `HARDEST_CAP_SECONDS`.
- **`api/app/engine_routing.py`** (new) — `resolve_engine_url`,
  `resolve_hardest_engine_url` (stub for 011), `teardown_hardest` (stub).
- **`api/app/elo.py`** — add `(7,2)` and `(9,2)` to `AI_TIER_RATINGS`.
- **`api/app/config.py`** — add `premium_beta_free`, `hardest_price_usd`.
- **`api/app/models/game.py`** — `GameStartRequest.difficulty`; optional
  `difficulty`/`game_id` reflection on play; expose difficulty list model
  for `GET /game/difficulties`.
- **`api/app/routers/game.py`** — `GET /game/difficulties`; difficulty
  resolution + premium gating + `hardest_expires_at` in `start`;
  `resolve_engine_url` in `play`; `teardown_hardest` + draw-on-cap in `save`.
- **`api/db/migrations/versions/20260609-120000-add-premium-and-hardest-cap.py`**
  (new, rev `0016`).
- **`frontend/src/components/...`** (007-owned) — consumes
  `GET /game/difficulties`; sends `difficulty` on `/game/start`/`/game/play`.
- **`iac/cloud_run/main.tf`** — no change in 008 (the per-game Rust service
  is 011). 008 only documents the requirement (8 vCPU, ephemeral).

## 9. Test plan

**pytest (`api/tests/...`, runs via `just test-api`, 5 xdist workers):**

- `test_difficulty_mapping` — `DIFFICULTIES` matches the spec table exactly
  (easy=3/2/c, intermediate=5/2/c, hard=7/2/c, hardest=9/2/rust, hardest
  premium). Guards against silent drift from the umbrella spec.
- `test_difficulties_endpoint` — `GET /game/difficulties` returns 4 entries
  with labels + premium flag + price.
- `test_start_sets_depth_radius_from_difficulty` — POST `/game/start`
  `{difficulty:"hard"}` persists `depth=7,radius=2`.
- `test_beta_free_bypass` — with `premium_beta_free=true`, Hardest start
  succeeds and writes `payment_status='beta_free'`, `is_premium=true`,
  `hardest_expires_at` ≈ now+15m.
- `test_premium_requires_payment_when_beta_off` — monkeypatch
  `premium_beta_free=false` → Hardest start returns 402.
- `test_depth9_routes_to_rust_resolver` — monkeypatch
  `resolve_hardest_engine_url` to a mock returning a fake URL; assert a
  Hardest `/game/play` calls it (and C tiers do **not**). Confirms the
  routing seam without a live Rust container.
- `test_resolve_engine_url_c_tiers` — easy/intermediate/hard →
  `settings.gomoku_httpd_url`.
- `test_depth9_elo_seeded` — `ai_tier_rating(9,2) == 2600` (not the fallback
  overshoot).
- `test_save_hardest_draw_on_cap` — saving a Hardest game with
  `winner='draw'` writes Elo `score_a=0.5` and calls `teardown_hardest`.

**Cypress (note for 012):** 012 owns e2e. Minimal smoke this slice enables:
start an **AI Easy** game from the modal and play it to a finished state
(verifying the difficulty→params path end-to-end against the C engine).
Hardest e2e is deferred to 011/012 because it needs the ephemeral container.

## 10. Edge cases

- **Rust provision fails / 011 not yet shipped.** `resolve_hardest_engine_url`
  raising `NotImplementedError` or a provisioning error → `/game/play`
  returns a clean 503 with a user-facing "Hardest mode is warming up, please
  retry" message (mirrors the existing 503 in `play` for engine
  unavailability). The game row is already created; no partial-charge concern
  while beta-free.
- **Payment seam.** With `premium_beta_free=false` and no payment integration
  yet, Hardest start returns 402 — explicit, not a silent downgrade to Hard.
  The frontend (007) should surface "coming soon" rather than letting the
  user pick a mode that 402s. ASSUMPTION: acceptable while beta flag stays on.
- **Concurrent Hardest games.** One 8-vCPU container per `game_id`. The
  `/game/start` abandon-prior-in-progress sweep already flips a user's stale
  AI rows to `abandoned`; 011 must teardown the container for an abandoned
  Hardest game (008 calls `teardown_hardest` in that sweep path too, for
  premium rows). Cost guard against many simultaneous premium games is an
  011 concern (quota/concurrency cap).
- **Legacy client (no `difficulty`).** Falls back to raw `depth`/`radius`
  → routes to C, never premium. No behavior change.
- **Cap reached but client never calls save.** 011's wall-clock teardown is
  the backstop; it calls 008's `finalize_hardest_draw`. Lazy-finalize on next
  read of an expired Hardest row (like multiplayer's lazy expiry) is a cheap
  optional safety net.

## 11. Build sequence

1. `api/app/difficulty.py` + `api/app/config.py` flags + `api/app/elo.py`
   seeds (pure constants, unit-testable immediately).
1. Migration `0016` (columns) — run via Alembic against local test DBs.
1. `api/app/engine_routing.py` with C branch live + Rust stubs.
1. `api/app/routers/game.py`: `GET /game/difficulties`, then `start`
   (difficulty + premium + cap), then `play` routing, then `save`
   teardown/draw.
1. `api/app/models/game.py` request/response model updates.
1. pytest suite (§9).
1. Hand `resolve_hardest_engine_url` / `teardown_hardest` / cap-enforcement
   contract to 011; hand `GET /game/difficulties` + button data to 007.

## ASSUMPTION / OPEN

- **ASSUMPTION:** `/game/play` will carry `game_id` (already client-held) so
  the route can look up difficulty/premium from the row. If product prefers
  keeping play fully stateless, the client sends `difficulty` in the play
  body instead — both are supported by `resolve_engine_url`'s signature.
- **ASSUMPTION:** the 15-minute cap is enforced primarily by 011's lifecycle
  (Cloud Run timeout / teardown daemon); 008 only guarantees correct
  draw-finalization of the row and supplies the shared helper.
- **ASSUMPTION:** depth-9 Elo of 2600 is a placeholder pending empirical
  calibration (same caveat as the rest of `AI_TIER_RATINGS`).
- **OPEN:** does the `games_game_type_*` CHECK from 0013 need to admit a
  `draw` winner for AI rows? Verify the existing completed-game CHECK allows
  `winner='draw'` for `game_type='ai'`; if it only allows `X`/`O`/`none`,
  the cap-draw write needs the CHECK relaxed in migration 0016.
- **OPEN:** should beta-free Hardest games still record a `$1` "would-have-
  charged" amount for later reconciliation? Currently only `payment_status`
  is recorded; add a `price_charged_cents` column if finance wants it.
- **OPEN:** per-user concurrency / cost cap on premium games (likely 011, but
  the policy decision is product's).
