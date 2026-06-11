# 004 — Elo Matchmaking & Lobby — Plan

Derived from [`spec.md`](./spec.md). Owns candidate selection, the matchmaking
endpoint/message, the proposal contract to 005, and the Elo-transaction +
1500-default audit. WS transport (002), presence (003), handshake (005), AI
tiers (008) are out of scope and consumed as contracts.

______________________________________________________________________

## 1. Architecture

```
client ──(WS: matchmaking.request)──▶ 002 WS hub
                                        │  routes "matchmaking.*" frames
                                        ▼
                              app/matchmaking/service.py   ◀── 004 OWNS
                                        │ select_candidate(requester, mode)
                       ┌────────────────┼─────────────────────┐
                       ▼                ▼                     ▼
            003 presence set    app/matchmaking/db.py    app/elo.py (read-only)
          (online ∩ in_game)    eligible-pool SQL
                       │                │
                       └──────┬─────────┘
                              ▼
                  candidate | no_candidates
                   │              │
                   ▼              ▼
       match_proposed ──▶ 005   "try AI?" ──▶ 007 ──(yes)──▶ 008
```

### Transport decision: thin HTTP vs WS — **recommend WS, justify**

**Recommendation: matchmaking is a WS message, not an HTTP endpoint.** The
umbrella spec (001) mandates the socket stay open lobby-side precisely so a user
can *receive an invitation and pass a decision back*; a match proposal must be
**pushed** to a second user (`candidate`) who issued no request. HTTP can't push
to a third party, and 005's Ready/colour/dice exchange is inherently
bidirectional and stateful. Putting the request on WS too keeps the whole
lobby→match→handshake flow on one ordered channel and avoids a request that
succeeds over HTTP but whose proposal can't be delivered because the candidate's
socket is the only way to reach them.

The WS *frame routing* and connection registry are 002's. 004 contributes a
**pure service function** `select_candidate(...)` plus the DB layer, wired into
002's dispatcher under the `matchmaking.*` message namespace. To keep 004
testable **before 002 lands**, the service function takes the online/in-game
sets as plain arguments (dependency-injected), so unit tests call it directly
with seeded data and no socket.

**OPEN:** if 002 slips, a stop-gap thin `POST /matchmaking/request` that returns
the proposal to the *requester* only (candidate notified on their next 003 poll)
is possible, but it cannot satisfy 001's "pushed invitation" requirement and is
explicitly a fallback, not the design.

## 2. Candidate-selection algorithm

```
select_candidate(me, mode, online_ids, in_game_ids, *, rng) -> Candidate | None

  # 1. DB returns eligible rows already filtered by blocks(both)/self,
  #    restricted to online_ids, ordered by elo. Each row: (user_id, username, elo).
  pool = db.fetch_eligible_candidates(me.id, online_ids - in_game_ids)
  if not pool: return None

  if mode == "closest":
      best = min(abs(c.elo - me.elo) for c in pool)
      tied = [c for c in pool if abs(c.elo - me.elo) == best]
  elif mode == "above":
      above = [c for c in pool if c.elo > me.elo]
      if not above: return None
      best = min(c.elo for c in above)          # closest strictly above
      tied = [c for c in above if c.elo == best]
  elif mode == "below":
      below = [c for c in pool if c.elo < me.elo]
      if not below: return None
      best = max(c.elo for c in below)          # closest strictly below
      tied = [c for c in below if c.elo == best]

  return rng.choice(tied)                       # uniform random tie-break
```

`rng` is injected (`random.Random`) so tests seed it for deterministic
tie-break assertions. `closest` ties on **equal absolute distance**;
`above`/`below` tie on **equal boundary Elo**.

### Intersecting the in-memory online set with SQL — **recommend id-set param**

**Recommendation: pass the online (minus in-game) id-set into SQL as a
parameter** (`WHERE u.id = ANY($2::uuid[])`), rather than fetching all DB-online
rows and filtering in Python. Rationale:

