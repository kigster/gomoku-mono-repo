# 005 — Match Ready + Color Negotiation Handshake

> Slice of the umbrella spec
> (`.plans/001-clarification-simplification/spec.md`, points 3–4 under
> "Play with AI | Play with one of the N Available Random Humans"). This
> feature owns **everything between** "matchmaking picked a candidate"
> (004) and "the first move is made" (game runtime over 002).

## Goal

When a human asks to be matched with another human, 004 selects the
closest non-playing opponent by Elo and hands 005 a proposal. 005 then
runs a two-party, WebSocket-driven handshake:

1. Both players are asked "Ready to start?" (worded differently for the
   requester vs. the candidate).
1. If **both** accept, both pick a color preference
   (`black` / `white` / `dontcare`).
1. 005 resolves the two preferences into a concrete assignment
   (deterministic where one assignment fits, a coin-flip where they
   collide or both said "don't care"), creates the `multiplayer_games`
   row **in `in_progress` state with both player ids set**, and pushes
   `game.start` to both clients with the game JSON and each player's
   color.

From that point the game runs entirely over 002's `game.update` channel;
moves still go over the existing `POST /multiplayer/{code}/move` HTTP
endpoint (point 21 of the umbrella spec). 005 does **not** touch the
6-char invite/code flow — that path (host hands out a URL, guest joins)
stays for the modal-driven games and is untouched here.

Black plays **X** and moves first (matches the C engine and the existing
`next_to_move` default of `'X'`).

## Non-goals (owned elsewhere)

| Concern | Owner |
| --- | --- |
| WS transport, envelope, per-user broadcast, reconnection | 002 |
| Candidate selection / Elo proximity / re-offer loop | 004 |
| Modal & lobby visuals, the "53 online / 23 playing" header | 007 |
| In-game move/draw timers, 15-min cap, expiry | 009 |
| In-game `/like` `/boo` chat | 006 |
| Two-human Cypress e2e harness | 012 |

005 owns: the handshake state machine, the color-resolution truth table,
and the creation of a `multiplayer_games` row **from a match** (reusing
the existing allocate/join code).

## Dependencies

- **002 — WebSocket transport.** Provides the duplex WS connection, the
  envelope `{type, payload, v}`, a per-user delivery primitive (send a
  frame to one authenticated user id), and the reserved `match.*` /
  `game.*` type namespaces. 005 defines the concrete `match.*` frame
  shapes and `game.start`; 002 owns the wire.
- **004 — Elo matchmaking lobby.** Calls into 005 with a proposal
  `{requester, candidate, requester_elo, candidate_elo}` (user ids +
  current Elo). 005 emits `declined` / `expired` outcomes back to 004 so
  004 can decide whether to re-offer; the re-offer loop itself is 004's.

## User-facing message strings (verbatim)

Variables: `@{candidate_username}`, `@{requester_username}`, and the Elo
rating in parentheses, e.g. `(1453)`.

### Step 1 — "Ready to Start?"

**Requester sees:**

```
You matched with @john (1453). Ready to start?
```

**Candidate sees:**

```
@bob (1534) would like to play a game with you. Say Yes?
```

Both have a **Yes** and a **No** button. (No / decline copy is owned by
007; 005 only defines the prompt strings and the button semantics.)

### Step 2 — color preference (shown to both after both accept)

Three small buttons in the same small window, in this order:

```
[ Start The Game as Black ]   [ Start The Game As White ]   [ Don't Care ]
```

(Button labels verbatim. "Black" maps to `X` and moves first; "White"
maps to `O`.)

### Step 3 — dice-loss message

Shown **only** to the player who wanted a color and lost the coin flip
for it (both wanted the same color):

```
We rolled the dice, sorry — they won.
```

> The umbrella spec phrases it as "rolled the dice, sorry they won". The
> verbatim string above normalizes the grammar; **OPEN** for the user to
> override the exact wording — see `plan.md`.

No dice message is shown when the assignment was deterministic, nor to
the **winner** of a coin flip, nor to either player when both said "don't
care" (the random pick is invisible in that case).

## Handshake states

```
proposal_sent
  → (both Yes)         both_accepted
  → (either No / TTL)  declined / expired   → terminal, notify 004 + peer

both_accepted
  → (both color prefs) color_resolved

color_resolved
  → (row created)      game_created

game_created
  → (game.start ×2)    handed_off          → terminal, runtime takes over
```

The handshake is a short-lived, **in-memory** server-side object keyed by
a `match_id` (a UUID minted when 004 calls in). It is **not** persisted —
only the resulting `multiplayer_games` row is. A handshake that never
reaches `game_created` leaves no DB trace.

