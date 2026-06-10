# 012 — Plan: true two-human e2e + green suite

Owner: Zeus (architecture), with Jeff Dean verifier notes appended.
Implements the strategy in [`spec.md`](./spec.md). No product code 002–011
is written here — only test harness, specs, seams (as *requirements* on
the owners), and CI wiring.

## 1. Harness architecture

Two harnesses, split by client count:

```
┌─────────────────────────── bin/gctl start -r ───────────────────────────┐
│  nginx/envoy → FastAPI (/ws, /multiplayer, /auth, /social) → gomoku-httpd│
│                         ↕ asyncpg → Postgres :5433 (gomoku dev DB)        │
└──────────────────────────────────────────────────────────────────────────┘
        ▲                                              ▲              ▲
        │ single real browser                          │ ctx A        │ ctx B
   ┌────┴─────┐                                    ┌────┴──────────────┴────┐
   │ Cypress  │  modal(007), chat(006),            │ Playwright            │
   │ (1 tab)  │  invite-flow regression,           │ 2 BrowserContexts =   │
   │          │  presence load modal               │ 2 live UIs + 2 sockets│
   └──────────┘                                    └───────────────────────┘
```

- **Cypress** keeps its current config (baseUrl `:5173`, api `:8000`, DB
  `:5433`, `dbQuery` / `dbCleanupUsers` tasks). It owns every test that
  needs only one live client.
- **Playwright** is added under `frontend/` (or `frontend/e2e-pw/`), uses
  the **same** local cluster (`bin/gctl start -r`) and the **same** dev
  DB. Two `browser.newContext()` calls give two isolated cookie/storage
  jars = two real humans, each with its own `/ws` socket, alive at the
  same time. Playwright's `page.evaluate` seeds `sessionStorage`
  (`gomoku_auth_token` / `gomoku_username`) exactly as Cypress's
  `window:before:load` hook does today.

Why two harnesses rather than porting everything to Playwright: the
existing Cypress suite + `dbQuery`/`dbCleanupUsers` tasks already work and
are cheap to maintain; the only thing Cypress *can't* do is two
concurrent UIs. Minimise blast radius — add Playwright for exactly that
one capability.

## 2. File layout

```
frontend/
  cypress/
    e2e/
      multiplayer.cy.ts                 (REWRITE — invite-flow single-client regression)
      chat-slash-commands.cy.ts         (REWRITE — /like /boo /help)
      multiplayer-modal-defaults.cy.ts  (REWRITE — redesigned modal + presence)
    support/
      commands.ts                       (EXTEND — keep useUser; add helpers below)
      e2e.ts                            (unchanged)
  e2e-pw/                               (NEW — Playwright)
    playwright.config.ts                (baseURL from env, reuses gctl cluster)
    fixtures/
      auth.ts                           (signup + token via API request context)
      seed.ts                           (DB seed/cleanup over pg, shared SQL w/ cypress)
      board.ts                          (pixel→intersection click, mirrors placeStone)
    two-human.spec.ts                   (NEW — happy path, steps 1–15)
    two-human-decline.spec.ts           (NEW — candidate clicks No)
    two-human-dice.spec.ts              (NEW — color collision, seeded flip)
    two-human-timeout.spec.ts           (NEW — timed game, move-timeout forfeit)
just/
  justfile.e2e                          (EXTEND — add test-e2e-playwright recipe)
package.json (frontend)                 (ADD @playwright/test devDep + scripts)
```

`fixtures/seed.ts` holds the same `pg` connection + the same SQL the
Cypress `dbQuery`/`dbCleanupUsers` tasks use, so the two harnesses share
one source of truth for "what online/elo/cleanup means."

## 3. Happy-path test pseudocode (Playwright `two-human.spec.ts`)

