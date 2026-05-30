# Multiplayer Architecture and Data Model

## Goal

Stand up human-vs-human Gomoku without adding new infrastructure or
real-time transport. The system uses pure PostgreSQL as the source of
truth, invite-link matchmaking only, both players authenticated, and
short-poll request/response. The plan defines the schema, API surface,
concurrency model, and frontend touch-points needed to ship the first
version.

## Users and use cases

- **Two authenticated users** who want to play each other through a
  shared invite link.
- **The host** who creates the game and shares a 6-character code or
  the equivalent URL.
- **The guest** who joins by visiting `/play/<code>` or pasting the
  code.

## Up-front decisions

| Question | Decision | Why |
| -------------- | ------------------------------------------- | --------------------------------------------------------- |
| Matchmaking | Invite-link only (`/play/CODE`) | Simplest UX, no lobby UI, no queue. |
| Auth | Both players authenticated | Lets Elo hook in cleanly later. |
| Transport | Short polling, 1.5 s interval | No new infra; turn-based latency is fine. |
| Engine | Pure Postgres — no Redis, no WS | One source of truth. |
| State location | `multiplayer_games.moves` JSONB | Move list ≤ 225 entries; re-derive board on read. |
| Code format | 6-char Crockford base32 (no I/L/O/U/0/1) | ~729 M codespace; readable when shared verbally. |
| Rule set | Standard 15×15 (`count == 5`, no overline) | Matches the C engine `gomoku.c`. |
| Win detection | Server-side, pure-Python ~30 LOC | Don't trust the client; port `gomoku.c:149-188`. |
| Disconnect | No special handling in v1 | Reconnection is automatic because state is on the server. |
| Elo | Out of scope for this PR | Lands in a separate follow-up. |
| Frontend | Minimal but complete — `/play/[code]` route | Reuses existing `Board` component. |

## Functional requirements

### Data model

- New table `multiplayer_games` with: `code`, `host_user_id`,
  `guest_user_id`, `host_color`, `board_size` (15/19),
  `rule_set` (default `freestyle`), `state`
  (`waiting`/`in_progress`/`finished`/`abandoned`), `winner`
  (`X`/`O`/`draw`), `moves` JSONB, `next_to_move`, `version`,
  `created_at`, `updated_at`, `finished_at`.
- Partial index for active games:
  `WHERE state IN ('waiting','in_progress')`.
- On game end, write **two** rows to the existing `games` table (one
  per participant) with `depth=0`, `radius=0`, `score=0` so both users'
  `/game/history` lists the game without schema churn.

### API surface (all under `/multiplayer`, all auth-required)

- `POST /multiplayer/new` — create invite (`host_color` nullable).
- `POST /multiplayer/{code}/join` — join (`chosen_color` required iff
  host deferred).
- `POST /multiplayer/{code}/cancel` — host marks `cancelled`.
- `GET  /multiplayer/{code}?since_version=N` — conditional fetch,
  returns 304 when no change.
- `POST /multiplayer/{code}/move` — server validates against
  `board_size`, `next_to_move`, version, etc.
- `POST /multiplayer/{code}/resign` — opponent wins.
- `GET  /multiplayer/mine` — caller's recent multiplayer games.

Single `MultiplayerGameView` response shape; slim preview view for
non-participants on `GET`.

### Concurrency

- Move race: `SELECT … FOR UPDATE` inside an asyncpg transaction;
  re-validate state, turn, version, square; append move, run win
  detection, bump version, insert two `games` rows on finish.
- Join race: solved without row locks via conditional UPDATE
  (`WHERE guest_user_id IS NULL AND host_user_id <> $1`); no row →
  precise 409.

### Frontend (no router library)

- Parse `window.location.pathname` in `App.tsx`; render
  `MultiplayerGamePage` on `^/play/([A-Z0-9]{6})$`.
- New components: `WaitingForOpponent`, `GameOverPanel`,
  `useMultiplayerPolling` hook, `multiplayerClient` API wrapper.
- Existing `Board.tsx` reused as-is (`interactive={yourTurn}` prop).

### Code generation

- `secrets.choice` over 30-character alphabet, 6 chars.
- Insert with `ON CONFLICT (code) DO NOTHING RETURNING id`; retry up
  to 5 times.

## Quality criteria

- Stack discipline: **no SQLAlchemy** — asyncpg + raw SQL throughout.
- Migration uses `revision="0006"`, `down_revision="0005"`, raw
  `op.execute("""…""")` body (matches existing migration style).
- Win detection re-implemented in ~30 lines of Python (don't pull in
  cffi for a trivial port).
- New `/multiplayer/*` router included **before** the SPA catch-all
  in `api/app/main.py` so production routing isn't shadowed.
- Pre-merge verifier review catches stack mismatches, schema
  consistency, frontend router assumptions before Stage 2 (tests).

## Out of scope (v1)

- Public lobby / matchmaking by Elo.
- Spectators, in-game chat (separately added later).
- Move-time limits, reconnection notifications.
- WebSocket transport.
- Renju, Caro, 19×19 UI (schema supports them, UI does not).
- Elo integration (separate plan).

## Multi-agent execution model

The plan was executed by four sequential agents:

1. **Verifier** — critiqued the plan, produced a "verifier notes"
   appendix the test writer and implementer must read first.
1. **Test writer** — wrote a comprehensive failing test suite (every
   endpoint, every error case, both races) and committed it red.
1. **Implementer** — made the failing tests green, including the
   migration, router, code generator, win detector, and the minimal
   frontend page+hook+waiting screen.
1. **PR submitter / reviewer** — pushed the branch, ran `/create-pr`,
   then `/review` against the resulting PR.

## Cross-references

- Full plan, schema DDL, API tables, concurrency SQL, verifier notes:
  `plan.md` in this folder.
- User-facing UX delivered on top of this:
  `.features/006.web-multiplayer-invite-flow.done/`.
- Modal flow added on top:
  `.features/009.choose-game-type-modal-and-invite-link.done/`.
- Production hardening:
  `.features/008.multiplayer-pr-hardening-checklist.done/`.
