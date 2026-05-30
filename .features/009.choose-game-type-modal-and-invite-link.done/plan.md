# Choose-Game-Type Modal & Invite-Link Flow — Plan

Status: **Plan, ready for execution.**

This plan is the spec for the new post-login modal that lets a user pick
**AI** vs **Another Player**, and (in the multiplayer case) generates a
15-minute invite link they can send to a friend. It also extends the
backend so cancelled/expired games are reflected in the database.

______________________________________________________________________

## 1. UX walkthrough

```
┌─────────────────────────── Choose Game Type ───────────────────────────┐
│                                                                        │
│   ( • ) AI                              ( ) Another Player             │
│                                                                        │
│                                                            [ Start ]   │
└────────────────────────────────────────────────────────────────────────┘
```

If the user keeps the default (**AI**) and presses **Start** → modal closes,
existing AI flow runs unchanged.

If the user picks **Another Player** → secondary section reveals:

```
┌─────────────────────────── Choose Game Type ───────────────────────────┐
│                                                                        │
│   ( ) AI                                ( • ) Another Player           │
│                                                                        │
│   Who chooses the playing color?                                       │
│   ( • ) I will choose                   ( ) Opponent will choose       │
│                                                                        │
│   Your color:                                                          │
│   ( • ) Black (X — moves first)         ( ) White (O)                  │
│                                                                        │
│                                                            [ Start ]   │
└────────────────────────────────────────────────────────────────────────┘
```

The "Your color" tertiary section only appears if "I will choose" is
selected. If "Opponent will choose" is selected, the tertiary disappears
and the host's color is left null until the guest joins.

On **Start** the client POSTs `/multiplayer/new` and the modal **expands
downward**:

```
┌─────────────────────────── Choose Game Type ───────────────────────────┐
│                                                                        │
│   ... (selections shown read-only)                                     │
│                                                                        │
│   ┌───────────────────────────────────────────────────────────┐  ┌──┐  │
│   │ https://gomoku.games/play/AB7K3X                          │  │📋│  │
│   └───────────────────────────────────────────────────────────┘  └──┘  │
│                                                                        │
│   This is your invitation link to the game you are hosting.            │
│   Please send this link to your opponent. They must click on it        │
│   within 15 minutes, or the link will expire. Once they click on it,   │
│   they will join your game and this dialog box will disappear.         │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

The link must **not wrap** — single-line input with horizontal overflow
hidden. Copy button uses the lucide `Copy` icon (already imported elsewhere
in this codebase) and shows a 2 s "Copied!" tooltip on click.

After ~1 s the modal swaps to the **waiting** view:

```
┌─────────────────────── Waiting for opponent... ────────────────────────┐
│                                                                        │
│   Waiting for your opponent to join...                                 │
│                                                                        │
│   Waiting time: 0 minutes, 12 seconds                                  │
│                                                                        │
│   ┌───────────────────────────────────────────────────────────┐  ┌──┐  │
│   │ https://gomoku.games/play/AB7K3X                          │  │📋│  │
│   └───────────────────────────────────────────────────────────┘  └──┘  │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

The counter increments every second. The modal close button (`[X]`) is
always visible and always enabled.

### Terminal transitions

| Event | UI behaviour | Backend side-effect |
| --------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------- |
| Guest follows the link | Modal closes, browser navigates to `/play/{code}` | Existing `POST /multiplayer/{code}/join` (unchanged) |
| Host clicks `[X]` | Modal closes, AI game initialised with current settings | `POST /multiplayer/{code}/cancel` — state=cancelled |
| 15 minutes elapse without guest | Modal closes, toast "Your invite expired", AI game initialised | Backend transitions state to `cancelled` lazily |
| Network failure on POST /new | Inline error banner above the Start button; modal stays open | None — game never created |

## 2. Schema changes

