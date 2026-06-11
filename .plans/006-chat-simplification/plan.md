# 006 — Chat Simplification: Architecture Plan

> Status: ready for implementation. Authored against the real codebase
> (`api/app/routers/chat.py`, `frontend/src/components/ChatPanel.tsx`,
> `frontend/src/hooks/useChatMessages.ts`).

## Architecture decision

Chat is demoted from a social-networking widget to a focused in-game
communication channel. The structural changes are:

1. **Command surface shrinks to three inputs:** `/like`, `/boo`, `/help`.
1. **Transport migrates from polling to WS push** (002 `chat.message`).
   `useChatMessages.ts` (polling loop) is deleted; `POST /chat/{code}/messages`
   stays as the write path.
1. **Three invite-related endpoints are removed** from `chat.py`.
1. **ChatPanel gets a lifecycle:** active only during `in_progress`,
   auto-closing after game end with a countdown.

## Command parser design

Replace `SLASH_RE`/`SLASH_SPECS` in `ChatPanel.tsx` with the minimal set:

```typescript
type SlashAction = "like" | "boo";
const SLASH_USERNAME = "([\\w0-9\\-\\^]{2,30})";
const SLASH_RE: Record<SlashAction, RegExp> = {
  like: new RegExp(`^\\s*/like\\s+@?${SLASH_USERNAME}\\s*$`, "i"),
  boo:  new RegExp(`^\\s*/boo\\s+@?${SLASH_USERNAME}\\s*$`,  "i"),
};
const HELP_RE = /^\s*\/help\s*$/i;
const HELP_TEXT =
  "/like @user  — express that you enjoyed playing with them\n" +
  "/boo @user   — block them from future games (permanent)\n" +
  "/help        — this list";
```

Unknown `/` command detection: if `text.startsWith("/")` and it matches
none of `SLASH_RE`/`HELP_RE`, push a local error caption and return —
nothing is sent to the server.

## DB writes for `/like` and `/boo`

Both dispatch via the existing social endpoints — no new backend endpoint.

| Command | Endpoint | Existing handler |
| --- | --- | --- |
| `/like @user` | `POST /social/follow` | `social.py::follow()` — `INSERT … friendships … ON CONFLICT DO NOTHING` |
| `/boo @user` | `POST /social/block` | `social.py::block()` — block insert + friendship wipe + active-game termination |

Both are idempotent. `/boo` mid-game: the `/social/block` response carries
`game_terminated: true` → fire the post-game countdown (same path as a
normal game-over).

### Edge cases

- `/boo self` / `/like self` → server returns HTTP 400 `cannot_target_self`;
  also add a front-end guard (`target === meUsername` case-insensitive) → local error.
- `/like` already-friend, `/boo` already-blocked → `ON CONFLICT DO NOTHING`; success caption (idempotent).
- Malformed `@user` (\<2 chars / illegal chars) → regex miss → "unknown command".

## Transport migration

**Current:** `useChatMessages.ts` polls `GET /chat/{code}/messages?since=N`.

**Target (after 002):** the `chat.message` WS frame delivers incoming
messages. The hook is deleted; `ChatPanel.tsx` subscribes to the shared
WS client:

```typescript
useEffect(() => {
  if (!wsClient || !gameCode) return;
  return wsClient.subscribe(`game:${gameCode}`, (event) => {
    if (event.type !== "chat.message") return;
    const p = event.payload;
    setMessages((prev) => prev.some((m) => m.id === p.id) ? prev :
      [...prev, { id: p.id, speaker: p.speaker_username,
                  me: p.speaker_username === meUsername,
                  body: p.message, at: p.created_at }]);
  });
}, [wsClient, gameCode, meUsername]);
```

**Transitional (until 002 merges):** keep the polling loop behind a
`TODO(002)` comment; swap to the WS subscriber when 002 lands. The
`send()` path (`POST /chat/{code}/messages`) is unchanged in both states;
sender optimistically inserts their own bubble.

## On-join focus + system message

Trigger: `game.update` transition to `in_progress`. ChatPanel receives an
`isActive: boolean` prop that flips `false → true`.

```typescript
useEffect(() => {
  if (!isActive || !peerUsername) return;
  inputRef.current?.focus();
  pushMessage({ system: true, systemKind: "info",
    body: `System Message: you can chat here with your opponent ` +
          `@${peerUsername}, can /like @${peerUsername} during the game ` +
          `if you like them, or you can /boo @${peerUsername} which will ` +
          `ban you from ever playing again.` });
}, [isActive, peerUsername]);
```

## Post-game countdown close

Trigger: `isActive` flips `true → false` (terminal state).

```typescript
useEffect(() => {
  if (isActive) return;
  const id = pushMessage({ system: true, body: "Great game you two! Closing the chat in 3..." });
  const t1 = setTimeout(() => updateMessageBody(id, "Great game you two! Closing the chat in 2..."), 1000);
  const t2 = setTimeout(() => updateMessageBody(id, "Great game you two! Closing the chat in 1..."), 2000);
  const t3 = setTimeout(() => onChatClosed?.(), 3000);
  return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
}, [isActive]);
```

