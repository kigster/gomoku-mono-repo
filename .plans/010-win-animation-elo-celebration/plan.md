# 010 — Win Animation & Elo Level-Up Celebration — Plan

Derived from [`spec.md`](./spec.md). Owner: web designer (frontend) + a thin
backend slice. Jeff Dean review notes at the end.

______________________________________________________________________

## 1. Architecture overview

```
api (Python)                              frontend (React+TS, SVG board)
────────────                              ──────────────────────────────
win_detector.has_winner ──┐
                          ├─► winning_cells  ─┐
multiplayer._build_view ──┘   (5 coords)      │   MultiplayerGameView (TS type)
                                              ├─►  MultiplayerGamePage
_write_finished_games_rows ► elo deltas ──────┘        └─ GameOverPanel  (enhanced)
   persisted on the mp game row,                            ├─ WinningStonesAnimation (SVG overlay)
   surfaced in _build_view as                              │     └─ DiamondShine (per stone)
   winner_elo_before/after +                               └─ FireworksOverlay  (level-up only)
   loser_elo_before
```

Two backend additions, both on the **participant view** (`MultiplayerGameView`),
because that is the only payload the celebration reads:

1. `winning_cells: list[(x, y)]` — the five coords of the completed line (empty
   list when there is no five-in-a-row line, e.g. resign/timeout wins).
1. The Elo deltas for *both* players, so the client can evaluate the ≥100 rule
   and compute `X`.

The frontend is **CSS-keyframe + SVG-transform** driven — `frontend/package.json`
has **no** `motion` / `framer-motion` dependency (only React 18, react-dom,
react-syntax-highlighter, Tailwind 3.4). We do **not** add an animation library;
we use Tailwind utilities + a small scoped set of `@keyframes` in
`frontend/src/index.css` (which already hosts `pulse-slow` / `slide-in`) and
inline per-element `style={{ animationDelay, ['--lift']: ... }}` for the seeded
randomness. The board is SVG, so the winning stones animate as SVG `<g>`
elements with `transform` (GPU-friendly) inside an overlay layer.

______________________________________________________________________

## 2. Backend additions

### 2a. Winning cells

`api/app/multiplayer/win_detector.py` currently exposes only `has_winner(...) -> bool` (returns at the first direction that reaches `count == 5`). Add a sibling:

```python
def winning_line(
    moves, last_x, last_y, last_player, board_size
) -> list[tuple[int, int]] | None:
    """Return the 5 cells of the completed line through (last_x,last_y),
    or None if last_player has no 5-in-a-row there."""
```

- Reuse the existing `occupied`-set construction and the four `_DIRS` walks.
- When a direction reaches `count == 5`, collect exactly the 5 cells: walk
  forward from the centre while in `occupied`, walk backward, dedupe + sort, and
  return the 5 that include `(last_x, last_y)`. Standard rule-set is **exactly 5**
  (`count == 5`, six-in-a-row is *not* a win — preserve that), so the line is
  unambiguous: return the 5 contiguous cells centred such that `(last_x,last_y)`
  is on the line. If an overline (6+) somehow occurs it is *not* a win and
  returns `None` — matches `has_winner` semantics today. **Keep `has_winner` as
  a thin `winning_line(...) is not None` wrapper** so the two cannot diverge.

Where it is called — `api/app/routers/multiplayer.py` move handler (~L555):

```python
line = winning_line(moves, x, y, your_color, board_size)
won = line is not None
new_winner = your_color if won else None
```

Persist `winning_cells` so every later poll/read of the *finished* game can echo
it (the view is rebuilt from the DB row on each request, so it must be stored,
not computed on the fly only at the winning move):

- **Schema:** add migration `api/migrations/versions/NNNN_winning_cells.py`
  (Alembic) adding `multiplayer_games.winning_cells JSONB NULL` (nullable;
  `NULL`/`[]` for draws, resigns, timeouts, and pre-migration rows).