- The authoritative "who is online right now" lives in 003's in-memory WS
  registry, not the DB (`online_users` view lags by a poll interval). The set is
  small (≤ a few hundred ids for a 100-connection deployment), so `= ANY(array)`
  is cheap and lets Postgres apply the block/self filters and the
  `users_elo_rating_idx` ordering in one shot.
- Filtering in Python would require pulling every block edge for the requester
  and every candidate's elo back to the app — more rows, more round-trips.

So: **003 owns the truth of online/in-game; the DB owns blocks + elo.** We
intersect by handing the id-set to the query.

## 3. The SQL (eligible-pool query)

New module `api/app/matchmaking/db.py`, mirroring the style of
`api/app/multiplayer/db.py` (asyncpg, raw SQL, no ORM). Modelled on the
`/social/who` bidirectional-block exclusion already in
`api/app/routers/social.py`:

```sql
-- fetch_eligible_candidates(requester_id, candidate_ids[])
SELECT u.id AS user_id, u.username, u.elo_rating AS elo
FROM   users u
WHERE  u.id = ANY($2::uuid[])              -- online ∩ not-in-game (003 set)
  AND  u.id <> $1::uuid                    -- not self
  AND  NOT EXISTS (                        -- blocks: BOTH directions
        SELECT 1 FROM blocks b
        WHERE (b.blocker_id = $1::uuid AND b.blocked_id = u.id)
           OR (b.blocker_id = u.id      AND b.blocked_id = $1::uuid)
       )
ORDER BY u.elo_rating;                      -- served by users_elo_rating_idx
```

The "not playing" filter is satisfied **before** SQL: the caller passes
`online_ids - in_game_ids` as `$2`. We deliberately do *not* re-derive playing
state from `online_users` inside this query, because 003's WS set is fresher
than the view; the view remains the DB backstop / observability surface only.

**No new migration** is required — `blocks`, `users.elo_rating`,
`users_elo_rating_idx` all exist (migrations 0009, 0008). 004 adds zero schema.

## 4. Endpoint / WS message design

Under 002's dispatcher, namespace `matchmaking.*`:

- **Inbound** `matchmaking.request`:
  `{ "type": "matchmaking.request", "mode": "closest" | "above" | "below" }`
  (requester identity is the authenticated socket's user; never trust a
  client-supplied requester id.)
- **Outbound to requester + candidate** `match_proposed`: the proposal contract
  in §5 (handed to 005, which actually delivers/echoes it).
- **Outbound to requester** `matchmaking.no_candidates`:
  `{ "type": "matchmaking.no_candidates", "mode": "closest" }` → 007 renders the
  "try AI?" prompt.

The handler is a thin adapter: read `mode`, fetch 003's online/in-game sets,
call `select_candidate`, then either pass the proposal to 005's entrypoint or
emit `no_candidates`. All branching logic is unit-tested at the
`select_candidate` level without a socket.

## 5. Match-proposal contract handed to 005

```python
@dataclass(frozen=True, slots=True)
class MatchProposal:
    requester_id: str
    requester_username: str
    requester_elo: int
    candidate_id: str
    candidate_username: str
    candidate_elo: int
    mode: str  # "closest" | "above" | "below"
```

Serialized to the `match_proposed` JSON in spec §"Hand-off contract to 005".
004's responsibility ends at producing this object and calling 005's entrypoint
(e.g. `app/handshake/service.py::propose(proposal, ws_hub)`). **005 owns**:
re-checking the candidate is still available (the select→handshake race), the
Ready Yes/No exchange, colour/dice negotiation, and the
`INSERT INTO multiplayer_games`. 004 creates **no** game row.

## 6. Elo-transaction audit (cite current behaviour)

**Audited file:** `api/app/routers/multiplayer.py`,
`_write_finished_games_rows()` (lines ~201–315) and its two call sites
`make_move` (~514) and `resign_game` (~592).

**Current behaviour — already correct, no change needed:**

- Both call sites open `async with pool.acquire() as conn: async with conn.transaction():` and call `_write_finished_games_rows(conn, ...)` **inside**
  that transaction. So the move/resign state update, both `games` audit-row
  inserts, and both `users` Elo updates commit or roll back **as one unit**.