```ts
test('two humans play a full matched game over WS', async ({ browser }) => {
  const suffix = rand();
  const p1 = await signup(`p1_${suffix}`);   // API helper, returns {username, token}
  const p2 = await signup(`p2_${suffix}`);

  // -- two real browsers, two live sockets ---------------------------------
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const a = await ctx1.newPage();   // P1 / requester / Black
  const b = await ctx2.newPage();   // P2 / candidate / White

  await seedAuth(a, p1);  await a.goto('/');   // sessionStorage token → /ws connects
  await seedAuth(b, p2);  await b.goto('/');

  // 3. presence load modal — both see a live count (>= our 2 users online)
  await expect(a.getByText(/People Online/)).toBeVisible();
  await expect(b.getByText(/People Online/)).toBeVisible();
  // both sockets are up ⇒ the count must include both; assert >= 2 (other
  // dev clients may inflate it — never assert an exact total).

  // 4. P1 requests an Elo-matched human; 004 force-hook pins P2 as opponent
  await a.getByRole('button', { name: /Elo-Matched Human/ }).click();

  // 5. ready prompts (verbatim, 005)
  await expect(a.getByText(`You matched with @${p2.username} (1500). Ready to start?`)).toBeVisible();
  await expect(b.getByText(`@${p1.username} (1500) would like to play a game with you. Say Yes?`)).toBeVisible();

  // 6. both accept
  await a.getByRole('button', { name: /^Yes$/ }).click();
  await b.getByRole('button', { name: /^Yes$/ }).click();

  // 7. color: P1 Black, P2 Don't Care ⇒ deterministic (truth-table row 3)
  await a.getByRole('button', { name: /Start The Game as Black/ }).click();
  await b.getByRole('button', { name: /Don't Care/ }).click();
  await expect(a.getByText(/rolled the dice/)).toHaveCount(0);  // no dice msg
  await expect(b.getByText(/rolled the dice/)).toHaveCount(0);

  // 8. game.start ⇒ both land on the board
  await expect(a.getByTestId('board-svg')).toBeVisible();
  await expect(b.getByTestId('board-svg')).toBeVisible();

  // 9. on-join system chat message on BOTH screens (006)
  for (const [p, peer] of [[a, p2], [b, p1]] as const)
    await expect(p.getByText(new RegExp(`System Message:.*@${peer.username}.*/like.*/boo`, 's'))).toBeVisible();

  // 10. alternating moves; assert the NON-moving client renders each stone
  //     via WS push (no reload). MOVES: X row7 c0..c4, O row8 c0..c3.
  for (const m of MOVES) {
    const mover  = m.player === 'X' ? a : b;
    const watcher= m.player === 'X' ? b : a;
    await placeStone(mover, m.row, m.col);                 // click on mover's board
    // the push must paint the stone on the watcher without any navigation:
    await expect(stoneAt(watcher, m.row, m.col)).toBeVisible();   // WS-driven
  }

  // 11-12. win + animation on BOTH screens (010)
  await expect(a.getByText(new RegExp(`@${p1.username} wins`))).toBeVisible();
  await expect(a.getByTestId('win-animation')).toBeVisible();     // celebration
  await expect(b.getByTestId('win-animation')).toBeVisible();     // lifted-5 anim

  // 13. post-game 3-2-1 countdown then chat closes (006)
  await expect(a.getByText(/Closing the chat in 3/)).toBeVisible();
  await expect(a.getByText(/1\.\.\./)).toBeVisible();
  await expect(a.getByTestId('chat-panel')).toHaveCount(0);       // unmounted

  // 14-15. DB: two games rows, cross-linked, transactional Elo
  const rows = await dbQuery(GAMES_SQL, [p1.username, p2.username]);
  expect(rows).toHaveLength(2);
  const A = byName(rows, p1.username), B = byName(rows, p2.username);
  expect(A.game_type).toBe('multiplayer');  expect(A.winner).toBe('X');
  expect(A.opp_name).toBe(p2.username);      expect(B.opp_name).toBe(p1.username);
  expect(A.elo_before).toBe(1500); expect(A.elo_after).toBe(1520);  // K=40, equal
  expect(B.elo_before).toBe(1500); expect(B.elo_after).toBe(1480);

  await ctx1.close(); await ctx2.close();
  await cleanupUsers([p1.username, p2.username]);
});
```

**Assertion discipline (anti-flake):** every cross-client check waits on a
*DOM consequence of a WS event* (`expect(...).toBeVisible()` with
auto-retry / `expect.poll`), **never** `waitForTimeout`. The only thing
the test asserts about timing is that the push *eventually* lands within
Playwright's default expect timeout. See risks §9.

### `placeStone` / `stoneAt` (board helper, `fixtures/board.ts`)

Mirror today's `cypress placeStone`: `BOARD_PX=600`, `PADDING=24`,
`cell=(600-48)/(size-1)`, click at `(PADDING+col*cell, PADDING+row*cell)`
scaled by the rendered rect. `stoneAt(page,row,col)` locates the rendered
stone — **requires a stable selector**, e.g. `[data-testid="stone-7-0"]`
or `[data-stone="X"][data-row="7"][data-col="0"]`. **This is a small new
seam on the Board component** (a per-stone testid); without it the watcher
assertion can only check turn-indicator text, which is weaker. Flagged in
the checklist as a 010/board-render dependency.

## 4. Determinism seams (exact contracts demanded of owners)