- Write it in the same `UPDATE` that sets `winner` at game end (the
  `mp_db.finish_game` / move-commit path). Store as JSON array of `[x, y]` pairs.
- Resign path (~L612) and any 009 timeout path set `winner` **without** a line →
  leave `winning_cells = NULL`.

### 2b. Elo deltas on the view

The deltas are computed in `_write_finished_games_rows`
(`api/app/routers/multiplayer.py` L265–278): `host_elo_before/after`,
`guest_elo_before/after`. Today they land only in `games` history rows + the
`users` table — **not** on the `multiplayer_games` row, and `_build_view`
(L119–152) never exposes them. Add columns + plumb through:

- **Schema (same migration):** `multiplayer_games.host_elo_before`,
  `host_elo_after`, `guest_elo_before`, `guest_elo_after` — all `INTEGER NULL`.

- In `_write_finished_games_rows`, after computing the four values, persist them
  on the mp row (extend the finish `UPDATE`, or a dedicated
  `mp_db.set_finished_elo(...)`). Single transaction with the winner/cells write.

- `_build_view(...)` maps host/guest → **winner/loser** relative orientation so
  the client never has to reason about host vs guest:

  | New `MultiplayerGameView` field | Source |
  | ------------------------------- | ----------------------------------------- |
  | `winning_cells: list[[int,int]] \| None` | mp row `winning_cells` |
  | `winner_elo_before: int \| None` | the winner's `*_elo_before` |
  | `winner_elo_after: int \| None` | the winner's `*_elo_after` |
  | `loser_elo_before: int \| None` | the loser's `*_elo_before` |

  (Expose only what the spec needs: winner before/after for `X`, loser before
  for the gap. Omit `loser_elo_after` — not needed, avoid leaking more than
  required. All `None` until `state == 'finished'` and a winner exists.)

- Update Pydantic model `api/app/models/multiplayer.py` →
  `MultiplayerGameView` with the four fields (Optional, default `None`).
  `MultiplayerGamePreview` (non-participant slim view) deliberately does **not**
  get them.

**X (points gained), evaluated client-side:** `winner_elo_after − winner_elo_before`. **Gap rule:** `loser_elo_before − winner_elo_before ≥ 100`.

______________________________________________________________________

## 3. Frontend design

### 3a. TS types — `frontend/src/lib/multiplayerClient.ts`

Extend the `MultiplayerGameView` interface to mirror the backend:

```ts
winning_cells: [number, number][] | null;
winner_elo_before: number | null;
winner_elo_after: number | null;
loser_elo_before: number | null;
```

All optional/nullable; populated only on finished games with a winner.

### 3b. Component tree (new files under `frontend/src/components/`)

- **`WinningStonesAnimation.tsx`** — an SVG overlay `<g>` rendered *inside* the
  board SVG (or an absolutely-positioned SVG matching the board viewBox) that
  draws the 5 winning stones on top of the static board and animates them. Props:
  `cells: [number,number][]`, `boardSize`, `cellSize`/`padding` (or it imports
  the same `PADDING`/`BOARD_PX` constants `Board.tsx` uses — see
  `frontend/src/constants.ts`), `displayMode`, `seed?: number`,
  `reducedMotion: boolean`. Each stone is a `<g transform>` with
  `animation: win-lift var(--dur) ease-in-out infinite`, per-stone
  `animationDelay` and CSS custom props (`--lift`, `--dur`) set from the seeded
  PRNG; a `key` that includes the iteration nonce so React remounts → re-seeds
  each loop. Reduced-motion branch: render the 5 stones with a static golden
  `<circle>` ring, no animation.
- **`DiamondShine.tsx`** — a small SVG four-point-star (diamond) sparkle drawn at
  a stone's centre, `animation: diamond-shine ...` (scale 0→1.2→0 + opacity),
  with seeded count/angle/size/delay. Rendered as children of each winning
  stone's `<g>`. Pure presentational.