## Color-resolution truth table (all 9 combinations)

`R` = requester preference, `C` = candidate preference. `B` = black/`X`
(moves first), `W` = white/`O`. "dice" = seeded coin flip (testable, see
`plan.md`). The dice-loss message goes to exactly the player named.

| # | R | C | Requester gets | Candidate gets | Method | Dice-loss msg to |
| - | --- | --- | --- | --- | --- | --- |
| 1 | black | black | dice | dice | coin flip (both want B) | the loser of the flip |
| 2 | black | white | **black (X)** | **white (O)** | deterministic | — |
| 3 | black | dontcare | **black (X)** | white (O) | deterministic | — |
| 4 | white | black | **white (O)** | **black (X)** | deterministic | — |
| 5 | white | white | dice | dice | coin flip (both want W) | the loser of the flip |
| 6 | white | dontcare | **white (O)** | black (X) | deterministic | — |
| 7 | dontcare | black | white (O) | **black (X)** | deterministic | — |
| 8 | dontcare | white | black (X) | **white (O)** | deterministic | — |
| 9 | dontcare | dontcare | dice | dice | coin flip (no preference) | — (silent) |

Reading of the umbrella rule:

- **Exactly one assignment satisfies both stated preferences** (rows
  2, 3, 4, 6, 7, 8) → use it. There is never a case where "more than one
  assignment satisfies and we must pick at random" *unless* at least one
  side said "don't care" against a definite color — and even then the
  definite side pins the outcome, so it stays deterministic. The only
  genuinely random rows are the conflicts (1, 5) and the
  double-don't-care (9).
- **Both want the same color** (rows 1, 5) → coin flip; the loser gets
  the dice-loss message.
- **Both don't care** (row 9) → coin flip, but neither asked for a color,
  so no dice-loss message is shown.

After resolution, whoever ends up **black** is the host with
`host_color = 'X'`, the other is `host_color`'s opposite — see the
game-creation note below.

## Decline / timeout / offline behavior

| Event | Outcome | Who is told | Signal to 004 |
| --- | --- | --- | --- |
| Candidate clicks **No** | handshake → `declined` | requester gets `match.declined` (reason `declined`) | `declined` |
| Requester clicks **No** (cancels) | handshake → `declined` | candidate gets `match.declined` (reason `cancelled`) | `cancelled` |
| Either side doesn't answer "Ready?" before TTL | handshake → `expired` | the *other* side gets `match.expired` | `expired` |
| Either side doesn't pick a color before TTL | handshake → `expired` | the *other* side gets `match.expired` | `expired` |
| Candidate WS disconnects mid-handshake | treated as a **decline** | requester gets `match.declined` (reason `peer_offline`) | `declined` |
| Requester WS disconnects mid-handshake | treated as a **cancel** | candidate gets `match.declined` (reason `peer_offline`) | `cancelled` |

In every terminal-without-game case 005 emits the outcome back to 004,
which decides whether to re-offer the requester a fresh candidate. 005
never re-offers on its own.

## Hand-off to game runtime

On `game_created`, 005 pushes `game.start` to both users. The payload is
the full game view (the same shape `MultiplayerGameView` produces today)
plus the recipient's own color. From there:

- **Moves & board updates:** 002's `game.update` channel carries the
  authoritative game JSON after each move; the move write stays on
  `POST /multiplayer/{code}/move`.
- **Timers:** 009 reads the `game.start` payload and the match flag to
  decide whether the game is timed; 005 carries no timer logic. (The
  "Timed Game" checkbox is a lobby concern; if 004/007 set it, it rides
  on the proposal and 005 passes it through to game creation untouched.)
- **Chat:** 006's `/like` `/boo` panel activates on the `in_progress`
  transition, exactly as it does for invite-flow games — the
  `multiplayer_games` row 005 creates already has its paired `chats` row
  (created by `allocate_game`), so 006 needs no special-casing.

## Quality bar

- The handshake must be race-safe: simultaneous "Yes" from both sides,
  double color-pick, and a decline arriving after the peer already
  resolved must all resolve to a single deterministic terminal state.
- Randomness must be **seedable/injectable** so pytest and Cypress can
  assert exact color assignments and exact dice-loss recipients.
- No new persisted state beyond the existing `multiplayer_games` row. A
  game born from a match must be indistinguishable, at the data layer,
  from one born via the invite flow (same columns, same `created_via`
  semantics extended — see `plan.md`).
