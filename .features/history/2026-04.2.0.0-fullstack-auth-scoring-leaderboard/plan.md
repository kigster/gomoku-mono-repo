# Plan — 2.0.0 Full-stack web app: auth, scoring, leaderboard

## Steps

1. **Stand up the API.** A web backend (Python) with a database for users, games,
   and scores. Authentication (signup/login, tokens).
2. **Keep the engine as an oracle.** The API proxies AI-move requests to
   `gomoku-httpd`; the C engine stays stateless and unchanged in role.
3. **Build the frontend.** A React/Vite SPA for play, with nav modals, responsive
   layout, and game history.
4. **Scoring + leaderboard.** Compute a score per completed game and expose a
   global ranking.
5. **Containerize the new services** and document the architecture (#63).
6. **Quality gates.** C99 test badge; recorded networked-game corpora.
7. Set `GAME_VERSION` to `2.0.0`, tag.

## Testing strategy

- API tests for auth, game persistence, and leaderboard correctness.
- Frontend tests for the play flow.
- End-to-end: register → play vs AI → game recorded → appears on leaderboard.

## Deviations from the code

Landing auth + scoring + leaderboard + a whole frontend in a single 349-file span
maximizes merge risk. The cleaner sequence ships the API + auth first (testable in
isolation), then scoring/leaderboard, then the SPA — three reviewable milestones
that still add up to 2.0. The single-PR approach trades reviewability for speed.
