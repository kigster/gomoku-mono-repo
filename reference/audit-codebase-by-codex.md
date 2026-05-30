# Codex Codebase Analysis

## Scope and Method

This review focused on the most important execution paths in the repo:

- C engine and HTTP daemon under `gomoku-c/src`
- FastAPI backend under `api/app`
- React frontend under `frontend/src`
- Local orchestration script `bin/gctl`

I prioritized concrete failure modes over style complaints. I did not run the full test suite because the local environment is missing Python dependencies (`python3 -m pytest api/tests/...` currently fails with `ModuleNotFoundError: asyncpg`).

## Findings

### 1. Critical: the backend trusts client-submitted game state, so leaderboard scores are forgeable

Files:

- `api/app/routers/game.py:47-119`
- `gomoku-c/src/net/json_api.c:275-357`
- `gomoku-c/src/gomoku/game.c:179-230`

Why this is a bug:

- `/game/save` accepts arbitrary `game_json` from the browser and computes `winner`, `depth`, `radius`, move times, and final score directly from that client payload.
- The server does not verify that the submitted move list came from a real `/game/play` session.
- The C replay path also accepts moves as long as the target square is empty. `make_move()` never checks that the submitted `player` matches `game->current_player`, so illegal histories like “X moves twice in a row” are accepted.

Practical impact:

- Any authenticated user can manufacture a fake “I beat depth 6 instantly” payload and write inflated scores into `games`.
- Historical game JSON cannot be treated as trustworthy audit data.
- If this leaderboard is public, a bored script kiddie can turn it into performance art.

Recommended fix:

- Stop treating browser-submitted game history as authoritative.
- Issue a server-side game/session id at game start, persist authoritative move state server-side, and validate each save against that state.
- At minimum, reject non-alternating move order and impossible winners in the replay path.

### 2. High: `/game/play` drops upstream status codes and can convert engine failures into misleading 200s or backend 500s

Files:

- `api/app/routers/game.py:15-31`
- `frontend/src/api.ts:53-74`

Why this is a bug:

- The FastAPI proxy always returns `resp.json()` and never checks `resp.status_code`.
- If `gomoku-httpd` returns a JSON error with `400`, `500`, or `503`, the API route will still respond with HTTP 200 and hand the frontend a shape that is not a `GameState`.
- If the upstream returns malformed JSON or a non-JSON body, `resp.json()` will raise and produce an unhandled 500 from the API.

Practical impact:

- The frontend retry logic only retries on actual HTTP 503. The proxy currently destroys that contract.
- Busy/invalid-engine responses can leak into the UI as bogus successful game states.
- Debugging production incidents gets harder because the proxy lies about who failed.

Recommended fix:

- Preserve upstream status codes and body shape.
- Validate that successful upstream responses are valid game-state JSON before returning 200.
- Convert malformed upstream responses into a controlled `502 Bad Gateway`.

### 3. High: password reset token issuance is not atomic and does not verify email delivery

Files:

- `api/app/routers/auth.py:62-78`
- `api/app/services/email.py:19-43`

Why this is a bug:

- The code inserts a reset token into the database before attempting delivery.
- The SendGrid branch does not call `raise_for_status()` and does not inspect the response at all.
- Network errors will bubble out as 500s after the token has already been created; non-2xx SendGrid responses will silently pretend success.
- The code also leaves all prior unexpired tokens valid; requesting a new email does not invalidate older reset links.

Practical impact:

- Users can be told a reset email was sent when it was not.
- The database accumulates valid orphan tokens for undelivered emails.
- Multiple valid reset links for the same account expand the attack surface unnecessarily.

Recommended fix:

- Wrap token invalidation/creation in a transaction.
- Invalidate older unused tokens for that user before issuing a new one.
- Check provider responses explicitly and decide whether to retry, surface a 503, or enqueue delivery asynchronously.

### 4. High: password reset confirmation has a race that allows the same token to be consumed concurrently

File:

- `api/app/routers/auth.py:81-102`

Why this is a bug:

- The handler reads a valid token first, outside the transaction.
- Only later does it mark the token as used.
- Two concurrent requests can both pass the `SELECT ... WHERE NOT used` check before either transaction flips `used=true`.

Practical impact:

- A single token can reset the same account multiple times in a race.
- The final password becomes “whoever committed last,” which is exactly the kind of nonsense you do not want in auth flows.

Recommended fix:

- Consume the token atomically with a single `UPDATE ... WHERE token = $1 AND NOT used AND expires_at > now() RETURNING ...`.
- Perform the password update only if that `UPDATE ... RETURNING` succeeds.

