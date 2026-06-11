# 012 — True two-human e2e + green suite

> Slice of the umbrella spec
> ([`.plans/001-clarification-simplification/spec.md`](../001-clarification-simplification/spec.md)).
> This feature owns the **end-to-end test strategy** for the realtime
> human-vs-human flow that 002–010 build, plus the guarantee that the
> whole repository test suite is green. It implements **none** of the
> product features 002–011 — it asserts them.

## Goal

Two humans actually play a complete multiplayer game through the **new**
realtime flow, observed from **two live, concurrently-connected clients**
exchanging WebSocket pushes, and every existing test suite stays green.

The acceptance bar, in the user's words, is:

> "all of the tests are passing and the new e2e Cypress tests are written
> and are able to play a game pretending to be humans."

Concretely, one e2e test must drive the full chain end to end:

```
two users online (presence)
  → user1 clicks Elo-Matched / above / below
  → matchmaker selects user2
  → both see "Ready to start?"  → both accept
  → both pick a color  → server resolves color (seeded RNG)
  → game.start pushed to both
  → alternating moves over WS (BOTH clients render each move)
  → five-in-a-row → win
  → win animation visible on both screens
  → two `games` rows persisted + Elo updated transactionally
  → chat system message on join + post-game 3-2-1 countdown
```

A move made in browser A must become **visible in browser B without B
re-fetching or reloading** — that is the property the swap-the-JWT
Cypress test (`multiplayer.cy.ts`) structurally cannot assert today,
because it never has two clients connected at once.

## Why the current harness is insufficient

`frontend/cypress/e2e/multiplayer.cy.ts` simulates "two browsers" with
`cy.useUser()`: it clears storage, writes the *other* user's JWT, and
`cy.visit()`s again. At any instant exactly **one** client exists.
Between every move it tears the first client down and stands the second
up, then relies on the *polling* hook to have fetched the latest state on
the fresh page load. This:

- never has two sockets open simultaneously, so it **cannot** prove a
  `game.update` / `chat.message` was *pushed* to a second live client;
- cannot exercise the matchmaking → ready → color handshake at all (it
  uses the invite-code flow, which 005 explicitly leaves intact but which
  is *not* the new matched flow);
- cannot observe a win animation "on both screens" since only one screen
  is ever mounted.

The new flow is push-driven and two-party. The harness must hold two
clients live at once.

## Harness decision (A / B / C)

| Option | Mechanism | Verdict |
| --- | --- | --- |
| **A** | Keep Cypress; "second human" is a Node-side fake WS client driven from `cy.task()` (connects `/ws`, accepts the match, picks color, POSTs moves), while the real browser is human #1. | Pragmatic, exercises server + one real UI. **Not** two real UIs. |
| **B** | Cypress `cy.origin` / multiple tabs. | Rejected. Cypress is single-tab-per-test by design; it does not support two concurrent interactive tabs/pages. A non-starter for "both clients see each move". |
| **C** | Introduce **Playwright** for the two-human realtime test (two `BrowserContext`s = two real UIs in one test), keep Cypress for everything else. User explicitly OK'd Playwright + `bin/gctl`. | **RECOMMENDED.** |

### Recommendation: **C (Playwright) for the dual-UI human test; A as fallback**

The user said the test must "play a game **pretending to be humans**." A
Node fake-client that opens a raw socket and POSTs moves is *pretending to
be a server client*, not a human — it never renders the ready prompt,
never clicks "Start The Game as Black", never sees the win animation. It
proves the **server** fans out correctly but proves nothing about the
**second human's UI**. The umbrella spec's headline deliverables on this
flow are UI behaviours: the ready/color buttons (005), the on-join system
chat message and 3-2-1 countdown (006), and the win animation that "lifts
the winning 5 stones off the table" (010). Asserting those on *both*
screens requires two real browsers.

Playwright is the only one of the three that gives two real, concurrently
live browser UIs in a single test, with first-class `expect.poll` /
auto-waiting on DOM that maps cleanly onto "wait for the WS push to land,
then assert". The user OK'd it. So:

- **Playwright owns the one true two-human happy-path test** (and its
  close cousins: decline, color-collision dice, move-timeout forfeit).
- **Cypress stays** the harness for everything single-client: the
  redesigned modal (007), presence numbers on load (003), the
  rewritten `/like` `/boo` chat (006), and single-screen regressions.
