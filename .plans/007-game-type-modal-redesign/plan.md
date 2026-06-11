# 007 — Game-type Modal Redesign — Plan

> Spec: [`spec.md`](./spec.md). Owns modal layout + click routing only;
> downstream behavior lives in 003/004/005/008/009.

## Architecture

`ChooseGameTypeModal` is rewritten from an invite-link/color-picker host flow
into a thin **launcher** that renders presence, a primary-intent toggle, six
labeled action buttons, and a timed-game checkbox, then **routes each click to
a sibling task's entrypoint** and closes (or swaps to the no-humans panel).

The current file is ~516 lines of host-side multiplayer plumbing (auto-create
invite, polling, cancel-on-close, join-by-code). Almost all of it is deleted —
see **Removal map**. The redesign carries no API calls of its own: it consumes
hooks/callbacks injected as props or imported from sibling tasks.

### Component tree

```
ChooseGameTypeModal                 (this slice — orchestrator)
├─ ModalShell                       (existing — reused as-is)
├─ PresenceHeader                   (this slice; consumes usePresence() from 003)
├─ IntentToggle                     (this slice — "Play with AI" | "…Elo-Matched Human")
├─ LauncherButtonList               (this slice — the 6 stacked 75% buttons)
│   └─ LauncherButton ×6            (this slice — long-label button primitive)
├─ TimedGameCheckbox                (this slice — boolean, human path only)
└─ NoHumansFallbackPanel            (this slice — message + AI buttons 3–6)
```

`LauncherButtonList` is reused inside `NoHumansFallbackPanel` (rendering only
the AI subset) to keep the four AI buttons defined once.

### Props (new contract)

```ts
interface Props {
  // 003
  presence: { online: number; playing: number; status: "loading" | "live" | "stale" };
  // 004 — start matchmaking; resolves to a proposal or "no-humans"
  onMatchmake: (req: { mode: "closest-elo" | "above" | "below"; timed: boolean })
    => Promise<{ outcome: "matched"; proposal: MatchProposal } | { outcome: "no-humans" }>;
  // 008 — start an AI game at a difficulty
  onStartAI: (difficulty: "easy" | "intermediate" | "hard" | "hardest") => void;
  // 005 — hand a match proposal to the Ready/color handshake modal
  onMatchProposed: (proposal: MatchProposal) => void;
  onClose: () => void;
}
```

`authToken`, `onAIChosen`, `onGuestJoined` (current props) are removed. The
App-level wiring in `frontend/src/App.tsx` (lines ~449–456) is updated to pass
the new props; `onStartAI` replaces the old `onAIChosen` thunk, and the old
`onGuestJoined → window.location.href = /play/<code>` redirect is dropped in
favor of 005's handshake (which navigates once both players are ready).

> **ASSUMPTION:** exact hook/type names from siblings (`usePresence`,
> `MatchProposal`, the matchmaking entrypoint shape) are not yet committed —
> the dirs `.plans/003…`, `004…`, `005…`, `008…` are present but empty. We
> define the seam above; if a sibling lands a different signature, only the
> prop adapter in `App.tsx` changes, not the modal internals.

## Modal state machine

```
                       ┌──────────────── INITIAL ────────────────┐
                       │ presence header + toggle + all 6 buttons │
                       └───────┬───────────────────────┬─────────┘
        toggle: "AI"           │                       │  toggle: "Human"
        (focus AI buttons)     │                       │  (focus human buttons,
                               │                       │   show TimedGameCheckbox)
                               ▼                       ▼
                       ┌──────────────┐        ┌──────────────────┐
                       │  AI INTENT   │        │   HUMAN INTENT   │
                       │ buttons 3–6  │        │ buttons 1–2 +    │
                       │ live         │        │ timed checkbox   │
                       └──────┬───────┘        └────────┬─────────┘
            click 3–6         │                         │  click 1/2 (mode=above/below)
            (or toggle btn    │                         │  or toggle btn (mode=closest-elo)
            doesn't start —   │                         ▼
            it just focuses)  │                 ┌──────────────┐
                              │                 │  MATCHMAKING │  onMatchmake({mode,timed})
                              │                 │  (spinner,   │
                              │                 │   cancelable)│
                              │                 └──┬────────┬──┘
                              │           matched  │        │  no-humans
                              │                    ▼        ▼
                              │           ┌────────────┐ ┌────────────────────┐
                              │           │ HANDOFF→005│ │ NO-HUMANS FALLBACK │
                              │           │ onMatch    │ │ message + buttons  │
                              │           │ Proposed() │ │ 3–6                │
                              │           │ → close    │ └─────────┬──────────┘
                              ▼           └────────────┘           │ click 3–6
                       ┌────────────┐                              ▼
                       │ HANDOFF→008│◀─────────────────────────────┘
                       │ onStartAI()│
                       │ → close    │
                       └────────────┘
```

