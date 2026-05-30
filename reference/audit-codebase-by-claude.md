# Gomoku Codebase Analysis

**Date:** 2026-04-04
**Scope:** Full repository — C game engine, Python API, React frontend, infrastructure/deployment

______________________________________________________________________

## Table of Contents

1. [Executive Summary](#executive-summary)
1. [C Game Engine (gomoku-c/src/)](#c-game-engine)
1. [Python API (api/)](#python-api)
1. [React Frontend (frontend/)](#react-frontend)
1. [Infrastructure & Deployment](#infrastructure--deployment)
1. [Cross-Cutting Concerns](#cross-cutting-concerns)
1. [Prioritized Remediation Plan](#prioritized-remediation-plan)

______________________________________________________________________

## Executive Summary

| Component | Critical | High | Medium | Low | Total |
| -------------- | -------- | ------ | ------ | ------ | ------- |
| C Engine | 1 | 4 | 10 | 5 | 20 |
| Python API | 2 | 2 | 13 | 9 | 26 |
| Frontend | 0 | 7 | 13 | 12 | 32 |
| Infrastructure | 2 | 10 | 23 | 1 | 36 |
| **Total** | **5** | **23** | **59** | **27** | **114** |

The codebase has five critical issues requiring immediate attention: a hardcoded JWT secret committed to version control, a permissive CORS wildcard policy combined with `allow_credentials=True`, buffer overflow vectors in the C engine, an unvalidated HTTP request body size in the C HTTP daemon, and a remote script download executed without integrity verification.

______________________________________________________________________

## C Game Engine

### Critical

#### C-01: Unvalidated HTTP Request Body Size — DoS Vector

- **File:** `gomoku-c/src/net/handlers.c:263-272`
- **Issue:** `http_request_body(request)` returns a body with no enforced maximum size. The subsequent `malloc(body.len + 1)` allocates whatever the client sends. A multi-gigabyte JSON payload causes OOM or resource exhaustion.
- **Fix:** Enforce a maximum body size (e.g. 64 KB) before allocation.

### High

#### C-02: Race Condition in Transposition Table

- **File:** `gomoku-c/src/gomoku/game.c:609-648`
- **Issue:** `store_transposition()` and `probe_transposition()` read/write the shared `transposition_table[][]` without any locking. The HTTP server is multi-threaded, so concurrent game requests corrupt the table.
- **Fix:** Add a mutex around transposition table access, or make the table thread-local.

#### C-03: Buffer Overflow via `strcpy()`

- **File:** `gomoku-c/src/gomoku/game.c:383`
- **Issue:** `strcpy(game->ai_history[i], game->ai_history[i + 1])` copies between fixed 50-byte buffers. If any history entry exceeds 49 characters, this overflows.
- **Fix:** Replace all `strcpy()` with `strncpy()` or `snprintf()`.

#### C-04: Replay Data — Unvalidated Board Coordinates

- **File:** `gomoku-c/src/gomoku/main.c:131`
- **Issue:** `game->board[move->x][move->y] = move->player` — coordinates loaded from JSON replay files are not bounds-checked against `board_size`. A malformed replay causes out-of-bounds write.
- **Fix:** Validate `0 <= x < board_size && 0 <= y < board_size` before board access.

#### C-05: Signal Handler Calls Async-Unsafe Functions

- **File:** `gomoku-c/src/net/main.c:256-262`
- **Issue:** The signal handler invokes `LOG_*()` macros which likely call `fprintf()` and allocate memory. Only `sig_atomic_t` writes are safe in signal handlers.
- **Fix:** Set a flag only; move logging to the main loop.

### Medium

#### C-06: `atoi()` Used Without Validation

- **Files:** `gomoku-c/src/gomoku/cli.c:97,142,150`, `gomoku-c/src/gomoku/game.c:49-69`
- **Issue:** `atoi()` returns 0 on parse failure, which is a valid value. Invalid input like `--depth abc` silently becomes depth 0.
- **Fix:** Use `strtol()` with proper error checking.

#### C-07: Stack-Allocated `candidate[19][19]` Assumes Max Board Size

- **Files:** `gomoku-c/src/gomoku/ai.c:101`, `gomoku-c/src/gomoku/game.c:442`
- **Issue:** Hardcoded 19x19 stack buffer. If board_size ever exceeds 19, stack corruption occurs.
- **Fix:** Add a compile-time or runtime assertion that `board_size <= 19`.

#### C-08: Integer Overflow Risk in Board Allocation

- **File:** `gomoku-c/src/gomoku/board.c:19`
- **Issue:** `malloc(size * sizeof(int *))` — on 32-bit systems, large `size` values could cause integer overflow producing a small allocation.
- **Fix:** Check for overflow before malloc: `if (size > SIZE_MAX / sizeof(int *))`.

#### C-09: Daemon `umask(0)` Sets World-Readable Permissions

- **File:** `gomoku-c/src/net/main.c:317`
- **Issue:** `umask(0)` means log files and any created files are world-readable/writable.
- **Fix:** Use `umask(0077)`.

#### C-10: Memory Leaks in JSON Error Paths

- **File:** `gomoku-c/src/net/json_api.c:159-167`
- **Issue:** Some error paths free `root` but not partially-initialized game structures.
- **Fix:** Audit all error paths for complete cleanup.

#### C-11: Unchecked `setsockopt()` Return Value

- **File:** `gomoku-c/src/net/main.c:51,179`
- **Issue:** Socket option calls don't check return values.
- **Fix:** Check return and log on failure.

#### C-12: Partial Write Not Retried

- **File:** `gomoku-c/src/net/main.c:153`
- **Issue:** `write(client_fd, status, strlen(status))` checks for error but doesn't handle partial writes.
- **Fix:** Loop until all bytes are written or error.

#### C-13: File Path Traversal in JSON Save

- **File:** `gomoku-c/src/gomoku/game.c:978`
- **Issue:** `fopen(filename, "w")` with no path validation. Untrusted filename could write to arbitrary paths.
- **Fix:** Validate filename doesn't contain `..` or absolute paths.

#### C-14: `fprintf()` Return Not Checked

- **File:** `gomoku-c/src/gomoku/game.c:986`
- **Issue:** File write failures are silent.

#### C-15: Race Condition Between Signal Handler and Main Thread

- **File:** `gomoku-c/src/net/main.c:27,103,144`
- **Issue:** `running` flag read without synchronization; `handlers_is_busy()` called from handler thread without mutex.
- **Fix:** Use proper atomic operations or mutex.

### Low

#### C-16: `notation_to_coord()` Silent Parse Failures

- **File:** `gomoku-c/src/gomoku/game.c:49-69`

#### C-17: Hardcoded `interesting_moves[361]` Array Size — RESOLVED

- **File:** `gomoku-c/src/gomoku/game.c:139`
- **Resolution:** The `interesting_moves[]` cache was removed. It was
  populated by `update_interesting_moves()` after every stone placement
  but never consumed by any production code path — `generate_moves_optimized()`
  in `ai.c` is the only live move generator and it scans the board directly
  from `game->board[]`. Removing the cache eliminated the hardcoded `[361]`
  size assumption along with it.

#### C-18: No Null-Termination Guarantee After `strncpy()`

- **File:** `gomoku-c/src/gomoku/game.c:1043`

#### C-19: JSON File Read Has No Size Limit

- **File:** `gomoku-c/src/gomoku/game.c:1006`

#### C-20: Compiler Warning Suppression `-Wno-gnu-folding-constant`

- **File:** `gomoku-c/Makefile:16`

______________________________________________________________________

## Python API

### Critical

#### API-01: Hardcoded JWT Secret Committed to Repository

- **File:** `api/.env` (line 1-4)
- **Issue:** Real production JWT secret is checked into version control:
  ```
  JWT_SECRET=77cbdc3ee7102cc156c67d549c849aec565da4a911e6dc9308a7b52a3dc1c1e4
  ```
  Additionally, `api/app/config.py:20` has a fallback default `"change-me-in-production"`.
- **Impact:** Complete authentication bypass — anyone with repo access can forge valid tokens.
- **Fix:** Remove `.env` from git tracking immediately. Add to `.gitignore`. Rotate the secret. Make `jwt_secret` a required field with no default.

#### API-02: CORS Wildcard + Credentials = CSRF

- **File:** `api/app/config.py:25`, `api/app/main.py:39-45`
- **Issue:** `cors_origins: list[str] = ["*"]` combined with `allow_credentials=True` violates the CORS specification and enables cross-site request forgery from any origin.
- **Fix:** Specify exact allowed origins. Never combine `*` with `allow_credentials=True`.

### High

#### API-03: Bare Exception in Game Engine Proxy

- **File:** `api/app/routers/game.py:20-30`
- **Issue:** `except Exception:` swallows all errors without logging. Connection timeouts, DNS failures, and bugs all appear as "Game engine unavailable."
- **Fix:** Log the exception. Consider catching `httpx.HTTPError` specifically.

#### API-04: Hardcoded Password Reset URL

- **File:** `api/app/services/email.py:8`
- **Issue:** `reset_url = f"https://gomoku.games/reset-password?token={token}"` is not configurable. Deployments on other domains break silently.
- **Fix:** Use a config setting for the frontend base URL.

### Medium

#### API-05: Silent JWT Decode Failure in Logging Middleware

- **File:** `api/app/middleware/request_logging.py:29-39`
- **Issue:** `except jwt.PyJWTError: pass` — all JWT errors silently ignored. No audit trail for malformed or forged tokens.
- **Fix:** Log the failure at WARNING level.

#### API-06: Email Service Has No Error Handling

- **File:** `api/app/services/email.py:22-43`
- **Issue:** SendGrid HTTP request has no try/except, no retry, no response checking. If sending fails, the user never gets their reset email and nobody knows.
- **Fix:** Add error handling, check response status, log failures.

#### API-07: Weak Password Requirements

- **File:** `api/app/models/user.py:28-33`
- **Issue:** Only 7-character minimum, no complexity requirements. Passwords like `"1234567"` are accepted.
- **Fix:** Increase to 12+ characters, require mixed case/digits.

#### API-08: No Rate Limiting on Any Endpoint

- **Files:** All routers
- **Issue:** No rate limiting middleware. Enables brute-force login attempts, password reset spam, and resource exhaustion.
- **Fix:** Add rate limiting (e.g. `slowapi` or Cloud Run concurrency limits).

#### API-09: Debug Logging Enabled by Default

- **File:** `api/app/logger.py:49`
- **Issue:** `root.setLevel(logging.DEBUG)` in production code. Debug logs can leak sensitive data.
- **Fix:** Default to INFO; use env var to control.

#### API-10: X-Forwarded-For Blindly Trusted

- **File:** `api/app/middleware/client_ip.py:14-21`
- **Issue:** Header is trusted without validating that the request came through a known proxy. IPs can be trivially spoofed.
- **Fix:** Only trust X-Forwarded-For behind a known proxy (Cloud Run does this correctly, but the code doesn't validate).

#### API-11: No Input Validation on `game_json`

- **File:** `api/app/routers/game.py:48-87`
- **Issue:** `body.game_json` is an arbitrary dict accepted without schema validation or size limits. Negative depths, huge move lists, and garbage data are all accepted and stored.
- **Fix:** Validate game_json against a schema. Add size limits.

#### API-12: Password Reset Token Race Condition

- **File:** `api/app/routers/auth.py:82-104`
- **Issue:** SELECT then UPDATE on the reset token is not atomic. Two simultaneous requests with the same token could both succeed.
- **Fix:** Use `UPDATE ... RETURNING` in a single statement, or add a row lock.

#### API-13: Missing Security Headers

- **Files:** All routers
- **Issue:** No HSTS, X-Frame-Options, X-Content-Type-Options, Content-Security-Policy headers.
- **Fix:** Add security headers middleware.

#### API-14: Global Mutable Database Pool State

- **File:** `api/app/database.py:5-21`
- **Issue:** Global `pool` variable is not thread-safe for concurrent startup/shutdown.

#### API-15: No Size Limit on Request Bodies

- **File:** `api/app/routers/game.py:55`
- **Issue:** game_json has no maximum size. A 1 GB payload exhausts memory.
- **Fix:** Add request body size limit middleware.

#### API-16: Incomplete Transaction in Game Save

- **File:** `api/app/routers/game.py:91-117`
- **Issue:** The transaction wraps INSERT + UPDATE, but if the UPDATE fails, the INSERT may have already committed depending on the error type.

#### API-17: Client IP Not Validated as IP Address

- **File:** `api/app/middleware/client_ip.py:17`
- **Issue:** Extracted IP string is stored without validating it's a valid IPv4/IPv6 address.

### Low

#### API-18: Stack Traces Exposed in Error Details

- **File:** Various error handlers
- **Issue:** Some error responses may leak internal paths and stack traces.

#### API-19: Test Database Isolation Issues

- **File:** `api/tests/conftest.py:84-86`
- **Issue:** Table truncation in cleanup; if a test fails, leftover data affects subsequent tests.

#### API-20: No Tests for Email Service

- **File:** `api/app/services/email.py`

#### API-21: No Tests for Concurrent Request Handling

#### API-22: No Negative/Fuzzing Test Cases (SQL injection, XSS in game_json)

#### API-23: `.env.ci` Contains Predictable Secret

- **File:** `api/.env.ci:3`

#### API-24: `pretty_exceptions_enable=True` in CLI

- **File:** `api/app/cli/main.py:17`

#### API-25: Alembic References `.venv/bin/ruff` — Path May Not Exist

- **File:** `api/alembic.ini:89`

#### API-26: No Environment-Based Configuration (dev/staging/prod)

- **File:** `api/app/config.py`

______________________________________________________________________

## React Frontend

### High

#### FE-01: Stack Traces Leaked in Error Messages

- **File:** `frontend/src/components/AuthModal.tsx:100,151`
- **Issue:** `err.stack` is passed to `showError()` as the detail parameter. Stack traces expose internal file paths and code structure to users.
- **Fix:** Use only `err.message` in user-facing error details.

#### FE-02: Silent Fetch Failures Throughout App

- **Files:** `frontend/src/App.tsx:60-68,86-100,155-175`
- **Issue:** Multiple `.catch(() => {})` handlers silently swallow all network errors. Users never learn that requests failed.
- **Fix:** Show error feedback or at minimum log to console.

#### FE-03: Race Condition in Session Expiry Handler

- **File:** `frontend/src/App.tsx:71-75,164-165`
- **Issue:** `handleSessionExpired` can be called simultaneously from multiple async chains on 401. Multiple invocations cause competing state updates.
- **Fix:** Use a ref/flag to ensure single invocation per expiry event.

#### FE-04: Race Condition in AI Response Handling

- **File:** `frontend/src/hooks/useGameState.ts:106-150`
- **Issue:** The `sendToServer` function retries with exponential backoff in an infinite loop. If the user makes rapid moves, stale responses may be processed out of order.
- **Fix:** Add a request ID or AbortController per move to discard stale responses.

#### FE-05: Missing Abort Signals on All Fetch Calls

- **Files:** `frontend/src/App.tsx:494-497`, `frontend/src/components/LeaderboardModal.tsx:30-37`, `frontend/src/components/PreviousGames.tsx:30-40`
- **Issue:** No AbortController or timeout on any fetch call. If the component unmounts or the API hangs, state updates on unmounted components cause memory leaks and React warnings.
- **Fix:** Add AbortSignal with reasonable timeouts (5-10s for data, 60s+ for game moves).

#### FE-06: No Error Boundary

- **File:** `frontend/src/App.tsx`
- **Issue:** No React ErrorBoundary wrapping the application. Any unhandled throw in a component crashes the entire app with a blank screen and no recovery.
- **Fix:** Add an ErrorBoundary with a fallback UI.

#### FE-07: Global Alert Dispatch Reference Leak

- **File:** `frontend/src/components/AlertPanel.tsx:12-13,49-52`
- **Issue:** `globalDispatch` is a module-level variable. If AlertPanel remounts, the old dispatch persists, sending alerts to a stale component.
- **Fix:** Use React Context instead.

### Medium

#### FE-08: Unvalidated API Response Data

- **File:** `frontend/src/App.tsx:64-66,96-98`
- **Issue:** API responses are destructured with `?? 0` defaults but no shape validation. Unexpected response structures fail silently.

#### FE-09: Modal Accessibility — No Focus Trap or Escape Handling

- **Files:** `frontend/src/components/AuthModal.tsx`, `LeaderboardModal.tsx`, `PreviousGames.tsx`
- **Issue:** Modals don't trap keyboard focus and don't close on Escape. Screen reader users cannot navigate properly.

#### FE-10: `setAnalyticsUser` Called During Render

- **File:** `frontend/src/App.tsx:42`
- **Issue:** Side effect called during render phase instead of in `useEffect`.

#### FE-11: Timer Continues After Game Ends

- **File:** `frontend/src/components/GameStatus.tsx:61-66`
- **Issue:** `setTick` interval runs every second even during 'idle' or 'gameover' phases.

#### FE-12: Silent Download Failure

- **File:** `frontend/src/components/PreviousGames.tsx:59-61`
- **Issue:** `.catch` silently ignores download errors.

#### FE-13: Coordinate System Union Type Creates Runtime Burden

- **File:** `frontend/src/types.ts:7-8`
- **Issue:** `MoveCoord = string | [number, number]` — backward-compat union type requires runtime type checking throughout codebase.

#### FE-14: Hardcoded Magic Numbers for Timeouts

- **File:** `frontend/src/hooks/useGameState.ts:163,212,143`
- **Issue:** Unexplained numbers like `+ 5000`, `30_000`, `60_000` scattered without constants or comments.

#### FE-15: Missing Input Debouncing

- **File:** `frontend/src/components/SettingsPanel.tsx:28-32,44-48`

#### FE-16: Insecure Frontend Password Validation

- **File:** `frontend/src/components/AuthModal.tsx:75-76`
- **Issue:** 7-character minimum with no complexity check.

#### FE-17: Inefficient JSON Stringification

- **File:** `frontend/src/components/JsonDebugModal.tsx:133-137`
- **Issue:** `JSON.stringify` called on every render without memoization.

#### FE-18: localStorage Keys Not Centralized

- **File:** `frontend/src/App.tsx:29-30`

#### FE-19: Timezone Display Issues

- **File:** `frontend/src/components/PreviousGames.tsx:133-137`
- **Issue:** `toLocaleDateString()` uses browser timezone but backend stores UTC. Could show wrong date.

#### FE-20: Board Recalculates All Memos on Every Render

- **File:** `frontend/src/components/Board.tsx:44-74,76-132`
- **Issue:** All `useMemo` calls depend on full `board` array — even unchanged boards trigger recalculation.

### Low

#### FE-21: Missing React.memo on Stable Components

- **Files:** `SettingsPanel.tsx`, `AboutModal.tsx`, `RulesModal.tsx`

#### FE-22: No Client-Side Logging Infrastructure

#### FE-23: Button Styles Repeated Without Component Extraction

#### FE-24: Color Values Hardcoded Instead of Themed

- **Files:** `AlertPanel.tsx:32-35`, `LeaderboardModal.tsx:100-103`

#### FE-25: No Loading Skeleton UI (just "Loading..." text)

#### FE-26: No Rate Limiting on Form Submissions

#### FE-27: Missing Alt Text on Some Images

#### FE-28: Test Coverage Gaps — Only 2-3 Test Files

- **File:** `frontend/src/__tests__/`
- **Issue:** Critical game logic in `useGameState`, board interaction, API error handling, and auth flow are all untested.

______________________________________________________________________

## Infrastructure & Deployment

### Critical

#### INFRA-01: Real JWT Secret Committed to Git

- **File:** `api/.env`
- **Issue:** Production-grade secret `77cbdc3e...` is in version control. Even after removal, it remains in git history.
- **Fix:** Remove from git, add `.env` to `.gitignore`, rotate the secret immediately, consider `git filter-branch` or BFG to remove from history.

#### INFRA-02: Remote Script Download Without Integrity Check

- **File:** `bin/gctl:11,125`
- **Issue:** `bash -c "$(curl -fsSL https://bashmatic.re1.re); bashmatic-install -q -l"` downloads and executes arbitrary code. A compromised DNS or MITM attack gives an attacker full control.
- **Fix:** Pin to a known version, verify checksum, or vendor the dependency.

### High

#### INFRA-03: All Containers Run as Root

- **Files:** `api/Dockerfile`, `frontend/Dockerfile`, `gomoku-c/Dockerfile`
- **Issue:** No `USER` directive in any Dockerfile. Container compromise = root access.
- **Fix:** Add a non-root user and switch to it after build steps.

#### INFRA-04: CORS Wildcard in Terraform Variables

- **File:** `iac/cloud_run/variables.tf:50`
- **Issue:** `default = ["*"]` — production inherits wildcard CORS if not explicitly overridden.

#### INFRA-05: Docker Images Always Use `:latest` Tag

- **Files:** `iac/cloud_run/deploy.sh:41,46`, `iac/cloud_run/update.sh:16,24`
- **Issue:** No versioned tags. Impossible to rollback to a known-good version.
- **Fix:** Tag images with git SHA or semantic version.

#### INFRA-06: Command Injection Risk in `gctl`

- **File:** `bin/gctl:461-466`
- **Issue:** `JWT_SECRET=${SECRET}` used in `nohup bash -c "..."` without quoting. Shell special characters in SECRET break the command or inject arbitrary code.
- **Fix:** Quote all variable expansions: `JWT_SECRET='${SECRET}'`.

#### INFRA-07: `set +e` Disables Error Handling in Main Script

- **File:** `bin/gctl:2`
- **Issue:** Entire script runs without `set -e`. Critical failures (failed builds, failed deploys) are silently ignored.
- **Fix:** Use `set -euo pipefail` at the top.

#### INFRA-08: Unsafe `eval` in `.envrc` Files

- **Files:** `.envrc:11`, `api/.envrc:15`
- **Issue:** `eval "$(cat .env | sed ... | tr -d '\n')"` — if `.env` contains shell metacharacters (backticks, `$(...)`, semicolons), they execute.
- **Fix:** Use `dotenv` or `direnv`'s built-in `dotenv` command.

#### INFRA-09: Force Push Tags in Justfile

- **File:** `justfile:77`
- **Issue:** `git push --tags --force || true` silently overwrites remote tags and suppresses errors.
- **Fix:** Remove `--force` and `|| true`.

#### INFRA-10: Missing Security Headers in nginx.conf

- **File:** `frontend/nginx.conf`
- **Issue:** No `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`, `Content-Security-Policy` headers.

#### INFRA-11: API Dockerfile HEALTHCHECK Variable Interpolation Bug

- **File:** `api/Dockerfile:23-24`
- **Issue:** `${PORT}` in `HEALTHCHECK CMD` is not interpolated — Docker's `HEALTHCHECK` does not use shell form by default.
- **Fix:** Use `HEALTHCHECK CMD ["sh", "-c", "..."]` or hardcode the port.

#### INFRA-12: `.secret` File Read Without Permission Check

- **File:** `bin/gctl:30`
- **Issue:** `cat .secret` reads plaintext secret from filesystem with no file permission validation.

### Medium

#### INFRA-13: Missing Liveness/Readiness Probes in Cloud Run

- **File:** `iac/cloud_run/main.tf:70-79,145-154`
- **Issue:** Only `startup_probe` defined. No `liveness_probe` to detect stuck processes.

#### INFRA-14: Terraform State Bucket Has No Encryption Config

- **File:** `iac/cloud_run/main.tf:9-12`

#### INFRA-15: No Resource Labels/Tags on Cloud Run Services

- **File:** `iac/cloud_run/main.tf`

#### INFRA-16: GCP Project ID Committed to Repository

- **File:** `.env:2`

#### INFRA-17: `uv` Installer Not Version-Pinned in Dockerfile

- **File:** `api/Dockerfile:3`
- **Issue:** `COPY --from=ghcr.io/astral-sh/uv:latest` — builds are not reproducible.

#### INFRA-18: Base Images Use Minor Versions Only

- **File:** `frontend/Dockerfile:2,15`
- **Issue:** `node:20-alpine` and `nginx:1.27-alpine` — patch version changes could break builds.

#### INFRA-19: Hardcoded Backend IPs in Envoy Config

- **File:** `iac/local/envoy/envoy.yaml:90-188`

#### INFRA-20: High `max_pending_requests` Without Circuit Breaker

- **File:** `iac/local/envoy/envoy.yaml:58-64`

#### INFRA-21: 600s Proxy Timeout for Game Endpoint

- **File:** `frontend/nginx.conf:58`
- **Issue:** 10-minute timeout could be used for slowloris-style resource exhaustion.

#### INFRA-22: No Rate Limiting in nginx

- **File:** `frontend/nginx.conf`

#### INFRA-23: Missing Quotes in Shell Variable Expansion

- **File:** `bin/gctl:5`
- **Issue:** `$(cd $(dirname ...))` — unquoted `$(dirname ...)` breaks on paths with spaces.

#### INFRA-24: No Database Backup Strategy in Terraform

- **File:** `iac/cloud_run/main.tf`

#### INFRA-25: `disable_on_destroy = false` on GCP Services

- **File:** `iac/cloud_run/main.tf:23,27,31`

#### INFRA-26: Frontend Dockerfile Missing HEALTHCHECK

#### INFRA-27: `|| true` Suppresses Errors in Justfile Recipes

- **File:** `justfile:104`

______________________________________________________________________

## Cross-Cutting Concerns

### Secret Management

The repository has no unified secret management strategy. Secrets appear in `.env` files (committed), shell scripts (read from `.secret`), Terraform variables, and Docker environment variables. A secrets manager (GCP Secret Manager, Vault, etc.) should be adopted.

### Authentication Chain

The JWT authentication flows from API -> Frontend with a default-insecure secret. The token is stored in `sessionStorage` (good), but the password reset flow has a race condition, weak password requirements, and the reset URL is hardcoded.

### Input Validation

Input validation is inconsistent across all layers:

- C engine: `atoi()` without error checking, no body size limits
- Python API: `.get()` with defaults on untrusted dicts, no game_json schema validation
- Frontend: minimal validation, 7-char password minimum

### Error Handling

Each layer has a different failure mode:

- C engine: many unchecked return values, potential segfaults
- Python API: bare `except Exception:`, silent JWT failures, no email error handling
- Frontend: `.catch(() => {})` everywhere, no error boundary

### Test Coverage

- C engine: has GoogleTest framework but coverage unclear
- Python API: reasonable test structure but missing edge cases, no email tests, no fuzzing
- Frontend: only 2-3 test files, critical game logic untested

______________________________________________________________________

## Prioritized Remediation Plan

### Immediate (Do Today)

| ID | Action | Risk Mitigated |
| ----------------- | -------------------------------------------------------------- | --------------------- |
| API-01 / INFRA-01 | Remove `.env` from git, add to `.gitignore`, rotate JWT secret | Authentication bypass |
| API-02 | Set specific CORS origins, remove wildcard | CSRF attacks |
| C-01 | Add max body size check in HTTP handler | DoS |
| INFRA-02 | Vendor or pin bashmatic script with checksum | Supply chain attack |

### This Week

| ID | Action | Risk Mitigated |
| -------- | ------------------------------------------------ | -------------------- |
| INFRA-03 | Add non-root USER to all Dockerfiles | Container escape |
| C-02 | Add mutex to transposition table | Data corruption |
| C-03 | Replace all `strcpy()` with bounded alternatives | Buffer overflow |
| C-04 | Validate replay coordinates against board_size | OOB write |
| API-03 | Log exceptions in game proxy | Silent failures |
| API-06 | Add error handling to email service | Lost password resets |
| API-08 | Add rate limiting middleware | Brute force |
| INFRA-05 | Version-tag Docker images | Rollback capability |
| INFRA-06 | Quote all shell variables in `gctl` | Command injection |
| INFRA-07 | Set `set -euo pipefail` in scripts | Silent failures |
| INFRA-10 | Add security headers to nginx | XSS, clickjacking |

### Next Sprint

| ID | Action | Risk Mitigated |
| ------ | --------------------------------------------- | ------------------------ |
| API-05 | Log JWT decode failures | Security audit trail |
| API-07 | Strengthen password requirements | Weak credentials |
| API-09 | Default logging to INFO | Information leakage |
| API-11 | Validate game_json against schema | Data integrity |
| API-13 | Add security headers middleware | MITM, clickjacking |
| FE-01 | Remove stack traces from error messages | Information disclosure |
| FE-05 | Add AbortController to all fetch calls | Memory leaks |
| FE-06 | Add ErrorBoundary component | Crash recovery |
| C-05 | Remove async-unsafe calls from signal handler | Undefined behavior |
| C-06 | Replace `atoi()` with `strtol()` | Silent misconfigurations |

### Backlog

| ID | Action |
| ----------- | ------------------------------------------------------ |
| FE-09 | Modal accessibility (focus trap, Escape) |
| FE-28 | Expand frontend test coverage |
| API-20-22 | Expand API test coverage (email, concurrency, fuzzing) |
| INFRA-13 | Add liveness/readiness probes |
| INFRA-14 | Enable Terraform state encryption |
| INFRA-17-18 | Pin all Docker base image versions |
| INFRA-24 | Implement database backup strategy |
| C-08 | Integer overflow check on malloc |
| C-09 | Fix daemon umask |