- **`FireworksOverlay.tsx`** — fixed, viewport-covering, `pointer-events-none`
  overlay of CSS-animated particle bursts (transform/opacity only; particles are
  `<div>`/`<span>` with `translate` + `scale` + `opacity` keyframes, seeded
  positions/colors). Plus the large headline. Reduced-motion: static banner, no
  particles, headline still shown.
- **Enhance `GameOverPanel`** (in
  `frontend/src/components/MultiplayerGamePage.tsx`, L400–453) — it already
  computes `youWon` / `isDraw` and owns the "Back home" link. Add:
  - render `<WinningStonesAnimation .../>` when `youWon || (winner && !isDraw)`
    *and* `game.winning_cells?.length === 5`. (Both players see the winning-line
    animation; only the winner who upset a stronger player gets fireworks.)
  - compute level-up: `const lvl = computeLevelUp(game, /*viewerIsWinner*/ youWon)`
    → `{ gained: number } | null`; when non-null render `<FireworksOverlay pointsGained={lvl.gained} reducedMotion={rm} />` and keep the existing panel.

### 3c. Seedable randomness — `frontend/src/lib/celebrationRandom.ts`

A tiny deterministic PRNG (mulberry32 / xorshift) `makeRng(seed: number)` →
`() => number in [0,1)`. Helpers: `pickStagger(rng, n)`, `jitter(rng, base, spread)`, `sparkleSpecs(rng)`. Production: `seed = Date.now() ^ Math.random()*1e9`
at mount, plus a per-loop nonce so each iteration re-seeds. Tests pass a fixed
`seed` for deterministic snapshots/queries. **No `Math.random()` inside render
paths** — only through the rng, so tests are reproducible.

### 3d. Reduced-motion hook — `frontend/src/hooks/useReducedMotion.ts`

`window.matchMedia('(prefers-reduced-motion: reduce)')` with a listener; returns
`boolean`. Both `WinningStonesAnimation` and `FireworksOverlay` consume it (panel
passes it down so there is one source of truth, mockable in tests).

### 3e. Level-up detection — `frontend/src/lib/levelUp.ts`

```ts
export function computeLevelUp(
  game: MultiplayerGameView,
  viewerIsWinner: boolean,
): { gained: number } | null {
  if (!viewerIsWinner) return null;
  if (game.winner !== "X" && game.winner !== "O") return null;
  const { winner_elo_before: wb, winner_elo_after: wa, loser_elo_before: lb } = game;
  if (wb == null || wa == null || lb == null) return null;
  if (lb - wb < 100) return null;
  return { gained: wa - wb };
}
```

Headline string lives in the component:
`` `Congratulations! You just levelled your Elo Rating by ${gained}.` ``.

### 3f. Keyframes — `frontend/src/index.css`

Add `@keyframes win-lift`, `@keyframes diamond-shine`, `@keyframes firework-burst` (transform/opacity only), and a
`@media (prefers-reduced-motion: reduce)` block that neutralizes them as a CSS
backstop even if a class slips through. Keep them scoped with `win-`/`firework-`
prefixes to avoid clashing with `pulse-slow`/`slide-in`.

______________________________________________________________________

## 4. File-by-file (real paths)

**Backend**

- `api/app/multiplayer/win_detector.py` — add `winning_line(...)`; refactor
  `has_winner` to delegate.
- `api/app/routers/multiplayer.py` — call `winning_line` in the move handler;
  store `winning_cells` + the four elo columns at finish; surface 4 new fields in
  `_build_view`.
- `api/app/models/multiplayer.py` — add 4 fields to `MultiplayerGameView`.
- `api/app/multiplayer/db.py` — extend the finish-game `UPDATE` (or add
  `set_finished_elo` / widen `finish_game`) to write `winning_cells` + elo cols;
  ensure the row-fetch selects them.
- `api/migrations/versions/NNNN_winning_cells_and_mp_elo.py` — new Alembic
  migration: `winning_cells JSONB`, `host_elo_before/after`,
  `guest_elo_before/after` INTEGER, all NULLable. (Confirm dir name with
  `ls api/migrations/versions`.)