- Inside the function: `fetch_user_elo_snapshot` reads each player's
  `elo_rating/elo_peak/elo_games_count`; `elo_update` (from `app/elo.py`) computes
  new ratings with per-player `k_factor`; `insert_finished_game_history_row`
  writes the audit rows; `update_user_elo` (in `api/app/multiplayer/db.py`,
  ~line 253) does `UPDATE users SET elo_rating = $2, elo_peak = GREATEST(elo_peak, $2), elo_games_count = elo_games_count + 1 ...` per player.
- Result is the spec's "subtract from one, add to another in a single
  transaction": winner gains `+k*(1 - expected)`, loser loses the symmetric
  amount, both within the same `conn`.

**Specified invariant (locked by test, not new code):** the two `update_user_elo`
calls and both audit inserts MUST remain inside one transaction. 004 adds a
**regression test** that, on a forced failure between the two `update_user_elo`
calls, *neither* rating is persisted (transaction rolls back). If a future
refactor moves Elo writes outside the transaction, this test fails.

**Minor hardening (OPEN, propose to user):** `fetch_game_with_usernames_by_code_for_update`
already takes a row lock (`FOR UPDATE`) so concurrent move/resign can't
double-count. Confirm the snapshot reads happen *after* that lock (they do —
same `conn`, after the locked fetch). No fix needed; documented so a reviewer
doesn't "fix" a non-bug.

## 7. 1500-default verification

- `api/db/migrations/versions/20260501-140000-add-elo-rating.py` (rev 0008):
  `ADD COLUMN elo_rating INTEGER NOT NULL DEFAULT 1500` and `elo_peak ... DEFAULT 1500`. **Confirmed.**
- `api/app/routers/auth.py` registration `INSERT INTO users (username, email, password_hash, first_name, last_name) VALUES (...)` — **does not list
  `elo_rating`**, so the column DEFAULT applies. **Confirmed every new user
  starts 1500.**
- **Action:** no migration/code change. Add a unit test asserting a freshly
  registered user reads back `elo_rating == 1500 AND elo_peak == 1500 AND elo_games_count == 0`, so an accidental future INSERT that overrides the
  default is caught.

## 8. File-by-file (real paths)

| Path | New/Mod | Purpose |
| ----------------------------------------- | --- | --------------------------------------------------------------- |
| `api/app/matchmaking/__init__.py` | new | package marker |
| `api/app/matchmaking/service.py` | new | `select_candidate(...)`, `MatchProposal`, mode logic, rng tie-break |
| `api/app/matchmaking/db.py` | new | `fetch_eligible_candidates(conn, requester_id, candidate_ids)` |
| `api/app/routers/multiplayer.py` | mod? | likely **no change** — audit only (§6). Add comment locking the transaction invariant if reviewer wants. |
| 002's WS dispatcher (path TBD by 002) | mod | route `matchmaking.request` → service; emit `match_proposed` / `no_candidates`. **Owned by 002 wiring, 004 supplies handler fn.** |
| `api/tests/test_matchmaking.py` | new | selection + pool + no-candidate + edge-case tests |
| `api/tests/test_elo.py` | mod | add 1500-default-on-registration + transactional-rollback regression |
| `frontend/src/components/ChooseGameTypeModal.tsx` (or its 007 successor) | mod | wire the three lobby buttons to send `matchmaking.request` modes; render `no_candidates` → "try AI?" — **layout owned by 007**, behaviour contract here |

## 9. Test plan

**pytest (`api/tests/test_matchmaking.py`)** — uses the existing `make_user`
fixture and direct SQL seeding (the `UPDATE users SET ... ` / `INSERT INTO blocks` patterns already in `api/tests/test_social.py`):

- **closest:** seed me=1500; candidates 1400, 1490, 1700 all in online-set →
  selects 1490.
- **above:** me=1500; candidates 1490, 1510, 1600 → selects 1510 (closest
  strictly above). `above` with only 1490 below → `None`.
- **below:** me=1500; candidates 1300, 1490, 1510 → selects 1490 (max strictly
  below).