- **Option A is the documented fallback** if Playwright proves flaky or
  too heavy in CI: collapse the two-human test to "one real browser +
  one `cy.task` fake client", accepting that the second human's *UI*
  (ready prompt, win animation) then goes unasserted and is covered only
  by component/vitest tests. We do **not** start here — we start with C.

## Happy-path scenario mapped to flow stages

Two contexts: **P1** (requester, will be Black/X and win) and **P2**
(candidate, White/O). Both authenticate, both open their lobby socket.

| # | Step | Flow stage / owner | Key assertion |
| --- | --- | --- | --- |
| 1 | Seed P1, P2 via `/auth/signup`; both Elo = 1500. | setup | two users exist |
| 2 | Both navigate to `/`; both `/ws` sockets connect. | 002 | both contexts authenticated, sockets open |
| 3 | Both see the load modal "[ N online, M playing ]"; N reflects 2 of *our* users online. | 003 | `presence.snapshot` rendered with live (not zero) count on both |
| 4 | P1 clicks "Play an Elo-Matched Human" (mode `closest`). | 004 | matchmaker picks P2 (forced — see determinism) |
| 5 | P1 sees "You matched with @p2 (1500). Ready to start?"; P2 sees "@p1 (1500) would like to play a game with you. Say Yes?" | 004→005 | both prompts visible, verbatim strings |
| 6 | Both click **Yes**. | 005 | handshake → both_accepted |
| 7 | Both see the three color buttons; P1 clicks "Start The Game as Black", P2 clicks "Don't Care". | 005 | deterministic assignment (row 3 of truth table) → P1=Black/X, P2=White/O; **no** dice message |
| 8 | Server creates `multiplayer_games` row `in_progress`, pushes `game.start` to both. | 005 | both contexts land in the in-game board layout; board visible on both |
| 9 | Chat panel shows the on-join system message naming the peer, on **both** screens. | 006 | "System Message: you can chat here with your opponent @\<peer>… /like… /boo…" visible in both contexts |
| 10 | Alternating moves: P1 plays (7,0); **assert P2's board renders that stone via WS push** (P2 never reloads). P2 plays (8,0); **assert P1's board renders it.** Repeat through P1's winning fifth stone at (7,4). | 002 push + move POST | after each move, the **non-moving** client's board shows the new stone within a WS-event wait (not a fixed sleep) |
| 11 | P1 completes five-in-a-row on row 7. | runtime | game state → `won`, winner `X` |
| 12 | Win animation plays on **both** screens (winning 5 stones lift/shine); P1 sees the celebration. | 010 | animation element present on both contexts |
| 13 | Post-game chat countdown "Great game you two! Closing the chat in 3…2…1…" plays, then the panel closes. | 006 | countdown text mutates 3→2→1 then panel gone on both |
| 14 | DB: exactly two `games` rows (one per user), cross-linked `opponent_id`, `game_type='multiplayer'`, `winner='X'`. | 004 audit | 2 rows, correct winner/colors |
| 15 | Elo asserted transactionally: equal opponents, K=40 → winner 1500→1520, loser 1500→1480; `elo_before/after/opponent_elo_before` correct on both rows. | 004 transactional-Elo | exact Elo deltas, both rows committed together |

The Elo numbers here mirror the values already asserted in today's
`multiplayer.cy.ts` (1500 → 1520 / 1480, K=40), so the arithmetic is a
known quantity — only the *delivery path* (matched flow over WS) changes.

## Determinism requirements imposed on other tasks

The e2e test cannot be reliable unless the features it drives expose
**test-only seams** that make their randomness and timing deterministic.
These are **requirements 012 levies on the owning tasks** — they must be
built into 004/005/009 (and surfaced by 002/003), not bolted on later.

