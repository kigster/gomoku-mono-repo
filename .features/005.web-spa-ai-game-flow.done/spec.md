# Web SPA Human-vs-AI Game Flow

## Goal

Let an authenticated user play Gomoku against the C engine through a
React SPA at <https://app.gomoku.games>, with auth, scoring, leaderboard,
and persistent history. The browser only ever talks to the FastAPI
service; engine moves are proxied to a pool of stateless
`gomoku-httpd` workers behind envoy.

## Users and use cases

- **Casual players** who want to play in a browser without installing
  anything.
- **Returning players** who want to see their history, rating, and
  position on the global leaderboard.
- **Engine evaluators** who want a UI for trying different difficulty
  knobs without dropping into the TUI.

## Functional requirements

### Game lifecycle

1. Sign up or log in (JWT-based auth).
1. First-visit name prompt (non-secret) so headlines / leaderboard have
   something to address the user as.
1. Adjust difficulty if desired, click **Start Game** → SPA calls
   `POST /game/start` (increments started-games counter).
1. Each move: SPA `POST`s `/game/play` with the JSON game state; the
   API proxies to `gomoku-httpd`, returns the engine's move; SPA
   renders it.
1. On win / draw / resign: SPA `POST`s `/game/save`; server records the
   result, updates the user's Elo, returns the rating delta.

### Difficulty knobs

| Setting | Range | Meaning |
|---|---|---|
| AI Search Depth | 2–5 | Plies of alpha-beta. Web caps at 5 so a single move fits the per-move budget on a Cloud Run worker. |
| AI Search Radius | 1–4 | Candidate-move generator distance from existing stones. |
| AI Timeout | none / 30 / 60 / 120 / 300 s | Wall-clock cap per AI move. |
| Game Display | stones / X-O | Cosmetic. |
| Side | X (Black, first) / O (White) | If O, engine moves first. |

### Scoring and rating

- Elo rating updated immediately on game end, mirroring Gomocup
  parameters (`eloAdvantage=0`, `eloDraw=0.01`).
- Each AI tier (depth × radius) is modelled as a fixed-strength rated
  opponent.
- Legacy `score = 1000*depth + 50*radius + time_bonus(human_seconds)`
  is still written for backward compatibility but the leaderboard
  ranks by Elo.

### History and leaderboard

- **History** shows the user's most recent 100 games with score, date,
  depth/radius, times, opponent.
- Each row has a download icon returning the same JSON shape the TUI
  produces via `-j FILE` (drop-in for `bin/gomoku -p`).
- Leaderboard: top 100 AI games worldwide; explicitly excludes
  multiplayer games.

### Transport

- Pure short-poll request/response. No WebSockets. Same code path runs
  on Cloud Run, Fly, ECS, or a single VPS.

## Non-functional requirements

- A single AI move at depth 5 / radius 3 / no timeout returns in 1–4 s
  on a Cloud Run worker — the responsiveness ceiling. Higher knobs
  trade responsiveness for strength.
- Auth required on every endpoint except `/auth/*` and `/leaderboard`.

## Out of scope

- Multiplayer (covered separately).
- Replay-from-history in the browser (download + open in TUI).
- Mobile-first redesign.

## Cross-references

- Architecture and API surface: see `plan.md` in this folder.
- TUI equivalent: `.features/004.terminal-ai-game-binary.done/`.
- Multiplayer Elo design: `reference/gomocup-bayesian-elo-system.md`.
- Frontend specifics: `frontend/CLAUDE.md`.