Editing existing migration **0006** (the multiplayer feature isn't on
`main` yet — see PR #90). We add three columns and a state value:

```sql
ALTER TABLE multiplayer_games
  ADD COLUMN expires_at      TIMESTAMPTZ NOT NULL
                              DEFAULT (NOW() + INTERVAL '15 minutes'),
  ADD COLUMN color_chosen_by VARCHAR(8) NOT NULL DEFAULT 'host'
                              CHECK (color_chosen_by IN ('host','guest'));

-- host_color is now nullable, but only when color_chosen_by='guest'
ALTER TABLE multiplayer_games ALTER COLUMN host_color DROP NOT NULL;
ALTER TABLE multiplayer_games
  ADD CONSTRAINT host_color_consistency CHECK (
    (color_chosen_by = 'host'  AND host_color IS NOT NULL) OR
    (color_chosen_by = 'guest' AND (host_color IS NULL OR host_color IN ('X','O')))
  );

-- 'cancelled' joins the existing state list
ALTER TABLE multiplayer_games DROP CONSTRAINT multiplayer_games_state_check;
ALTER TABLE multiplayer_games ADD CONSTRAINT multiplayer_games_state_check
  CHECK (state IN ('waiting','in_progress','finished','abandoned','cancelled'));

CREATE INDEX multiplayer_games_expiry_idx
  ON multiplayer_games (expires_at)
  WHERE state = 'waiting';
```

Since 0006 is unmerged, **edit the existing migration file** instead of
adding 0007. (We'll keep 0006 a single coherent unit.)

## 3. API additions

### POST `/multiplayer/new` — extended request

```json
{
  "board_size": 15,
  "host_color": "X" | "O" | null     // null = guest will choose
}
```

`host_color: null` ⇒ `color_chosen_by='guest'` and the guest must supply
their pick at join time.

Response unchanged (`MultiplayerGameView`), plus a new `expires_at` ISO
timestamp.

### POST `/multiplayer/{code}/join` — extended request

```json
{
  "chosen_color": "X" | "O" | null   // required iff color_chosen_by='guest'
}
```

If `color_chosen_by='guest'` and `chosen_color` is missing → **422**
`chosen_color_required`.
If `color_chosen_by='host'` and `chosen_color` is provided → **422**
`chosen_color_not_allowed`.

The atomic UPDATE pattern from §5 of the main plan extends to also write
`host_color` when `color_chosen_by='guest'`:

```sql
UPDATE multiplayer_games SET
  guest_user_id = $1,
  host_color    = CASE
                    WHEN color_chosen_by = 'guest' THEN
                      CASE $3 WHEN 'X' THEN 'O' ELSE 'X' END
                    ELSE host_color
                  END,
  state         = 'in_progress',
  version       = version + 1,
  updated_at    = NOW()
WHERE  code = $2
  AND  guest_user_id IS NULL
  AND  state = 'waiting'
  AND  expires_at > NOW()
  AND  host_user_id <> $1
RETURNING *;
```

If `RETURNING` produces no row, look up why (`expired`, `cancelled`,
`already_full`, `not_found`, `cannot_join_own_game`) and emit a precise 4xx.

### POST `/multiplayer/{code}/cancel` — new endpoint

```
POST /multiplayer/{code}/cancel    Auth: host only
```

Atomic UPDATE: `state='cancelled'` only if `state='waiting'` and caller
is host. Returns the updated `MultiplayerGameView`. Other states → 409
`cannot_cancel_in_state_<state>`.

### Lazy expiry

On every `GET /multiplayer/{code}`, `POST /join`, and `POST /move`, before
responding we run:

```sql
UPDATE multiplayer_games
SET    state = 'cancelled', updated_at = NOW(), version = version + 1
WHERE  code = $1 AND state = 'waiting' AND expires_at <= NOW();
```

This means we never need a background sweeper for the modal flow
(though the broader cleanup task per MULTIPLAYER.md #3 may still want one).
Lazy expiry covers the read path; a periodic sweep can cover the
"never-touched" graveyard.

### `MultiplayerGameView` additions

```python
class MultiplayerGameView(BaseModel):
    # ...existing fields...
    expires_at: datetime
    color_chosen_by: Literal['host','guest']
    invite_url: str    # frontend convenience, e.g. "https://gomoku.games/play/AB7K3X"
```

`invite_url` is computed from a `PUBLIC_URL` env var (default
`http://localhost:5173` in dev) + the code.

## 4. Backend test additions

In `api/tests/test_multiplayer.py`:

| Test | What it asserts |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `test_new_game_with_host_color_null` | `color_chosen_by='guest'`, `host_color is None`, response has `expires_at` ~ 15 min ahead. |
| `test_join_when_guest_chooses_picks_color` | guest POSTs `{chosen_color: 'O'}` ⇒ `host_color = 'X'`, guest gets `'O'`, state in_progress. |
| `test_join_when_guest_chooses_missing_color_returns_422` | omitting `chosen_color` ⇒ 422 with detail `chosen_color_required`. |
| `test_join_when_host_chose_with_chosen_color_returns_422` | host already chose; guest submitting `chosen_color` ⇒ 422 `chosen_color_not_allowed`. |
| `test_cancel_marks_state_cancelled` | host POSTs /cancel ⇒ 200, view.state=cancelled, version bumped. |
| `test_cancel_by_non_host_returns_403` | other user can't cancel. |
| `test_cancel_in_progress_returns_409` | once in_progress, /cancel ⇒ 409. |
| `test_join_after_cancel_returns_409` | trying to join cancelled ⇒ 409 `game_cancelled`. |
| `test_join_after_expiry_returns_409` | manually update expires_at backward; join ⇒ 409 `game_expired`. |
| `test_get_after_expiry_lazily_cancels` | manual expiry; subsequent GET shows state=cancelled. |
| `test_new_code_collision_retries` | mock new_code() to return colliding values N times; eventual success without 500. |

## 5. Frontend changes

### New: `ChooseGameTypeModal.tsx`

State machine:

```
        ┌──────────┐  Start (AI)         ┌────────────┐
        │   idle   │ ────────────────▶   │  ai_game   │
        │ (radios) │                     └────────────┘
        └────┬─────┘
             │ Start (Human, all selections complete)
             ▼
   ┌─────────────────┐  POST /multiplayer/new   ┌──────────────────┐
   │ creating (POST) │ ───────────────────────▶ │ waiting + link   │
   └─────────────────┘                          └────────┬─────────┘
                                                         │
                              guest joined  ┌────────────┼────────────┐
                                            ▼            │            ▼
                                    ┌────────────┐       │      ┌────────────┐
                                    │ /play/CODE │  X────┘      │ ai_game +  │
                                    └────────────┘  expire/X    │  toast?    │
                                                                └────────────┘
```

Props:

```typescript
type Props = {
  authToken: string
  onAIChosen: () => void                 // user picked AI; close + start AI flow
  onMultiplayerJoined: (code: string) => void  // navigate to /play/{code}
  onClose: () => void                    // user clicked X; treat as "AI"
}
```

### New: `useMultiplayerHostPolling.ts`

A purpose-built hook that polls `/multiplayer/{code}` waiting for
`state === 'in_progress'`. Different from the existing
`useMultiplayerPolling` because:

- Stops polling when state ≠ 'waiting' (or after 15 min cap).
- Uses 1.5 s short-poll initially, exponential backoff up to 8 s once we
  pass 5 minutes of waiting (covers MULTIPLAYER.md #5 for the host side).
- Returns `{ secondsWaited, expiresAt, opponentJoined, expired, error }`.

### Modified: `App.tsx`

After login, if no game is in progress, render `ChooseGameTypeModal`
instead of immediately showing the AI board. The "AI" branch leaves
existing logic intact.

### Modified: `MultiplayerGamePage.tsx`

When the joining browser arrives via `/play/CODE` and `color_chosen_by='guest'`,
render a "Pick your color" intermediate screen before the actual game
board. Submitting picks calls `POST /multiplayer/{code}/join` with the
color, then continues into the game.

### New: `frontend/src/components/CopyableLinkRow.tsx`

Reusable: `<input readonly>` with the URL + copy button using the lucide
`Copy` icon. Single line, `overflow-x-hidden`. Tailwind class
`whitespace-nowrap`. Click → `navigator.clipboard.writeText`. Shows
"Copied!" badge for 2 s.

## 6. Frontend test additions

In `frontend/src/components/__tests__/`:

- `ChooseGameTypeModal.test.tsx`
  - Default radio is "AI".
  - Selecting "Another Player" reveals the color sub-radios.
  - Selecting "I will choose" reveals the X/O sub-radios.
  - Selecting "Opponent chooses" hides the X/O sub-radios.
  - Pressing "Start" with AI selection fires `onAIChosen` only.
  - Pressing "Start" with full Human selections POSTs `/multiplayer/new` (mocked).
  - On a successful POST, the link is rendered, then the waiting view appears.
  - Pressing the X in the waiting view fires `POST /multiplayer/{code}/cancel`
    *and* `onClose`.
  - The counter increments while waiting (fake timers).
  - On 15 minutes elapsed: `onClose` fires automatically.

## 7. Cancellation guarantee — spelled out

> "Make sure that if the modal is cancelled, the link is marked as
> 'cancelled' in the database."

Concretely:

- The `[X]` close button on the modal **must** await the
  `POST /multiplayer/{code}/cancel` call before the modal unmounts.
  We render a tiny inline spinner during the call.
- If the user closes the browser tab without cancelling, lazy expiry
  covers it (after 15 min). Any background sweeper (MULTIPLAYER.md #3)
  is bonus, not required.
- If the cancel POST fails (network), we still close the modal locally
  but log a warning. The lazy-expire path will catch it eventually.

## 8. Out of scope

- Resuming a previously-cancelled game (no — cancelled is terminal).
- Reusing an expired code (no — expired is terminal; user creates a fresh game).
- The "guest picks color at join" intermediate screen for a 15-second
  countdown — guest sees it, decides, submits. No timer here.
- The host side does not need to react to the guest's color choice
  beyond the existing `state='in_progress'` polling signal.

## 9. Implementation order

1. Backend: edit migration 0006 (expires_at, color_chosen_by, cancelled).
1. Backend: extend `models/multiplayer.py` schemas.
1. Backend: refactor `routers/multiplayer.py` for color-by-guest, cancel,
   lazy-expire, collision-retry.
1. Backend: write the new tests, run, iterate to green.
1. Frontend: `CopyableLinkRow`, `ChooseGameTypeModal`,
   `useMultiplayerHostPolling`.
1. Frontend: wire into `App.tsx` after-login flow.
1. Frontend: extend `MultiplayerGamePage` for the guest-color-pick step.
1. Frontend: write Vitest cases.
1. Manual two-tab smoke test (Alice creates link, Bob clicks, game starts).

## 10. Effort estimate

~2 days focused work — backend changes are small but the React state
machine has a few branches.
