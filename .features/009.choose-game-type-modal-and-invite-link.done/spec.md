# Choose-Game-Type Modal and Invite Link

## Goal

A post-login modal that lets the user pick **AI** or **Another Player**.
When the user picks Another Player, the modal generates a 15-minute
invite link the user can send to a friend, then transitions to a
"waiting for opponent" view. When the modal is closed, the invite is
cancelled in the database.

## Users and use cases

- **Returning users** who want to choose game mode without leaving the
  modal (no separate menu, no separate page).
- **Hosts** who need a copyable URL **and** a bare code to share
  through any channel (DM, SMS, voice).
- **Hosts** who want to decide whether they or the guest pick the
  colour.
- **Hosts** who close the dialog mid-wait — the resulting game row
  should not be left in `waiting` forever.

## Functional requirements

### Stage 1 — game-type selection

- Two radios: `AI` (default) and `Another Player`, plus a `Start`
  button.
- Picking `AI` + Start closes the modal and runs the existing AI flow
  unchanged.

### Stage 2 — multiplayer configuration

When `Another Player` is selected:

- "Who chooses the playing colour?" → `I will choose` (default) /
  `Opponent will choose`.
- If `I will choose`: a tertiary "Your colour" picker appears
  (`Black (X — moves first)` / `White (O)`). Otherwise the
  tertiary section disappears and `host_color` stays `null` until
  the guest joins.

### Stage 3 — invite link

On `Start`:

- Client POSTs `/multiplayer/new` with the chosen `board_size` and
  optional `host_color`.
- Modal expands to show the invite URL (single-line input,
  horizontal overflow hidden, **no wrapping**) with a copy button
  (lucide `Copy` icon, 2 s "Copied!" tooltip).
- Explanatory copy: 15-minute expiry, "they will join your game and
  this dialog will disappear".

### Stage 4 — waiting view

After ~1 s:

- "Waiting for opponent..." headline.
- Live counter: "Waiting time: 0 minutes, 12 seconds" (increments
  every second).
- Modal close `[X]` always visible and always enabled.

### Terminal transitions

| Event | UI | Backend side-effect |
| ---------------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| Guest follows link | Modal closes, browser → `/play/{code}` | `POST /multiplayer/{code}/join` (existing) |
| Host clicks `[X]` | Modal closes, AI game starts with current settings | `POST /multiplayer/{code}/cancel` (state=cancelled) |
| 15 min elapse without guest | Modal closes, "Your invite expired" toast, AI game starts | Backend transitions state to `cancelled` lazily |
| Network failure on POST /new | Inline error banner above Start; modal stays open | None |

## Backend additions

### Schema changes (edit unmerged migration 0006)

- `expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes')`
- `color_chosen_by VARCHAR(8) NOT NULL DEFAULT 'host' CHECK (...)`
- `host_color` becomes nullable, governed by a CHECK constraint that
  ties nullability to `color_chosen_by`.
- `state` CHECK gains `'cancelled'`.
- Partial index `multiplayer_games (expires_at) WHERE state = 'waiting'`.

### New / extended endpoints

- `POST /multiplayer/new` — accepts `host_color: null` (defers to guest).
- `POST /multiplayer/{code}/join` — accepts `chosen_color`, required
  iff `color_chosen_by='guest'`. Returns precise 422 codes
  (`chosen_color_required`, `chosen_color_not_allowed`).
- `POST /multiplayer/{code}/cancel` — host-only, atomic UPDATE from
  `state='waiting'` to `state='cancelled'`.
- Lazy expiry: every `GET`/`POST` runs an UPDATE flipping expired
  `waiting` rows to `cancelled` before responding.

### Response schema additions

- `expires_at: datetime`
- `color_chosen_by: 'host' | 'guest'`
- `invite_url: str` (computed from `PUBLIC_URL` env var + code)

## Frontend additions

- `ChooseGameTypeModal.tsx` — state machine driving stages 1–4.
- `useMultiplayerHostPolling.ts` — purpose-built polling hook for the
  host side; stops on `state != 'waiting'`, exponential backoff after
  5 min waited, returns
  `{ secondsWaited, expiresAt, opponentJoined, expired, error }`.
- `CopyableLinkRow.tsx` — reusable single-line URL + copy button
  (lucide `Copy`, "Copied!" badge for 2 s).
- `MultiplayerGamePage.tsx` — when arriving via `/play/CODE` with
  `color_chosen_by='guest'`, render a "Pick your colour"
  intermediate screen before the board.
- `App.tsx` — render `ChooseGameTypeModal` after login when no game
  is in progress.

## Cancellation guarantee

- The `[X]` button **awaits** the cancel POST before the modal
  unmounts (inline spinner during the call).
- If the user closes the browser tab without cancelling, lazy expiry
  picks it up within 15 min.
- If the cancel POST fails (network), the modal closes locally and
  logs a warning — lazy expiry catches it eventually.

## Quality criteria

- Backend tests in `api/tests/test_multiplayer.py` cover every new
  branch (host vs guest colour, cancellation, expiry, collision
  retry).
- Frontend tests in
  `frontend/src/components/__tests__/ChooseGameTypeModal.test.tsx`
  cover the radio reveal logic, the link rendering, the waiting
  counter (fake timers), and the cancellation path.

## Out of scope

- Resuming a cancelled or expired game (terminal states).
- Reusing an expired code (terminal state).
- A countdown timer on the guest's colour-pick screen.
- Host-side reactions to the guest's colour beyond the existing
  `state='in_progress'` signal.

## Cross-references

- Implementation plan, state machine, and tests: `plan.md`.
- Underlying multiplayer architecture:
  `.features/003.multiplayer-architecture-and-data-model.done/`.
- Final user-facing UX:
  `.features/006.web-multiplayer-invite-flow.done/`.
