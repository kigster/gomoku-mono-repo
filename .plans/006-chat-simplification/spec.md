# 006 — Chat Simplification

## Goal

Strip the in-game chat back to the bare minimum needed for two players
to communicate during a match and express a social signal at the end.
The current implementation re-created 1990s IRC — slash commands for
invites, follows, unfollows, a /who directory, /woo, paginated online
lists — none of which belongs inside an in-game chat widget. This
feature reverses that expansion.

## Final command set

Only three inputs are valid in the chat input box:

| Input | DB write | Semantics |
| --- | --- | --- |
| `/like @username` | `INSERT INTO friendships (user_id, friend_id)` | Express that you enjoyed the game with this person. Idempotent (conflict → do nothing). |
| `/boo @username` | `INSERT INTO blocks (blocker_id, blocked_id)` + wipe any friendship rows in either direction | Permanently exclude this person from future matchmaking. The `blocks` row is the sole source of truth; 004 reads it. |
| `/help` | none | Print a single system message listing only `/like` and `/boo`. |
| Free text | persist to `chat_messages` | Normal chat bubble, delivered to the opponent via WS `chat.message`. |

Any other `/` command typed into the box is rejected with a local
error caption: "Unknown command. Type /help for available commands."
The text is NOT sent to the server.

## Verbatim system messages

### On opponent join (both players see this)

When the `game.update` WS event carries `state: 'in_progress'` and
the guest has just been set (i.e. version transitions from waiting to
in_progress), inject the system message into the chat panel immediately
— before any free text — rendered as a centred info caption:

```
System Message: you can chat here with your opponent @<peer>, can /like @<peer> during the game if you like them, or you can /boo @<peer> which will ban you from ever playing again.
```

(The `@<peer>` token is replaced with the actual username of the other
player as seen by the reader.)

### Post-game countdown

When the `game.update` WS event delivers a terminal state (`won`,
`abandoned`, `cancelled`), the chat input is disabled immediately and
the following countdown sequence plays in the chat panel message area:

```
Great game you two! Closing the chat in 3...
```

...one second later, the message updates in place to `...2...`, then
`...1...`, then the ChatPanel unmounts (returns null / is hidden by the
parent).

The countdown is a single mutating local message — not three separate
rows appended — so it does not flash. It is never persisted to
`chat_messages`.

## Chat lifecycle

Chat is **active only while the multiplayer game is `in_progress`**.

| Game state | Chat behaviour |
| --- | --- |
| `waiting` | ChatPanel not shown |
| `in_progress` | ChatPanel shown; input enabled; on-join system message injected |
| `won` / `abandoned` / `cancelled` | Countdown plays, then panel closes |

There is no "home-page right-rail" chat variant after this change. The
panel renders exclusively inside the in-game view.

## What gets REMOVED

### Backend endpoints deleted from `api/app/routers/chat.py`

| Endpoint | Reason |
| --- | --- |
| `POST /chat/invite` | Invites now come from the matchmaking flow (004/005); the old slash-command path is superseded. |
| `GET /chat/incoming` | Polling for incoming invites is replaced by the WS push (002). |
| `POST /chat/incoming/{code}/decline` | The old invite-decline flow; 004/005 handle the new handshake. |

The two message endpoints **stay**:

- `POST /chat/{code}/messages` — write path (REST per 002's "writes stay REST").
- `GET /chat/{code}/messages` — read path; kept as reconnection reconciliation fallback.

### Backend helper code deleted from `chat.py`

- `InviteRequest`, `InviteResponse`, `IncomingInvite`,
  `IncomingInvitesResponse`, `DeclineResponse` Pydantic models.
- `_target_state()`, `_check_invite_rate_limit()` helper functions.
- Constants: `INVITE_HOURLY_CAP`, `INVITE_DAILY_CAP`, `DECLINE_MESSAGE`,
  `RATE_LIMIT_ERROR`, `TARGET_PRESENCE_WINDOW_SECONDS`.

### Frontend slash commands removed from `ChatPanel.tsx`

- `/invite`, `/follow`, `/unfollow`, `/woo` — removed from `SLASH_RE`,
  `SLASH_SPECS`, the `SlashAction` union.
- `/who` machinery — `WHO_RE`, `dispatchWho()`, `renderWhoTable()`,
  `formatIdleSeconds()`, `whoActivityLabel()`, `WhoRowInput`, and the
  "Who's Online?" header button.
- `HELP_TEXT` updated to list only `/like` and `/boo`.

### Frontend hook fate

`frontend/src/hooks/useChatMessages.ts` — the polling hook is
**deleted**. Message delivery moves to the WS `chat.message` frame
(002). The `send()` logic (`POST /chat/{code}/messages`) is inlined
into `ChatPanel.tsx`.

### Cypress test rewrite

`frontend/cypress/e2e/chat-slash-commands.cy.ts` is **fully rewritten**
to the new command set (see plan.md). Old tests for `/invite`,
`/follow`, `/block`, `/unfollow`, `/woo`, `/who` are deleted.

## Dependencies

- **002 (WebSocket)** — chat delivery migrates from polling to the
  `chat.message` WS frame. Gated behind 002. If 002 not yet merged,
  polling stays as a `TODO(002)` fallback.
- **004 (matchmaking)** — `/boo` writes to `blocks`; 004 reads that
  table to exclude blocked users. Shared contract, no schema change.
- **005 (ready/color handshake)** — the on-join system message is
  triggered by the `in_progress` transition that 005 produces.

## Non-goals

- WebSocket transport implementation (002).
- Matchmaking pool selection (004).
- Ready/color handshake UI (005).
- Modal layout changes (007).
- Any new DB schema; `blocks` and `friendships` tables are unchanged.
- Emoji reactions, read receipts, typing indicators.