State held locally:

```ts
type Phase = "initial" | "matchmaking" | "no-humans";
const [intent, setIntent] = useState<"ai" | "human">("ai"); // toggle box
const [timed, setTimed] = useState(false);                   // human checkbox
const [phase, setPhase] = useState<Phase>("initial");
const [mmError, setMmError] = useState<string | null>(null);
```

The toggle does **not** start a game; it only sets `intent` (which buttons are
emphasized). Only a stacked button (or the toggle's own implicit
`closest-elo` shortcut, if we keep one — see **OPEN:**) commits to a flow.

## Routing table (button → mechanism → owner)

| Trigger | Local action | Calls | Owner |
|----------------------------------|-------------------------------------|-----------------------------------------|-------|
| Toggle `Play with AI` | `setIntent("ai")` | — (focus only) | 007 |
| Toggle `…Elo-Matched Human` | `setIntent("human")` | — (focus + show checkbox) | 007 |
| Button 1 (higher Elo) | `phase="matchmaking"` | `onMatchmake({mode:"above", timed})` | 004→005 |
| Button 2 (lower Elo) | `phase="matchmaking"` | `onMatchmake({mode:"below", timed})` | 004→005 |
| Button 3 (Easy) | close | `onStartAI("easy")` | 008 |
| Button 4 (Intermediate) | close | `onStartAI("intermediate")` | 008 |
| Button 5 (Hard) | close | `onStartAI("hard")` | 008 |
| Button 6 (Hardest, Premium) | close | `onStartAI("hardest")` | 008 |
| `onMatchmake` → `matched` | close | `onMatchProposed(proposal)` | 005 |
| `onMatchmake` → `no-humans` | `phase="no-humans"` | — (render fallback) | 007 |
| TimedGame checkbox | `setTimed(b)` | — (forwarded with 1/2) | 009 |

`onMatchmake` is the abstraction boundary: whether 004 implements it as a hook
returning a promise or a WS request/response (002 transport) is invisible
here. Buttons 1–2 await it and branch on `outcome`.

## ASCII wireframe (desktop)

```
┌──────────────────────── Choose Game Type ───────────────────────[ × ]┐
│                                                                       │
│              [ 53 People Online, 23 Are Playing ]                     │
│                                                                       │
│        ┌─────────────────────────────────────────────────┐           │
│        │  ( • Play with AI )   ( Play with a Elo-Matched   │  ← toggle │
│        │                          Human )                  │    (smaller)
│        └─────────────────────────────────────────────────┘           │
│                                                                       │
│      ┌─────────────────────────────────────────────────────┐ 75%     │
│      │  I'd like to play another human with a higher Elo …  │  (1)     │
│      └─────────────────────────────────────────────────────┘         │
│      ┌─────────────────────────────────────────────────────┐         │
│      │  I'd like to play another human with a lower Elo …   │  (2)     │
│      └─────────────────────────────────────────────────────┘         │
│      ┌─────────────────────────────────────────────────────┐         │
│      │  I'd like to play vs a computer on Easy Mode         │  (3)     │
│      └─────────────────────────────────────────────────────┘         │
│      ┌─────────────────────────────────────────────────────┐         │
│      │  I'd like to play vs a computer on Intermediate Mode │  (4)     │
│      └─────────────────────────────────────────────────────┘         │
│      ┌─────────────────────────────────────────────────────┐         │
│      │  I'd like to play vs a computer on Hard Mode         │  (5)     │
│      └─────────────────────────────────────────────────────┘         │
│      ┌─────────────────────────────────────────────────────┐         │
│      │  …Hardest Mode (Premium Game: $1 — Free during Beta) │  (6)     │
│      └─────────────────────────────────────────────────────┘         │
│                                                                       │
│      [ ] Timed Game  — 15s per move, 5 min draw clock   (human only)  │
└───────────────────────────────────────────────────────────────────────┘
```

No-humans fallback replaces the button list region:

```
│   No available human players are currently available.                 │
│   Would you like to try the AI?                                       │
│      ┌──────── Easy ────────┐ ┌──── Intermediate ────┐                │
│      ┌──────── Hard ────────┐ ┌── Hardest (Premium) ─┐  (buttons 3–6) │
```

## Tailwind strategy