### 5. Medium: the API cannot start unless the database is healthy, which also takes down `/health` and static asset serving

Files:

- `api/app/main.py:21-31`
- `api/app/database.py:8-23`

Why this is a design flaw:

- `lifespan()` eagerly creates the database pool before the app starts serving.
- If Postgres is down, the whole FastAPI process fails startup, including endpoints that do not require the database.

Practical impact:

- `/health` becomes useless for distinguishing “API process is alive” from “database is down.”
- Static frontend serving also dies if Postgres is unavailable.
- This increases blast radius during partial outages.

Recommended fix:

- Make health/readiness more granular.
- Start the app even if Postgres is temporarily unavailable, and fail DB-backed routes/readiness separately.
- Consider lazy pool initialization with retry/backoff.

### 6. Medium: `X-Forwarded-For` is blindly trusted, so client IP data is trivially spoofable

Files:

- `api/app/middleware/client_ip.py:12-21`
- `api/app/routers/game.py:88-112`

Why this is a bug:

- Any client can supply `X-Forwarded-For`, and the middleware will trust the first value unconditionally.
- That value is later written into the database as `client_ip`.

Practical impact:

- IP-based auditing, abuse triage, and any future geo features become garbage.
- A direct client can impersonate arbitrary source IPs unless a trusted proxy strips and rewrites the header first.

Recommended fix:

- Only trust forwarded headers from known proxy hops.
- Otherwise use `scope["client"]`.
- If multiple deployment modes exist, make trusted proxy behavior explicit in config.

### 7. Medium: `bin/gctl` is a security and reliability footgun

File:

- `bin/gctl:1-2`
- `bin/gctl:10-12`
- `bin/gctl:153-159`
- `bin/gctl:177`

Why this is a design flaw:

- The script runs with `set +e`, so failures do not stop execution cleanly.
- On startup it may `curl` and execute a remote installer, then `source` downloaded shell code into the current process.
- `setup.sudo()` sets `/var/log` to mode `777` and log files to `666`, which is an ugly little gift basket of local privilege-abuse opportunities.
- Package installation failures are explicitly ignored with `|| true`.

Practical impact:

- Partial setup states are easy to create and hard to diagnose.
- Developer machines are asked to trust remote shell code at runtime.
- World-writable logs invite tampering and accidental breakage.

Recommended fix:

- Replace remote bootstrap-on-exec with documented installation prerequisites.
- Use `set -euo pipefail`.
- Create only the specific log directories needed, with minimal permissions.
- Stop ignoring package/setup failures.

### 8. Low/Medium: `App.tsx` performs analytics side effects during render

File:

- `frontend/src/App.tsx:33-43`

Why this is a bug:

- `setAnalyticsUser(playerName)` runs in the component body instead of an effect.
- React render is supposed to be pure; this code re-runs on every render while `playerName` is set.

Practical impact:

- Repeated analytics/user-context updates can create duplicate calls and hard-to-reason-about behavior.
- This becomes more brittle under Strict Mode or future refactors.

Recommended fix:

- Move this into a `useEffect(() => { ... }, [playerName])`.

### 9. Low/Medium: production defaults are unsafe enough to become deployment landmines

Files:

- `api/app/config.py:20-30`
- `api/app/main.py:39-45`

Why this is a design flaw:

- The default JWT secret is a known literal string: `"change-me-in-production"`.
- The default CORS config is `["*"]` while the middleware also enables `allow_credentials=True`, which is an easy configuration to misuse and hard to reason about safely.

Practical impact:

- A bad deployment can look “working” while quietly using insecure auth configuration.
- Security posture depends too much on remembering to override defaults perfectly.

Recommended fix:

- Fail startup if `jwt_secret` is unchanged outside development/test.
- Require explicit allowed origins in non-dev environments.

## Cross-Cutting Themes

1. The backend trusts browser input too much.
   Game results, move history, and client IP are all treated as more authoritative than they should be.

1. Failure semantics are inconsistent across layers.
   The frontend expects retryable 503s, the API proxy hides them, and email delivery does not distinguish transport failure from provider rejection.

1. Tooling favors convenience over containment.
   `bin/gctl` is trying to be magical, and magic shell scripts usually end the same way: with someone muttering at a terminal and blaming the moon.

## Highest-Value Fix Order

1. Fix score forgery by making game state authoritative on the server.
1. Repair `/game/play` proxy error propagation so the frontend can handle engine failures correctly.
1. Harden password reset issuance/consumption so delivery and token use are atomic enough.
1. Remove `bin/gctl` remote bootstrap behavior and world-writable log setup.
1. Introduce trusted-proxy handling for client IPs and safer production config validation.