**Frontend**

- `frontend/src/components/WinningStonesAnimation.tsx` — new.
- `frontend/src/components/DiamondShine.tsx` — new.
- `frontend/src/components/FireworksOverlay.tsx` — new.
- `frontend/src/components/MultiplayerGamePage.tsx` — enhance `GameOverPanel`.
- `frontend/src/lib/celebrationRandom.ts` — new (seedable PRNG).
- `frontend/src/lib/levelUp.ts` — new (`computeLevelUp`).
- `frontend/src/hooks/useReducedMotion.ts` — new.
- `frontend/src/lib/multiplayerClient.ts` — extend `MultiplayerGameView`.
- `frontend/src/index.css` — add scoped keyframes + reduced-motion media query.
- `frontend/src/constants.ts` — reuse `PADDING`/`BOARD_PX`/`STAR_POINTS`
  (`PADDING` is currently a local const in `Board.tsx`; export it from
  `constants.ts` and import in both so the overlay aligns pixel-perfect).

______________________________________________________________________

## 5. Test plan

**RTL / vitest** (`frontend/src/__tests__/`):

- `WinningStonesAnimation.test.tsx`
  - Given `winner="X"`, `winning_cells` of 5 coords → renders 5 animated stone
    `<g>` nodes (query by `data-testid="winning-stone"`); board still renders.
  - With a fixed `seed`, two renders produce identical delay/`--lift` style
    attrs (determinism); different seeds differ.
  - `reducedMotion=true` → renders 5 static rings, **no** elements carrying the
    `win-lift` animation class.
- `levelUp.test.ts`
  - winner, `loser_before=1300`, `winner_before=1180`, `winner_after=1204` → gap
    120 ≥ 100, `{ gained: 24 }`.
  - gap exactly 100 → triggers; gap 99 → `null`.
  - viewer is loser → `null`; draw → `null`; any elo field `null` → `null`.
- `GameOverPanel.test.tsx` (or extend existing MultiplayerGamePage tests)
  - winner + 5 `winning_cells` + 100+ gap → fireworks overlay present and the
    headline text `Congratulations! You just levelled your Elo Rating by 24.`
    with the correct X.
  - winner + 5 cells + gap < 100 → winning-stone animation but **no** fireworks /
    no congrats headline.
  - draw → neither animation nor fireworks; loss → existing panel only.
  - `prefers-reduced-motion` mocked → static fallback variant; congrats headline
    still in DOM.

**pytest** (`api/tests/`):

- `win_detector` — `winning_line` returns the exact 5 cells for each of the 4
  directions; returns `None` for no-line and for 6-in-a-row (overline); the 5
  always include the last move. `has_winner` agrees with `winning_line is not None` across a fuzz of boards.
- multiplayer move/finish — finishing a game persists `winning_cells` + the four
  elo columns; `_build_view` exposes `winning_cells` + winner/loser deltas;
  resign/draw → `winning_cells` is `null`. Preview view omits the new fields.

**Cypress (note for 012 — `.plans/012-e2e-two-human-cypress`):** the two-human
e2e suite should, after a scripted win, assert the winning-stone animation
appears (`data-testid="winning-stone"` count === 5 in the winner's view); and,
with a **seeded** matchup engineered so the loser's pre-game Elo is ≥100 above
the winner's, assert the fireworks overlay + the congrats headline with the
correct numeric X are visible to the winner and **absent** for the loser.

______________________________________________________________________

## 6. Edge cases

- **Draw** (`winner === "draw"`): no winning line, no animation, no fireworks.
  `winning_cells = NULL`.
- **Win without a line — resign / timeout (009):** `winner` is set but there is
  no five-in-a-row, so `winning_cells` is `NULL`/empty. The five-stone lift must
  **not** render (guard on `winning_cells?.length === 5`). The Elo level-up
  fireworks can **still** fire on a resign/timeout upset if the gap rule holds —
  it depends only on the elo deltas, which 009's timeout path must still write.
  **Coordinate with 009:** the timeout/resign finish path must populate the four
  elo columns (it already calls `_write_finished_games_rows`); it must **not**
  populate `winning_cells`.
- **Overline / 6-in-a-row:** not a win (`count == 5` rule preserved) →
  `winning_line` returns `None`; consistent with `has_winner` today.
- **Multiple simultaneous lines** (a move completing two directions at once): the
  spec needs *a* winning line of 5; return the first direction's 5 (deterministic
  `_DIRS` order). Optional future: union all winning cells — out of scope; pick
  one line.
