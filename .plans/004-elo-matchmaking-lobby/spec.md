# 004 — Elo Matchmaking & Lobby

Slice of the umbrella spec
[`001-clarification-simplification/spec.md`](../001-clarification-simplification/spec.md)
that owns **how a human is matched to another human by Elo rating**, and the
guarantee that Elo is awarded fairly and transactionally on every completed
game.

This feature produces the *candidate-selection brain*. It does **not** own the
WebSocket transport (002), the realtime presence set (003), the
Ready?/colour/dice handshake (005), the AI difficulty tiers (008), or the modal
chrome (007). It defines the *contracts* those slices consume.

______________________________________________________________________

## Goal

Given a logged-in human who clicks one of the "play a human" buttons, pick the
single best opponent according to a requested Elo mode, restricted to people who
are actually available and allowed, and hand a match proposal to the handshake
layer (005). When nobody is eligible, emit the "no humans, try AI?" branch that
hands off to the AI flow (008).

## Matchmaking modes & exact selection semantics

The requester sends a mode. Let `me` be the requester's `elo_rating` and `E` be
the eligible candidate pool (see *Pool-filtering rules*). Each candidate has an
integer `elo_rating`.

| Mode | UI trigger (001) | Selection rule |
| ---------- | ------------------------------------------------------- | ------------------------------------------------------------------- |
| `closest` | "play an Elo-matched human" (top modal button) | `argmin` over `E` of `abs(c.elo - me)` |
| `above` | "play another human with a **higher** Elo score than me" | `argmin` over `{c ∈ E : c.elo > me}` of `(c.elo - me)` (closest above) |
| `below` | "play another human with a **lower** Elo score than me" | `argmax` over `{c ∈ E : c.elo < me}` of `(c.elo)` (closest below) |

001 also names "Random Unoccupied Online Player Just Above/Below my level." We
treat *"just above"* and *"higher than me"* as the same mode (`above`), and
likewise *"just below"* (`below`). "Just" is satisfied by *closest*, not *any* —
picking the nearest neighbour above/below is the least-surprising reading and
keeps games competitive.

**Tie-break:** when two or more candidates are equidistant (for `closest`) or
share the boundary Elo (for `above`/`below`), pick **one uniformly at random**.
Randomness lives in the application layer (Python `random.choice` over the tied
rows), never in SQL `ORDER BY random()`, so it is seedable in tests.

**Empty sub-pool:** if `above` has no candidate strictly above `me` (or `below`
none strictly below), that mode yields *no candidate* and falls through to the
no-candidates UX below — it does **not** silently fall back to `closest`.

## Pool-filtering rules

A user `c` is **eligible** for requester `me` iff **all** hold:

1. `c.id <> me.id` — not yourself.
1. `c` is **online** — present in the realtime online set 003 publishes (and,
   as a DB backstop, within the presence window of the `online_users` view).
1. `c` is **not playing** — 003's per-user `in_game` flag is false, equivalently
   the `online_users.state <> 'human-battle'` (and not mid-AI-battle). A waiting
   multiplayer room counts as occupied.
1. `c` did **not** block `me`, **and** `me` did **not** block `c` —
   **both directions excluded.** *Recommended and adopted.* The umbrella spec
   only literally requires "minus all the ones this user blocked" (one
   direction). We exclude both because a one-directional rule lets a blocked
   griefer still be matched *into* their target's game, defeating the block. The
   existing `/social/who` endpoint already excludes both directions; we stay
   consistent. **OPEN** flagged in plan in case product wants strictly the
   literal reading.

Friendship has **no** effect on eligibility for matchmaking — friends and
strangers are equally matchable.

## No-candidates UX

When the eligible pool is empty (nobody online, or everyone online is blocked /
playing / on the wrong side of the Elo boundary for the chosen mode), the
matchmaker emits a `no_candidates` outcome. The frontend renders:

> "No available human players are currently available. Would you like to try the
> AI?"

with a Yes / No choice. On **Yes**, the frontend shows the four AI-mode buttons
(Easy / Intermediate / Hard / Hardest), which are owned by 008. 004 owns only
the *trigger* — emitting `no_candidates` and the boolean fork — not the
difficulty buttons themselves.

## Start-at-1500 + transactional-Elo requirements

- **Everyone starts at Elo 1500.** Enforced by the `users.elo_rating INTEGER NOT NULL DEFAULT 1500` column (migration 0008) and registration *not* overriding
  it. **Verified present** — see plan. `elo_peak` also defaults 1500.
- **Elo on completion is one transaction.** When a human-vs-human game finishes,
  both players' rating change (subtract from the loser, add to the winner; both
  unchanged-magnitude on draw per K) plus both audit `games` rows must commit
  **atomically** — never leave one player's rating updated while the other's
  is not. **Verified present** — `_write_finished_games_rows()` already runs
  inside the caller's `conn.transaction()`. 004 documents and locks this
  invariant with a regression test; no code change expected (see plan audit).

## Dependencies

- **002 — WebSocket transport.** Matchmaking requests arrive and proposals leave
  over the WS channel 002 establishes. 004 defines message shapes; 002 carries
  them.
- **003 — Presence & online counts.** 004 consumes 003's *online user-id set*
  and per-user *in-game* status to build the candidate pool. Without 003,
  matchmaking can only see the DB-derived `online_users` view (staler).

## Hand-off contract to 005

On a successful selection, 004 produces a **match proposal** and hands it to 005
(Ready?/colour/dice). 005 owns delivery to both clients, the Ready confirmation,
the colour negotiation, and creating the `multiplayer_games` row. The proposal
payload:

```json
{
  "type": "match_proposed",
  "requester":      { "user_id": "<uuid>", "username": "bob",  "elo": 1534 },
  "candidate":      { "user_id": "<uuid>", "username": "john", "elo": 1453 },
  "mode":           "closest",
  "requester_elo":  1534,
  "candidate_elo":  1453
}
```

(`requester_elo` / `candidate_elo` are duplicated top-level for 005's
convenience messages — "You matched with @john (1453)" / "@bob (1534) would like
to play.") 005 must re-validate the candidate is still available at delivery
time (the *select→handshake race*, see plan edge cases).

## Consumers

- **005** consumes the match proposal.
- **007** consumes the `no_candidates` outcome to render the AI-fallback prompt
  and the three lobby buttons' wiring (behaviour defined here, layout there).
- **008** consumes the AI-fallback "Yes" trigger.
- **010** (win animation / Elo celebration) and **012** (Cypress e2e) consume the
  transactional-Elo guarantee this slice locks down.

## Non-goals

WS framing (002), presence counting (003), Ready/colour/dice (005), AI tiers
(008), modal layout (007), timed-game rules (009).