Input is disabled the moment `isActive` is false (before the countdown).
`updateMessageBody(id, body)` already exists in `ChatPanel.tsx`.

## Removal list (real paths)

**`api/app/routers/chat.py`** — delete: `POST /invite`, `GET /incoming`,
`POST /incoming/{code}/decline` endpoints; `InviteRequest`,
`InviteResponse`, `IncomingInvite`, `IncomingInvitesResponse`,
`DeclineResponse` models; `_target_state()`, `_check_invite_rate_limit()`;
constants `INVITE_HOURLY_CAP`, `INVITE_DAILY_CAP`, `DECLINE_MESSAGE`,
`RATE_LIMIT_ERROR`, `TARGET_PRESENCE_WINDOW_SECONDS`. Keep
`POST /{code}/messages`, `GET /{code}/messages` + their models. Rewrite
the module docstring.

**`frontend/src/hooks/useChatMessages.ts`** — delete the file (only
imported by `ChatPanel.tsx`).

**`frontend/src/components/ChatPanel.tsx`** — surgical edits: drop
`useChatMessages` import + polling wiring; narrow `SlashAction` to
`"like"|"boo"`; rebuild `SLASH_RE`/`SLASH_SPECS`/`HELP_TEXT`; delete all
`/who` machinery + "Who's Online?" button; add unknown-command guard;
add `isActive`/`onChatClosed` props; add on-join + countdown effects;
make `gameCode` and `peerUsername` required (remove home-rail null path);
update placeholder/empty-state copy.

**`frontend/cypress/e2e/chat-slash-commands.cy.ts`** — full rewrite.

No new files. No migrations. `social.py` unchanged.

## ChatPanelProps after changes

```typescript
interface ChatPanelProps {
  meUsername: string;
  peerUsername: string;            // required
  authToken: string; apiBase: string;
  gameCode: string;                // required
  isActive: boolean;               // true while in_progress
  wsClient?: WsClient | null;      // 002 client; null → polling fallback
  onActiveGameTerminated?: () => void;
  onChatClosed?: () => void;
  variant?: "dark" | "light"; height?: "card" | "fill";
}
```

## Test plan

**pytest (`api/tests/routers/test_chat.py`):**

1. `test_post_message_persisted`
1. `test_boo_inserts_block`
1. `test_like_inserts_friendship`
1. `test_boo_idempotent`, `test_like_idempotent`
1. `test_removed_invite_endpoint_404_or_405`,
   `test_removed_incoming_endpoint_404_or_405`,
   `test_removed_decline_endpoint_404_or_405`
1. Keep existing `GET /chat/{code}/messages` coverage.

**Cypress (`chat-slash-commands.cy.ts` rewrite):** `/help` shows only
`/like`+`/boo` (no `/invite`,`/follow`,`/who`); `/like @bob` → friendships
row; `/boo @bob` → blocks row; `/boo` mid-game ends the game; unknown
command shows error + sends nothing. Two tests (on-join system message,
post-game countdown) need the two-client harness from 012 → author them
behind an `@012` tag (genuinely skipped via `it.skip`, not vacuous).

## Build sequence

- [ ] **A — backend cleanup:** delete 3 endpoints + helpers; add
  `test_removed_*`; `just test-api` green.
- [ ] **B — frontend command reduction:** strip slash machinery + `/who`;
  delete `useChatMessages.ts`; `just test-frontend` green.
- [ ] **C — lifecycle:** add `isActive`/`onChatClosed`; on-join + countdown
  effects; wire callers.
- [ ] **D — Cypress rewrite:** replace `chat-slash-commands.cy.ts`;
  `@012` tests skipped.
- [ ] **E — WS wiring (after 002):** remove polling shim; wire
  `wsClient.subscribe`; untag the `@012` tests.

## ASSUMPTION / OPEN

- **ASSUMPTION:** `/social/follow` and `/social/block` remain the write
  paths; `social.py` is not modified — command semantics are a frontend
  rename (`/block`→`/boo`, `/follow`→`/like`).
- **ASSUMPTION:** `/social/block` already returns `game_terminated: bool`.
- **OPEN:** on-join effect fires on mount if a player refreshes mid-game
  (correct behaviour) — verify manually.
- **OPEN:** confirm no caller renders `ChatPanel` with `gameCode=null`
  before removing the null path.

## Verifier notes (Jeff Dean)

1. Countdown `setTimeout`×3 must be cleared on unmount (React strict mode
   double-fire) — the effect cleanup handles it.
1. `/boo` fires `onActiveGameTerminated` AND the countdown — parent must
   set `isActive=false` (triggering the countdown in the still-mounted
   panel) rather than unmounting synchronously; unmount after `onChatClosed`.
1. Front-end self-target guard in addition to the server 400.
1. `@012`-tagged Cypress tests must be genuinely skipped, not empty.
1. Don't delete existing `GET /chat/{code}/messages` test in Phase A.
1. Verify the matchmaking pool-exclusion query (004) uses `blocks_blocked_id_idx`.