- **tie-break:** me=1500; candidates 1490 and 1510 for `closest` (both dist 10) →
  seeded rng makes the chosen one deterministic; assert membership in the tied
  set and that the seed flips it.
- **blocks both directions:** me blocks A, B blocks me, C clean → only C
  eligible (assert A and B never selected in either mode).
- **not-playing:** candidate in `in_game_ids` is excluded even though online.
- **no-candidate path:** empty online set, or only-blocked, or self-only →
  `select_candidate` returns `None`; handler emits `matchmaking.no_candidates`.
- **1500 default:** register via `client`, read `users.elo_rating/elo_peak/ elo_games_count` → 1500/1500/0.
- **transactional rollback:** monkeypatch `update_user_elo` to raise on the 2nd
  call; finish a game; assert *both* players' `elo_rating` unchanged and *no*
  `games` audit rows written.

**Cypress (note for 012):** 012 owns the two-human e2e. 004's contribution to
that suite: drive "play higher-Elo human" with two seeded browsers at known
ratings, assert the lower-rated browser receives a `match_proposed` for the
higher-rated peer; and a single-online-user scenario asserts the "No available
human players… try the AI?" prompt appears. Left as a hook for 012, not
implemented here.

## 10. Edge cases

- **Only blocked users online** → empty pool → `no_candidates`. ✓
- **Self-only online** → `c.id <> me.id` removes the only row → `no_candidates`.
- **All candidates tie** (everyone same elo as me, `closest`) → every row tied →
  uniform random pick over all.
- **`above`/`below` empty sub-pool** (everyone is on the wrong side of me) →
  `None` → `no_candidates`; **does not** fall back to `closest` (spec).
- **Candidate goes offline / starts a game between select and handshake** →
  005's re-validation at delivery time must catch it and either re-run
  matchmaking or surface "they're no longer available." 004 documents the race;
  the proposal carries the candidate's *snapshot* elo, but availability is
  re-checked by 005 against live 003 state. **This is the one cross-slice
  invariant 004↔005 must agree on.**
- **Stale view vs live set:** because we trust 003's WS set over `online_users`,
  a user whose tab just closed but whose `last_seen_at` is still warm is *not*
  matched (003 dropped them). Correct — avoids proposing to a dead socket.

## 11. Build sequence

1. Land `app/elo.py` (exists) + 1500-default test + transactional-rollback test
   — **no dependency on 002/003**, ships first, locks the fairness invariant.
1. Implement `app/matchmaking/db.py` + `service.py` with injected online/in-game
   sets; full pytest suite (§9) against seeded data — still no 002/003 needed.
1. Define + freeze `MatchProposal` / `match_proposed` JSON with 005's author.
1. Once 002's dispatcher exists, wire the `matchmaking.request` handler and emit
   `match_proposed`/`no_candidates`; integration test through the socket.
1. Frontend button wiring + `no_candidates` prompt lands with 007's modal.
1. e2e in 012.

## Assumptions & Opens

- **ASSUMPTION:** 003 exposes a callable/attribute giving the current
  `online_ids: set[str]` and `in_game_ids: set[str]` (or a per-user `in_game`
  flag) from its WS registry. `select_candidate` takes these as args; exact
  import path is wired when 003 lands. If 003 instead exposes only a "playing"
  predicate, the handler adapts before calling the service.
- **ASSUMPTION:** "just above/below" == "closest above/below" (nearest
  neighbour), not "any random one above/below." Picked for competitiveness.
- **ASSUMPTION:** match proposal carries snapshot Elo for display; **live
  availability is 005's re-check**, not embedded in the proposal.
- **OPEN:** block exclusion direction — we adopt **both** directions (consistent
  with `/social/who`); umbrella spec literally says one. Confirm with product.
- **OPEN:** transport — WS recommended (justified §1); thin-HTTP stop-gap only if
  002 slips, and it cannot push to the candidate.
- **OPEN:** minor — should an `above`/`below` empty sub-pool *offer* `closest` as
  a secondary suggestion ("nobody above you; match closest instead?") rather than
  jumping straight to the AI prompt? Currently no; flag for UX (007) call.