Per `frontend/CLAUDE.md` (utilities over raw CSS) and the existing modal's
dark amber palette:

- **Stacked buttons:** `w-3/4 mx-auto block` (the 75% width), `text-left`
  long labels, `rounded-lg px-5 py-4`, amber emphasis when its intent group
  is active (`bg-amber-500 text-neutral-900 hover:bg-amber-400`), muted when
  the other intent is selected (`bg-neutral-700/40 text-neutral-300 hover:border-neutral-400`). Stack via parent `space-y-3`.
- **Toggle box:** smaller centered segmented control —
  `inline-flex rounded-lg border border-neutral-600 p-1`, each segment
  `rounded-md px-4 py-2 text-sm`, selected = amber fill.
- **Header counts:** `text-sm tabular-nums text-neutral-300 text-center`;
  stale → `opacity-60` + tiny spinner; loading → skeleton
  (`animate-pulse h-4 w-40 rounded bg-neutral-700`).
- **Premium button (6):** keep within the amber family; add a subtle
  `ring-1 ring-amber-300/40` accent to read as premium without a new color
  system. The "$1 / Free during Beta" copy stays in-label.
- **Checkbox:** `accent-amber-500` (matches existing `RadioCard`).
- Reuse `ModalShell` (`widthClassName="max-w-xl"` as today).

## Removal / refactor map (cite current `ChooseGameTypeModal.tsx`)

DELETE outright (host-invite + join-by-code plumbing):

- `extractInviteCode` (L20–32) and its consumer `JoinByCodeSection`
  (L394–470) — manual invite path retired.
- `InviteSection` (L472–515) and `CopyableLinkRow` import (L3) — no link to
  show.
- The auto-create invite `useEffect` + `configKey`/`createdKeyRef`
  (L120–180), `handleStartHost` (L188–190), the polling hook
  `useMultiplayerHostPolling` (L10, L71–96), expiry/cancel effects
  (L98–118), and `handleClose`'s cancel-on-waiting branch (L192–201).
- All host/guest color state: `chooser`, `hostColor`, `desiredHostColor`,
  the "Who chooses the playing color?" + "Your color" fieldsets (L261–282) —
  color is negotiated post-match by 005, not pre-match here.
- `apiNewGame` / `apiCancelGame` imports (L4–9) and the `game`/`creating`/
  `createError`/`joinValue`/`secondsWaited`/`expired` state.
- `onAIChosen` / `onGuestJoined` / `authToken` props (L34–49).

KEEP / refactor:

- `ModalShell` usage (L205–210) — retitle stays "Choose Game Type".
- `RadioCard` (L358–392) — repurpose into the toggle segment + reuse its
  amber-selected idiom for `LauncherButton`, or supersede with the new
  primitives. Don't keep dead.

UPDATE elsewhere:

- `frontend/src/App.tsx` L449–456 — swap prop wiring (drop the `/play/<code>`
  redirect; inject `presence`, `onMatchmake`, `onStartAI`, `onMatchProposed`).
- `frontend/CLAUDE.md` "Key Components" + "Multiplayer endpoints used" — the
  ChooseGameTypeModal description no longer generates invites; `/multiplayer/new`
  is no longer driven from here (note which task, if any, still uses it).

## File-by-file (real paths)

| Path | Change |
|------|--------|
| `frontend/src/components/ChooseGameTypeModal.tsx` | Rewrite: orchestrator + 6 subcomponents (or split, see below). |
| `frontend/src/components/launcher/PresenceHeader.tsx` | NEW — counts header (loading/live/stale/zero). |
| `frontend/src/components/launcher/IntentToggle.tsx` | NEW — AI/Human segmented toggle. |
| `frontend/src/components/launcher/LauncherButton.tsx` | NEW — 75%-width long-label button. |
| `frontend/src/components/launcher/LauncherButtonList.tsx` | NEW — the 6 buttons + AI-only subset for fallback. |
| `frontend/src/components/launcher/TimedGameCheckbox.tsx` | NEW — human-path checkbox. |
| `frontend/src/components/launcher/NoHumansFallbackPanel.tsx` | NEW — message + AI buttons. |
| `frontend/src/App.tsx` | Update prop wiring at the modal render site (~L449). |
| `frontend/src/components/__tests__/ChooseGameTypeModal.test.tsx` | Rewrite (current tests cover invite/join flow). |
| `frontend/CLAUDE.md` | Update component + endpoint notes. |

> Subcomponents may live as a `launcher/` folder (above) or inline in the
> single file mirroring today's structure. Folder is preferred for testability
> and to keep the orchestrator under ~150 lines. **ASSUMPTION:** folder split.