| Seam | Owner | What 012 needs |
| --- | --- | --- |
| **Seedable color/dice RNG** | **005** | A way to pin the coin-flip outcome (color-collision rows 1/5/9 of the truth table) so the test asserts exact color assignment and exact dice-loss recipient. The happy path uses a *deterministic* row (P1 black, P2 don't-care) to avoid the RNG entirely; a separate test needs the seed to force a known flip. Injectable via env var or a test-only request header, app-layer `random` (the spec already forbids SQL `ORDER BY random()`). |
| **Force-opponent matchmaking hook** | **004** | A test-only way to make the matchmaker pick a *specific* user id rather than `argmin`-over-pool, so two scratch users in a shared dev DB (with other online users present) reliably match each other. Either a seedable tie-break `random.choice` **plus** a constrained pool, or an explicit `X-Test-Match-Opponent` header / env allow-list. Without it the test is non-deterministic the moment a third client is online. |
| **Injectable clock / fast-mode timers** | **009** | A test-only fast clock (or shortened deadlines) so the move-timeout (15 s) and whole-game caps (5 min / 30 min) can be exercised in seconds, and so the happy path's *untimed* game does not race a real 30-minute timer. The happy-path test runs an **untimed** game (no per-move clock) to stay simple; a dedicated timeout test needs the injectable clock to fire a forfeit-loss deterministically. |
| **Deterministic presence** | **003** | "Online" must mean "has a live socket." For the test, a client "appears online" simply by opening its `/ws` socket; the count must reflect that synchronously enough that step 3 can assert it. No extra seam beyond 002/003 as specced, but 012 depends on the *snapshot-on-connect* guarantee (003 R: "a just-connected client receives current numbers immediately"). |

If any owner ships its feature **without** its seam, the corresponding
e2e assertion is blocked (see the dependency-ordered checklist in
`plan.md`).

## Existing-test fate table

| File | Fate | Why |
| --- | --- | --- |
| `frontend/cypress/e2e/multiplayer.cy.ts` | **Rewrite** | The JWT-swap "two browsers" simulation cannot test the push flow. Becomes a Cypress single-client regression that drives the **invite-code** flow (which 005 keeps) end to end — the *matched* flow's two-human test moves to Playwright. Keeps the DB/Elo assertions; drops the per-move `useUser` swap. |
| `frontend/cypress/e2e/chat-slash-commands.cy.ts` | **Rewrite** | Old commands `/invite` `/follow` `/unfollow` `/block` `/help`-with-old-list are deleted by 006. Rewrite to the new set: `/like`, `/boo`, `/help` (lists only those two), unknown-command rejection, free-text bubble. Assert both the caption and the `friendships` / `blocks` DB rows. |
| `frontend/cypress/e2e/multiplayer-modal-defaults.cy.ts` | **Rewrite** | The modal is redesigned by 007 (load-time presence modal, AI vs Elo-Matched buttons, the stacked above/below/AI buttons, Timed-Game checkbox). The old "Another Player pre-selected + auto invite link" assertions no longer describe the UI. Rewrite to lock the new modal's defaults and the presence numbers. |
| Playwright `two-human.spec.ts` | **New** | The one true dual-UI realtime happy path (steps 1–15 above) + decline + color-collision + move-timeout variants. |
| `cypress/support/commands.ts` | **Extend** | Add helpers the rewritten Cypress specs need (see plan); the `useUser` swap helper stays for the single-client invite-flow regression. |
| Playwright support (new) | **New** | Two-context auth + socket helpers, board-click helper, DB seed/cleanup tasks (shared SQL with Cypress). |

## Dependencies

012 is the **integration consumer** of the whole umbrella. It depends on:

- **002** WebSocket transport — the push the test asserts.
- **003** presence — the load-modal numbers (step 3).
- **004** matchmaking — selection + the force-opponent seam + transactional Elo.
- **005** ready/color handshake — the seedable-RNG seam + the verbatim prompts.
- **006** chat simplification — `/like` `/boo`, on-join system message, 3-2-1 countdown.
- **007** modal redesign — the buttons/checkbox the test clicks.
- **008** AI difficulty — only for the `no_candidates → try AI?` branch (not the human happy path).
- **009** timed games — the injectable-clock seam for the timeout variant.
- **010** win animation / Elo celebration — the animation the test asserts on both screens.

012 is also the **penultimate acceptance gate**: the green-suite guarantee
here runs alongside **013 — integration hardening & deploy**, which owns
the final cross-component gate (`just ci`: pytest + vitest + Rust + C +
cypress + the new Playwright recipe) before deploy. 012 owns the e2e
*strategy and scenarios*; 013 owns wiring them into the deploy gate and
the final green-on-`main` sign-off.

## Non-goals

- Implementing 002–011. 012 only tests them.
- New product behaviour, schema, or wire formats.
- Load/performance testing of the socket.
- Cross-instance / multi-replica realtime (single-instance assumption,
  inherited from 002/003).
- Owning the deploy gate — that's 013.