| # | Seam | Exact shape 012 will consume |
| --- | --- | --- |
| 1 | **005 color RNG** | A seam to pin the coin flip. Preferred: a test-only request header `X-Test-Rng-Seed: <int>` (or env `GOMOKU_TEST_RNG_SEED`) read by the handshake's color resolver, seeding the app-layer `random.Random` used for rows 1/5/9. Happy path avoids it (deterministic row 3); `two-human-dice.spec.ts` sets the seed and asserts the exact winner + the "rolled the dice, sorry — they won." recipient. |
| 2 | **004 force-opponent** | A test-only hook so P1's request matches P2 deterministically despite a shared DB. Preferred: header `X-Test-Match-Opponent: <username\|uuid>` honored only when `ENVIRONMENT=test`/`development`, bypassing `argmin` and selecting that candidate (still subject to the eligibility filter, so the test also proves the filter). Fallback: seed the tie-break `random.choice` via seam #1's seed **and** guarantee P2 is the unique eligible candidate (hard in a shared dev DB — hence the header is preferred). |
| 3 | **009 clock / fast-mode** | A test-only injectable clock or shortened deadlines: env `GOMOKU_TEST_FAST_TIMERS=1` (e.g. per-move 2 s, caps a few seconds) **or** a header carrying override deadlines. `two-human-timeout.spec.ts` starts a *timed* game, lets P2's per-move clock expire, and asserts forfeit-loss (winner = P1, `games` rows + Elo written, `game.timeout` pushed to both). The happy path runs **untimed** and must not race the 30-min cap — so either fast-mode shortens it or the test simply finishes well inside it (it does: 9 moves). |
| 4 | **003 presence** | No new seam; relies on 003's *snapshot-on-connect*. A client "appears online" by opening `/ws`; opening both contexts' sockets must make the count reflect ≥2 before step 3 asserts. 012 asserts `>= 2`, never an exact total (dev DB noise). |

These four are **blocking inputs** — listed again, time-ordered, in §8.

## 5. Rewrite specs for the three existing Cypress files

### `multiplayer.cy.ts` → invite-flow single-client regression (REWRITE)

- **Keep:** the invite-code flow (005 leaves it intact for modal-driven
  games), the DB assertions (two `games` rows, `opponent_id`, `winner`,
  Elo 1520/1480).
- **Change:** stop pretending it's "two browsers" for the *matched* flow —
  that moves to Playwright. This spec drives the **host-issues-code →
  guest-joins-`/play/<code>`** path with `cy.useUser` swaps (acceptable
  here: the invite flow is not push-only and a single live client per
  step is a legitimate regression of that path).
- **Asserts:** host can create an invite, guest can join via code, a full
  game persists two rows with correct Elo. (Realtime push is **not**
  asserted here — that's Playwright's job.)

### `chat-slash-commands.cy.ts` → `/like` `/boo` `/help` (REWRITE)

Delete every test for `/invite` `/follow` `/unfollow` `/block` `/woo`
`/who`. New tests (single client unless noted):

- `/help` prints a system message listing **only** `/like` and `/boo`.
- `/like @p2` → caption + a `friendships` row exists (idempotent on repeat).
- `/boo @p2` → caption + a `blocks` row exists **and** any `friendships`
  rows in either direction are gone.
- Unknown `/frobnicate` → local caption "Unknown command. Type /help for
  available commands."; **assert nothing was sent** (no new chat row).
- Free text → renders a chat bubble (and, if 002 merged, is delivered to
  the peer — that cross-client delivery is asserted in Playwright, not here).

These require an in-progress game context (chat is `in_progress`-only per
006), so the spec first stands up a game via the invite-code API helpers
(`apiNewMultiplayerGame` + join), as the old spec's `/block` test already
does.

### `multiplayer-modal-defaults.cy.ts` → redesigned modal (REWRITE)

Locks 007's redesigned modal:

- Load-time presence modal shows "[ N People Online, M Are playing ]"
  with live numbers (assert the pattern + N ≥ 1).
- Top buttons "Play with AI" and "Play with a Elo-Matched Human" present.
- The stacked long buttons exist: higher-Elo, lower-Elo, and the four AI
  modes (Easy/Intermediate/Hard/Hardest-premium).