## Test plan

### RTL (`ChooseGameTypeModal.test.tsx`, vitest + @testing-library/react)

Rendering:

- All six buttons render with **verbatim** labels (assert the exact strings,
  including the Hardest/Premium parenthetical with the em dash).
- Header renders `usePresence` counts; loading → skeleton, stale → dimmed +
  spinner, `online: 0` → still renders "0 People Online" (not an error).
- Timed-Game checkbox is present only in the human intent / human buttons
  context; absent/ignored for AI.

Click routing (mock the injected callbacks):

- Button 1 → `onMatchmake({mode:"above", timed:<current>})`; toggling the
  checkbox first flips `timed` in the call args.
- Button 2 → `onMatchmake({mode:"below", timed})`.
- `onMatchmake` resolving `matched` → `onMatchProposed(proposal)` called and
  modal closes (`onClose`); resolving `no-humans` → fallback panel renders.
- Buttons 3/4/5/6 → `onStartAI("easy"|"intermediate"|"hard"|"hardest")`.
- Fallback panel's AI buttons route identically to 3–6.
- Toggle buttons set intent (emphasis class flips) **without** calling any
  start callback.

### Cypress (note for 012)

012 (`.plans/012-e2e-two-human-cypress`) drives the end-to-end suite:

- **Human game:** open launcher → click button 1 (or 2) → matchmaking →
  handshake (005) → two-human game starts. 007 only guarantees button 1/2
  reach `onMatchmake`; the full two-human path is 012 + 004/005.
- **AI game:** open launcher → click a difficulty button → AI game starts
  (008). 007 guarantees the click reaches `onStartAI`.

## Edge cases

- **Counts loading:** header skeleton; buttons remain interactive (you can
  start a game before presence arrives).
- **0 online:** valid live state; show "0 People Online, 0 Are Playing".
  Human buttons still clickable → 004 returns `no-humans` → fallback. (Do not
  pre-disable human buttons purely on `online===0`; let 004 be the authority,
  unless 004 exposes a cheap `canMatch` signal — see **OPEN:**.)
- **WS disconnected (stale):** keep last-known counts dimmed + spinner; never
  blank or "—". `status:"stale"` from 003 drives this.
- **Matchmaking in flight:** show cancelable spinner state on the human
  button; guard against double-submit (disable the two human buttons while
  `phase==="matchmaking"`).
- **Matchmaking error (not no-humans):** surface `mmError` inline (reuse the
  existing red error banner idiom from current L286–290), return to initial.
- **Rapid intent toggling:** purely visual; no network effect, no flicker of
  the (now-removed) auto-create invite.

## Build sequence

1. Land prop-contract types + the orchestrator skeleton behind the new
   signature; stub siblings with no-op callbacks so the modal compiles and
   renders the static layout.
1. Build `PresenceHeader`, `IntentToggle`, `LauncherButton(List)`,
   `TimedGameCheckbox`, `NoHumansFallbackPanel`; wire routing to the props.
1. Rewrite RTL tests against the mocked callbacks (no live siblings needed).
1. Update `App.tsx` wiring + `frontend/CLAUDE.md`.
1. Integrate real 003/004/005/008 entrypoints as they land (adapter in
   `App.tsx` only); browser-test at `https://dev.gomoku.games` per Hard Rule 2;
   coordinate the e2e assertions with 012.

## Open questions

- **OPEN:** Toggle copy `Play with a Elo-Matched Human` is grammatically "an".
  Spec gives it verbatim — keep as-is or fix to "an"? Flagging; not changing
  without a call.
- **OPEN:** Does the toggle's `…Elo-Matched Human` button itself start a
  `closest-elo` match, or is it purely a focus control with buttons 1–2 being
  the only human starters? Spec implies a "fast path"; plan treats it as a
  `closest-elo` shortcut but this needs 004's confirmation.
- **OPEN:** Does any task still need the manual share-link (`/multiplayer/new`
  → `/play/<code>`)? Plan retires the UI; if 004/005/006 want a private-invite
  affordance it returns as a secondary disclosure, not the primary flow. Who
  owns `/multiplayer/new` after this?
- **OPEN:** Should human buttons pre-disable when 003 reports `online===0`, or
  always defer to 004's `no-humans` outcome? Plan defers to 004 unless 004
  exposes a cheap `canMatch` hint.
- **ASSUMPTION:** Sibling hook/type names (`usePresence`, `MatchProposal`,
  matchmaking/AI entrypoints) are placeholders; their dirs are present but
  empty. The seam is the props contract above.