- **Stale rows pre-migration:** `winning_cells`/elo columns are `NULL` → frontend
  treats as "no celebration data", shows plain game-over. No crash.
- **Simultaneous render with the polling refresh:** the animation keys off
  immutable finished-game data; once `state === 'finished'` the view stops
  changing materially, so the loop is stable. Mount the overlay once on entering
  `finished`; do not remount per poll (guard with the game `version` or a
  `finished` latch) to avoid restarting the animation each poll tick.
- **X ≤ 0:** by construction a winner who upset a stronger opponent gains
  positive Elo, so `gained > 0`; still, render defensively (if `gained <= 0`,
  suppress fireworks) — see OPEN.

______________________________________________________________________

## 7. Build sequence

1. Backend: `winning_line` + unit tests (no schema yet) — pure function, fast.
1. Migration + `db.py` writes/reads + `_build_view` fields + Pydantic model +
   pytest. Run `just test-api`.
1. Frontend types (`multiplayerClient.ts`) + `levelUp.ts` + `celebrationRandom.ts`
   - `useReducedMotion.ts` + their unit tests (`just test-frontend`).
1. `WinningStonesAnimation` + `DiamondShine` + keyframes; RTL tests.
1. `FireworksOverlay`; wire all into `GameOverPanel`; RTL tests.
1. Browser-test at `https://dev.gomoku.games` (per Hard Rule #2): finish a
   2-human game, watch the loop + reduced-motion fallback, engineer an upset for
   fireworks.
1. Hand the Cypress assertions to 012.

______________________________________________________________________

## Verifier notes (Jeff Dean)

- **ASSUMPTION:** `winning_cells` must be *persisted*, not recomputed at read
  time, because `_build_view` is rebuilt from the DB row on every poll and the
  full move list isn't replayed through the detector on reads. Confirmed by the
  view-build path (L119–152) reading columns, not recomputing.
- **ASSUMPTION:** the relevant Elo numbers are the *pre-game* ratings
  (`*_elo_before`) for the gap test, matching how 004 frames "loser's Elo was
  100+ above" — using post-game ratings would be circular.
- **ASSUMPTION:** no animation library is desired; CSS keyframes + SVG transforms
  are sufficient and avoid a dependency. `frontend/package.json` confirms no
  Motion/framer-motion present.
- **OPEN:** Does the loser also see the *winning-stone* animation, or only the
  winner? Spec says the five winning stones animate "on the board" without
  scoping to the winner; plan currently shows it to **both** participants and
  scopes only the fireworks to the winner. Confirm with product.
- **OPEN:** Exact copy when `X == 1` ("by 1 point" vs "by 1") and whether to
  append "points". Plan keeps the literal spec wording and just substitutes the
  number; revisit if product wants pluralization.
- **OPEN:** Should the Elo celebration also appear in the *AI* game flow
  (`useGameState` / single-player save), or multiplayer-only? Spec frames it as
  human-vs-human (A beats B). Plan scopes to multiplayer `GameOverPanel` only.
- **OPEN:** Migration naming/tooling — confirm `api/migrations/versions` is the
  Alembic dir and the head revision before authoring (run `alembic heads`).
- **CONCURRENCY:** writing `winning_cells` + 4 elo columns must be in the *same*
  transaction/`UPDATE` as the `winner` write so a poll never observes a finished
  game with `winner` set but celebration data still `NULL` (torn read). Verify
  the finish path is a single statement or wrapped in the existing savepoint.