- "Timed Game" checkbox present for human games.
- The old assertions (Another-Player radio pre-checked, auto invite link
  in the modal, "Got an invitation?" paste row) are **dropped** unless 007
  keeps that surface — reconcile against 007's final `plan.md` before
  writing. (Flag: this spec's exact selectors are owned jointly with 007.)

## 6. DB seeding & "appearing online"

- **Elo:** registration defaults `elo_rating = 1500` (004 audit confirms
  the column default). Happy path needs no seed — both users start at
  1500, so the deltas are the known 1520/1480. A *skewed-Elo* matchmaking
  test (above/below modes) seeds specific ratings via
  `UPDATE users SET elo_rating=$1 WHERE username=$2`.
- **Blocks/friendships:** seed/cleanup via SQL (same `pg` pool as Cypress).
- **Online presence is in-memory (003).** A row in a table does **not**
  make a user online; only a **live `/ws` socket** does. So a Playwright
  client "appears online" purely by `goto('/')` opening its socket — there
  is no DB seed for presence. This is *why* two real contexts are
  necessary: the only way to make P2 online for matchmaking is to actually
  have P2's browser connected. (A `cy.task` fake client would have to open
  a raw socket to count — option A's hidden cost.)
- **Cleanup:** reuse the `dbCleanupUsers` SQL (delete `games`,
  `multiplayer_games`, then `users` for the scratch usernames). Add
  `friendships` / `blocks` / `chat_messages` cleanup for the chat specs.

## 7. just / CI changes

`just/justfile.e2e` gains a Playwright entry point alongside `e2e`:

```just
# Two-human realtime e2e via Playwright (restarts cluster, runs the dual-UI suite)
test-e2e-playwright:
    export SECRET="$(cat .secret)"; \
    bin/gctl stop || true; \
    bin/gctl start -r || exit $?; \
    cd frontend && npx playwright test --config e2e-pw/playwright.config.ts
```

- `frontend/package.json`: add `@playwright/test` devDep, scripts
  `"e2e:pw": "playwright test --config e2e-pw/playwright.config.ts"` and
  `"e2e:pw:install": "playwright install --with-deps chromium"`.
- `just ci` (justfile:53 `ci: check test-all test-rust-integration e2e`)
  gains `test-e2e-playwright` **after** `e2e`. **013 owns** folding this
  into the final deploy gate; 012 only adds the recipe.
- CI workflow: add a `playwright install --with-deps chromium` step before
  the Playwright recipe (Chromium download). Reuse the same Postgres
  service + `bin/gctl` the cypress job already uses — one cluster, both
  harnesses, to keep CI time down.

## 8. Dependency-ordered checklist

Each e2e assertion only goes green once its upstream feature **and its
determinism seam** land. Build the harness scaffold first; enable
assertions as features merge.

1. **[002 merged]** Playwright scaffold + `two-human.spec.ts` up to step
   10's "watcher sees the move via WS push." This is the keystone
   assertion — it cannot pass before 002.
1. **[003 merged]** Enable step 3 (presence load-modal count ≥ 2).
1. **[004 merged + force-opponent seam #2]** Enable step 4–5
   (matchmaker picks P2; ready prompts). Without seam #2, flaky on a
   shared DB → keep skipped.
1. **[005 merged + RNG seam #1]** Enable steps 6–8 (Yes/Yes, color
   buttons, deterministic assignment, `game.start`) and the
   `two-human-dice.spec.ts` collision test.
1. **[006 merged]** Enable steps 9 & 13 (on-join system message, 3-2-1
   countdown) and rewrite `chat-slash-commands.cy.ts`.
1. **[007 merged]** Rewrite `multiplayer-modal-defaults.cy.ts`; finalize
   the step-4 button selector.
1. **[010 merged + per-stone testid]** Enable step 12 (win animation on
   both) and step 10's `stoneAt` selector. If 010 doesn't add a per-stone
   testid, file it as a tiny board-render seam.
1. **[009 merged + clock seam #3]** Enable `two-human-timeout.spec.ts`.
1. **[008 merged]** (optional) add a `no_candidates → try AI?` Cypress
   spec — not on the human happy path.
1. **[all green]** Hand the green suite to **013** for the final
   `just ci` deploy gate.

## 9. Risks & mitigations

- **Flaky realtime timing.** Mitigation: assert on WS-driven DOM with
  auto-retrying `expect` / `expect.poll`; **zero** `waitForTimeout`. Bump
  Playwright's `expect` timeout (e.g. 10 s) to absorb cluster cold-start,
  not to paper over a missing push.
- **Shared dev DB noise** (other online clients inflate presence /
  pollute matchmaking). Mitigation: assert presence `>= N`, never `==`;
  use the 004 force-opponent header so selection is independent of pool
  contents; unique randomized usernames per run + cleanup in `finally`.
- **Two harnesses drift.** Mitigation: share the board-coordinate math and
  the SQL between Cypress and Playwright via `fixtures/`; keep one
  cluster-start path (`bin/gctl start -r`).
- **Playwright in CI weight** (browser download). Mitigation: cache the
  Playwright browser; install only chromium; if it ever becomes a CI
  bottleneck, fall back to harness option A (documented in spec).
- **`stoneAt` selector instability.** Mitigation: require a per-stone
  testid from the board (small ask); until then, fall back to asserting
  the turn-indicator flip on the watcher (weaker but non-flaky).

## 10. Cross-cutting suites that must stay green (handed to 013's gate)

The feature work touches every layer; 012's "green suite" and 013's final
gate run all of:

- **pytest** (`just test-api`, 5 xdist workers, per-worker DB) — WS
  endpoint (002), presence (003), matchmaking + transactional Elo (004),
  handshake state machine + color truth table + seeded dice (005), chat
  endpoint deletions (006), timer scheduler + forfeit (009).
- **vitest** (`just test-frontend`) — `useGameSocket` hook (002),
  `usePresence` (003), redesigned modal components (007), `ChatPanel`
  `/like` `/boo` + countdown (006), win-animation component (010).
- **Rust** (`just test-rust`, `just test-rust-integration`) — AI daemon
  (008/011); unaffected by multiplayer but must stay green.
- **C engine** (`just test-gomoku-c`) — win detection / move legality
  the whole flow rests on; unaffected but gated.
- **schema-validator** (`just test-validate-games`) — stored-game JSON.
- **Cypress** (`just e2e`) + **Playwright** (`just test-e2e-playwright`).

013 owns running these as the single deploy gate; 012 owns making the e2e
two-human portion exist and pass.

______________________________________________________________________

## Verifier notes (Jeff Dean)

- **"Both clients see each move" is the load-bearing assertion** the old
  harness can't make; it must wait on the watcher's DOM, never on the
  mover's POST returning. The pseudocode does this — guard it in review so
  nobody "optimizes" it into a reload.
- **Presence exact-count is a trap.** A shared dev/CI DB will have other
  sockets. Only `>=` is safe. Encoded in §9; do not regress to `==`.
- **The 30-min untimed cap can't fire mid-test** (9 moves finish in
  seconds), but a *timed* happy path would race the 5-min/15-s clocks —
  that's exactly why the happy path is **untimed** and timeouts get their
  own fast-clock spec. Don't merge them.
- **Force-opponent header must be env-gated** (`test`/`development` only)
  or it's a production matchmaking-bypass vuln. Same for the RNG-seed and
  fast-timer seams — all three must be inert in production. Make 004/005/009
  assert that in their own pytest.
- **Color truth-table coverage:** the happy path only exercises row 3
  (deterministic). Ensure `two-human-dice.spec.ts` (seeded) covers a
  conflict row (1 or 5) *and* the silent double-don't-care (9), or the
  seed seam goes untested e2e.
- **Cleanup must be in a `finally` / `test.afterEach`**, not trailing
  statements — a mid-test failure otherwise leaks scratch users and
  poisons reruns (the current Cypress `after()` already does this; mirror
  it in Playwright).
- **Reconnect/resync (002 R8) is unasserted** by the happy path. Consider
  a small Playwright spec that drops P2's socket mid-game and asserts the
  GET-resync repaints the board — otherwise a whole 002 guarantee ships
  e2e-uncovered. Flagged **OPEN**.

______________________________________________________________________

**ASSUMPTION:** the local cluster (`bin/gctl start -r`) serves the frontend
and the API such that one Postgres dev DB backs both harnesses, and the
Vite/nginx origin Playwright hits is the same `CYPRESS_BASE_URL` Cypress
uses. If `gctl` can't host two harnesses against one DB cleanly, Playwright
gets its own `gctl` invocation in its recipe (already the case — each
recipe restarts the cluster).

**ASSUMPTION:** 010 (or the board component) exposes a per-stone testid so
`stoneAt(watcher,row,col)` is assertable; if not, 012 files that as a tiny
seam, falling back to turn-indicator assertions meanwhile.

**OPEN:** Should the two-human realtime suite live under `frontend/e2e-pw/`
(co-located, shares `pg`/node deps) or a top-level `e2e/` dir (harness-
neutral)? Defaulting to `frontend/e2e-pw/` for dependency reuse; revisit if
013 wants it cluster-level.

**OPEN:** Do we add the 002 reconnect-resync e2e spec now (Jeff's note) or
defer to 013's hardening pass? Leaning: add a minimal one here since the
two-context harness makes it nearly free.

**OPEN:** Exact seam *form* for 004/005/009 (request header vs. env var) is
proposed, not mandated — the owners pick, but 012 needs *some* deterministic
hook, env-gated to non-production. Confirm with each owner during their
build.
