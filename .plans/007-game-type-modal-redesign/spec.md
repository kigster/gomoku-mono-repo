# 007 — Game-type Modal Redesign

## Goal

Replace the current `ChooseGameTypeModal` (an invite-link / color-picker-first
flow) with a single, opinionated launcher that:

1. Shows **realtime online/playing counts** at the top.
1. Offers a top **toggle box**: _Play with AI_ ↔ _Play with an Elo-Matched
   Human_.
1. Presents **six long, vertically-stacked, 75%-width action buttons** with
   exact copy (two human-Elo intents, four AI difficulties).
1. Lets human-vs-human games opt into a **Timed Game** via a checkbox.
1. Falls back to a **"no humans available"** panel that offers the AI buttons.

This slice owns **modal information architecture, layout, and click routing**.
It does **not** own the data behind those clicks. Each button hands off to the
entrypoint exposed by a sibling task (matchmaking, handshake, AI start). The
manual `/play/<code>` invite-link + color-picker flow is retired here (see
Non-goals / Dependencies for the share-link caveat).

## Users

Authenticated players opening the launcher after login (currently gated by
`showChooseGameType && authToken` in `frontend/src/App.tsx`).

## Modal information architecture

### A. Header — realtime counts (from 003)

A single line, e.g.:

```
[ 53 People Online, 23 Are Playing ]
```

- Driven by `usePresence()` → `{ online, playing }` (task 003, realtime over
  the WS transport from task 002).
- States: **loading** (counts not yet received → skeleton/spinner, neutral
  copy like "Connecting…"), **live**, **stale** (WS disconnected → last-known
  counts dimmed + small spinner; never blank), **zero** (`online === 0` is a
  valid live value, not an error).

### B. Toggle box (top, smaller)

Two mutually-exclusive segment buttons:

- `Play with AI`
- `Play with a Elo-Matched Human` ← verbatim per umbrella spec (keep the
  article "a" as written by the spec; **OPEN** below flags the grammar).

This toggle sets the modal's **primary intent** and decides which of the six
stacked buttons are emphasized/enabled (see routing). It is a fast path:
"Play with AI" focuses the four AI buttons; "Play with a Elo-Matched Human"
focuses the two human buttons and reveals the Timed-Game checkbox.

### C. Six stacked buttons (75% width, vertical)

Exact labels (verbatim, do not reword):

1. `I'd like to play another human with a higher Elo score than me`
1. `I'd like to play another human with a lower Elo score than me`
1. `I'd like to play vs a computer on Easy Mode`
1. `I'd like to play vs a computer on Intermediate Mode`
1. `I'd like to play vs a computer on Hard Mode`
1. `I'd like to play vs a computer on Hardest Mode (Premium Game: $1 — Play for Free during Beta Testing)`

### D. Timed-Game checkbox (human games only)

- Label: `Timed Game` with helper text `15s per move, 5 min draw clock`.
- Visible/active only for the human path (buttons 1–2).
- The boolean it produces is **passed through** to the matchmaking entrypoint;
  timer semantics are owned by task 009.

### E. No-humans-available fallback

When matchmaking (004) reports no eligible opponents:

```
No available human players are currently available.
Would you like to try the AI?
```

…followed by the four AI buttons (3–6). Reachable two ways:
(a) proactively, if presence shows `playing/online` implies nobody matchable,
or (b) reactively, after a human button returns a `no-humans` result from 004.
This slice renders the panel; 004 decides _when_ "no humans" is true.

## Button → flow routing table

| # | Button label (abbrev) | Intent | Hands off to (owner) |
|---|------------------------------|------------------|-------------------------------------------------------|
| 1 | …higher Elo than me | human, `above` | matchmaking `above` (004) → ready/color handshake (005) |
| 2 | …lower Elo than me | human, `below` | matchmaking `below` (004) → ready/color handshake (005) |
| 3 | computer Easy | ai, `easy` | AI difficulty start (008) |
| 4 | computer Intermediate | ai, `intermediate`| AI difficulty start (008) |
| 5 | computer Hard | ai, `hard` | AI difficulty start (008) |
| 6 | computer Hardest (Premium) | ai, `hardest` | AI difficulty start (008) |

The toggle box's `Play with a Elo-Matched Human` button is shorthand for the
default human intent: it routes to matchmaking with mode `closest-elo` (004),
distinct from the explicit `above`/`below` of buttons 1–2.

Timed checkbox value rides along with buttons 1, 2, and the toggle's human
path. AI buttons ignore it.

## Dependencies

- **003 — Presence:** `usePresence()` → `{ online, playing, status }`. Header
  counts + the zero/stale signals.
- **004 — Elo matchmaking:** the matchmaking entrypoint (hook or WS request)
  taking `{ mode: 'closest-elo' | 'above' | 'below', timed: boolean }`,
  resolving to a match proposal or a `no-humans` outcome → triggers fallback.
- **005 — Ready/color handshake:** the post-match "Ready?" + color modal.
  This modal hands the match proposal off to 005 and closes itself.
- **008 — AI difficulty:** the AI start entrypoint taking a difficulty key
  (`easy|intermediate|hard|hardest`). 008 maps key→engine and wires backend.
- **009 — Timed games:** owns timer semantics; this slice only renders the
  checkbox and forwards its boolean.

## Non-goals

- Presence data source / WS protocol (003/002).
- Matchmaking algorithm, mode semantics, no-humans determination (004).
- The Ready/color negotiation modal itself (005).
- AI engine selection / backend wiring / premium billing for Hardest (008).
- Timer countdown, per-move enforcement, draw-clock logic (009).
- The legacy manual-invite `/play/<code>` generation and the guest color
  picker — **retired** by this redesign. **Caveat:** if 004/005/006 still
  want a shareable direct-invite link, it returns as a secondary affordance
  (e.g. a "Share a private link" disclosure), not the primary flow. This
  slice assumes retirement and notes the seam (see plan **OPEN:**).
