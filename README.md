[![C99 Test Suite](https://github.com/kigster/gomoku-mono-repo/actions/workflows/c99.yml/badge.svg)](https://github.com/kigster/gomoku-mono-repo/actions/workflows/c99.yml) [![API Tests](https://github.com/kigster/gomoku-mono-repo/actions/workflows/api-test.yml/badge.svg)](https://github.com/kigster/gomoku-mono-repo/actions/workflows/api-test.yml) [![API Lint](https://github.com/kigster/gomoku-mono-repo/actions/workflows/api-lint.yml/badge.svg)](https://github.com/kigster/gomoku-mono-repo/actions/workflows/api-lint.yml) [![Frontend Tests](https://github.com/kigster/gomoku-mono-repo/actions/workflows/frontend.yml/badge.svg)](https://github.com/kigster/gomoku-mono-repo/actions/workflows/frontend.yml)

# Gomoku (Five-in-a-Row)
Welcome to the monorepo that builds several kinds of Gomoku executables, adjacent features, testing clients, and Gomocup entry built for Win32/Win64. 

This monorepo contains of several components written in more than a few languages to create a multi-purpose Gomoku repository.By _multipurpuse_ we mean thst the following can be built after cloing the repo and running the setup:

> [!NOTE]
> 
> Tools required: given that there is a `Brewfile` at the root of the project, just running `brew bundle` will get you most of the Brew dependencies and tooling used on MacOSX. 

## The Components of the Mono Repo

1. A **Fast TUI Executable** `./bin/gomoku` compiles on any system that has a C99-compaatible compiler**, TTY Terminal Gomoku Game and the logic "brain". This module is what plays as "AI" against humans, and so it's written in C to optimize the performance. 

2. **Full Multi-User, User vs AI distributed Web Version with user accounts, persistence, and Elo-based score computation.**
  - This version reuses the AI from the TUI gomoku (above), but does not use any of the TTY UI functions
  - instead, the C side focuses on building a long-running daemon server: `gomoku-httpd` — a headless AI "brain" that responds to the JSON API (which gets validated by the JSON schema validator in `schema_validator` folder. 
  - A ReactJS SPA that uses `vite` in development, and `NextJS` build in the production, dumped into the `api/public` folder as static HTML/CSS/JS package.
  - That static content is served diligently by the multipurpose **FastAPI Python server**, which here it performs three-four main functions:
    1. it serves static assets including index.html and the SPA code
    2. it responds to a rich REST API to create and authenticate users, store their games, facilitate human on human games as well as human vs AI. It also responds to health checks to communicate to Google Cloud that all is good in the neighbourhood.
    3. it proxies the game related calls from ReactJS side (GET and POST to /game/*) to the `gomoku-httpd` backend that runs in it's own container, and is only booted when the game is initiated.
    4. In the close future, a user may chose to play against a much faster multi-core Rust implementation: [`gomoku-rust-httpd`](https://github.com/kigster/gomoku-rust-httpd) of the same game AI engine. When the executable has access to 10 vCPU cores, it runs nearly 10x faster that C-based binary. It's also has a few additinoal performance imrovements, so it's play may be somewhat different. Considering this will need access to some compute resouces, I may try to figure out how much such a game on a Docker conainer with 10x vCPUs cost, and turn that in a paid tier. It will still be only a few bucks a month to cover the costs, but that one might be worthwhile paying for.


  - that sits in gets deployed to a cloud and runs. Play online at **[gomoku.games](https://app.gomoku.games)**. You can play with another human, or you can play against the AI.

> [!IMPORTANT]
> 
> The public production URL will soon migrate to https://gomoku.us

  The distributed game architecture is much different than a single-binery TUI version:

  - A ReactJS frontend compiled into static HTML/CSS/JSS SPA (at least 1 container is always running)
  - A Python/Pydantic-based FastAPI backend, that uses `pg-async` library, and provides Alembic migrations, and a proper peristence mechanism
  - A C-based binary `gomoku-httpd` which, unlike `gomoku` has no UI and is meant to run as an httpd daemon. However, this service is very special in a sense that it's listening on a particular port. Each process can only handle a single move at a time, so you should run as many of those as you expect concurrent players (although putting envoy proxy in front of gomoku-httpd might help shrink it a litle bit). Google Run handles this automatically

3. [Gomocup](https://gomocup.org) compatible binaries are also provided, to engage in this competition.

> [!IMPORTANT]
>
> 4. There is a [Rust port of `gomoku-httpd`](https://github.com/kigster/gomoku-rust-httpd). This is the binary that works as a stateless C-based AI "brain" so to speak, and receive the entire game state as JSON. To make a move, a new move appended to the move list and the JSON returned to the called. The interfaces via HTTP and JSON uses JSON schema in the `config` folder of this repo.


## Going a bit Deeper

This monorepo ships **four ways to play** the same Gomoku engine, all backed by one C99 codebase under `gomoku-c/`:

| # | Mode | Where you play | Deep dive |
|---|---|---|---|
| 1 | Human vs AI in the terminal (TUI) | `bin/gomoku` on your machine | [doc/01-human-vs-ai-tui.md](doc/01-human-vs-ai-tui.md) |
| 2 | Human vs AI on the web | <https://app.gomoku.games> | [doc/02-human-vs-ai-web.md](doc/02-human-vs-ai-web.md) |
| 3 | Human vs Human on the web | Invite link, both players in browser | [doc/03-human-vs-human-web.md](doc/03-human-vs-human-web.md) |
| 4 | Gomocup tournament brain | `pbrain-kig-standard*.exe` submitted to <https://gomocup.org/> | [doc/04-gomocup-submission.md](doc/04-gomocup-submission.md) |

The sections that follow give a one-paragraph orientation for each. Click through to the linked doc for the long form.

### 1. Human vs AI in the Terminal (TUI)

A single ANSI-coloured C99 binary (`bin/gomoku`) with **zero runtime dependencies**. 

- Arrow keys to move, `Space`/`Enter` to place,
`u` to undo, `q` to quit. 

- Strength pf play is controlled by `--depth`
(1–10 plies of alpha-beta look-ahead) and `--radius` (1–5 cells around existing stones the candidate generator considers); a wall clock cap is set with `--timeout`. Saves and replays games as JSON

- (`-j FILE` / `-p FILE`), including AI-vs-AI runs in headless mode

- (`-q`). Build with `just build-game`. Full CLI reference in

[doc/01-human-vs-ai-tui.md](doc/01-human-vs-ai-tui.md).

<img src="doc/img/gomoku-human-vs-ai.png" width="700" border="1" style="border-radius: 10px"/>

### 2. Human vs AI on the Web

A React SPA fronts the same C engine; FastAPI proxies each move to a pool of stateless `gomoku-httpd` workers behind envoy, while PostgreSQL holds users, history, and the leaderboard. The Settings panel exposes the same **depth** (2–5 in the web flow, capped to keep moves responsive) and **radius** (1–4) knobs as the TUI, plus an optional per-move **timeout** (30/60/120/300 seconds). Difficulty maps
straight to AI strength: depth 5 with radius 3 is the upper "competent club player" tier, and depth 2 is "novice". Wins update your Elo against the AI tier you played; losses cost you Elo symmetrically. Full flow, screenshots, and API list in availabable in this document: 
[doc/02-human-vs-ai-web.md](doc/02-human-vs-ai-web.md).

<img src="doc/img/gomoku-web-version.png" width="700" border="1" style="border-radius: 10px"/>

### 3. Human vs Human on the Web

Two authenticated users play each other over a shared 6-character invite link (`/play/AB7K3X`). The host generates the link from the **New Multiplayer Game** modal — both the URL and the bare code are copyable, and the host can either pick the colour up front or defer to the guest. Invites expire after **15 minutes**. 

#### Inplementation Note

There are no websockets (yet); both clients short-poll a single `multiplayer_games` row on a wall-clock-tiered cadence (300 ms for the first 10 min, then
2/3/5 s) with optimistic concurrency on a per-row version counter. Win/loss surfaces in-game and writes two cross-linked `games` rows that show up in both players' history. Multiplayer games rate against your **opponent's actual Elo** rather than an AI tier — see
[doc/03-human-vs-human-web.md](doc/03-human-vs-human-web.md).

<img src="doc/img/gomoku-web-menu.png" width="700" border="1" style="border-radius: 10px"/>

### 4. Gomocup Tournament Submission

`pbrain-kig-standard` is a Gomocup-protocol brain wrapping the same engine, targeting the **Standard** category at <https://gomocup.org/>, (15×15 board, exact five-in-a-row, overlines do not win). 

Native binary builds with `make pbrain-kig-standard`; cross-compiled Win64 and Win32 `.exe` files with `make gomocup-win`; submission ZIP with `make gomocup-zip`. Default search depth is 5, radius 3, with a 200 ms safety margin under the manager's deadline.

The brain links the engine with `-DNO_JSON` so it has zero dependencies. See
[doc/04-gomocup-submission.md](doc/04-gomocup-submission.md) for build, packaging, and submission detail.

### Rating system

All four modes feed into a unified rating system that mirrors **Gomocup's own**: [BayesElo](https://link.springer.com/chapter/10.1007/978-3-540-87608-3_11) with `eloAdvantage=0`, `eloDraw=0.01`, default prior — exactly the parameters Gomocup uses to rank submitted brains. AI tiers are first-class rated subjects (so a win against a depth-5 AI grants more rating than a win against depth-2),
and human-vs-human games rate against the opponent's actual Elo. A weekly batch job re-fits the entire history with BayesElo so live classical-Elo updates converge on the canonical numbers. Design and rollout in [doc/gomocup-elo-rankings.md](doc/gomocup-elo-rankings.md).

---

## 1. Build and Play the Terminal Game (TUI)

The terminal game is a standalone C99 binary with **zero runtime dependencies** — just a C compiler and Make.

### Build

```bash
# Using just (recommended)
just build-game

# Or directly with Make
make -C gomoku-c all install
```

This compiles three binaries into `bin/`:

| Binary | Purpose |
|---|---|
| `gomoku` | Interactive terminal game (ANSI color, arrow-key input) |
| `gomoku-httpd` | Stateless HTTP daemon for networked play |
| `gomoku-http-client` | CLI client for testing `gomoku-httpd` |

### Play

```bash
bin/gomoku                                    # Human (X) vs AI (O), depth 3
bin/gomoku -d 5                               # Harder AI (depth 5)
bin/gomoku -l hard                            # Same as -d 6
bin/gomoku -x ai -o ai -d 3:5                # AI vs AI, asymmetric depths
bin/gomoku -x ai -o ai -d 4 -q -j game.json  # Headless AI game, save to JSON
bin/gomoku -p game.json -w 0.5                # Replay saved game, 0.5s per move
bin/gomoku -b 19 -r 4 -t 60                  # 19x19 board, radius 4, 60s timeout
bin/gomoku -i                                 # Show threat hints (blink highlights)
```

### CLI Reference

```text
gomoku [options]

Gameplay:
  -b, --board 15|19    Board size (default: 15)
  -x, --player-x TYPE  human or ai (default: human)
  -o, --player-o TYPE  human or ai (default: ai)
  -u, --undo           Enable undo (default: on)
  -U, --undo-limit N   Max undo moves per game (default: 5, 0 = unlimited)
  -s, --skip-welcome   Skip the welcome screen
  -i, --hints          Highlight threatening patterns with blink
  -t, --timeout T      Seconds per move (AI picks best so far; human forfeits)

AI:
  -d, --depth N        Search depth 1-10 (or N:M for asymmetric)
  -l, --level M        easy (2), medium (4), hard (6)
  -r, --radius 1-5     Move generation radius (default: 3)

Recording:
  -j, --json FILE      Save game to JSON
  -p, --replay FILE    Replay a saved game
  -w, --wait SECS      Auto-advance replay (default: wait for keypress)
  -q, --quiet          Headless mode (AI vs AI, JSON output only)
  -h, --help           Show help
```

### AI Evaluations

```bash
just evals              # Run tactical tests + depth tournament
just eval-tactical      # Tactical position tests only
just eval-tournament    # AI vs AI depth tournament (depths 2,3,4)
just evals-ruby         # Ruby tournament against httpd cluster via envoy
```

See [doc/ai-engine.md](doc/ai-engine.md) for algorithm details and threat scoring.

---

## 2. Run the Networked Cluster Locally

> [!IMPORTANT]
> 
> This is how you might want to run the web version locally on your mac laptop.

The full stack runs on your dev machine: nginx for TLS, envoy for load balancing across a pool of `gomoku-httpd` workers, FastAPI for auth/scoring/leaderboard, and a Vite dev server for the React frontend.

### Prerequisites

| Dependency | Version | Purpose |
|---|---|---|
| C compiler (gcc/clang) | any | Build game engine |
| Make | any | Build system |
| [just](https://github.com/casey/just) | 1.0+ | Monorepo task runner |
| Python | 3.12+ | FastAPI backend |
| [uv](https://docs.astral.sh/uv/) | latest | Python package/venv manager |
| Node.js | 20+ | React frontend |
| PostgreSQL | 17+ | Leaderboard, user accounts, game history |
| [direnv](https://direnv.net/) | optional | Auto-loads `bin/` into `$PATH` |

### One-Time Setup

```bash
bin/gctl setup  # Installs deps, creates log files, generates local SSL certs (mkcert)
```

This runs four sub-setup steps: installs packages (`clang-format`, `shfmt`, `btop`, etc.), creates log files under `/var/log/`, generates SSL certs for `dev.gomoku.games`, and configures envoy/nginx templates.

> [!NOTE]
> 
> Please add dev.gomoku.games to your `/etc/hosts` file mapped to 127.0.0.1

### Create the Database

```bash
psql -X -c "CREATE DATABASE gomoku"
psql -X -d gomoku -f iac/cloud_sql/setup.sql
```

Then create `api/.env`:

```env
DATABASE_URL=postgresql://postgres@localhost/gomoku
GOMOKU_HTTPD_URL=http://localhost:10000
JWT_SECRET=local-dev-secret-not-for-prod
CORS_ORIGINS=["http://localhost:5173","https://dev.gomoku.games"]
```

### Start the Cluster

```bash
bin/gctl start           # Start nginx + envoy + gomoku-httpd workers + FastAPI
bin/gctl start -w 4      # Start with 4 workers instead of default (one per CPU core)
```

Open **<https://dev.gomoku.games>** (local SSL via mkcert).

### `gctl` Command Reference

```bash
bin/gctl start [-w N]       # Start cluster (default: 1 worker per CPU core)
bin/gctl stop               # Stop everything
bin/gctl restart            # Restart all components
bin/gctl status             # Show running processes
bin/gctl ps                 # Process table (PID, PPID, CPU, MEM, ARGS)
bin/gctl start nginx api    # Start individual components
bin/gctl observe btop       # Launch monitoring (btop, htop, ctop, btm)
```

Components: `nginx`, `envoy`, `gomoku` (httpd workers), `api` (FastAPI), `frontend` (Vite dev server).

> **Tip:** Use `direnv` so that `bin/` is on your `$PATH` — then you can just type `gctl start`.

### Architecture

```mermaid
graph TB
    subgraph Client
        Browser["Browser<br/>(React + TypeScript)"]
    end

    subgraph "Local Dev Cluster"
        Nginx["nginx :443<br/>(TLS termination)"]

        subgraph "FastAPI (:8000)"
            API["Auth, Scoring, Leaderboard<br/>Game Proxy, Static SPA"]
        end

        subgraph "Game Engine Pool"
            Envoy["Envoy :10000<br/>(least-request LB)"]
            W1["gomoku-httpd :9500"]
            W2["gomoku-httpd :9501"]
            WN["gomoku-httpd :950N"]
        end

        PG[("PostgreSQL")]
    end

    Browser -->|"HTTPS"| Nginx
    Nginx --> API
    API -->|"POST /gomoku/play"| Envoy
    Envoy --> W1 & W2 & WN
    API -->|"asyncpg"| PG

    style Browser fill:#4A90D9,color:#fff
    style Nginx fill:#009639,color:#fff
    style API fill:#2D6A4F,color:#fff
    style Envoy fill:#E76F51,color:#fff
    style PG fill:#7B68EE,color:#fff
```

Each `gomoku-httpd` worker is single-threaded, so envoy distributes requests across the pool using least-request load balancing. See [doc/deployment.md](doc/deployment.md) for the full local cluster guide.

### `justfile` Recipes

```bash
just --list             # See all recipes
just build-game         # Build terminal game only
just build              # Build everything (C + frontend + API assets)
just test               # Run C tests + daemon tests + API tests + frontend tests
just test-api           # Run API tests (89 tests, parallel across 4 workers)
just test-frontend      # Run frontend tests
just docker-build-all   # Build all Docker images
just ci                 # Run all pre-commit checks (lefthook)
just deploy             # Full Cloud Run deploy: migrate DB, build, push, apply
```

For a fresh checkout, `bin/db-test-setup --recreate` drops/creates the local `gomoku_test` database and runs all migrations against it.

---

## 3. Deploy to Production

The application needs two containers and a PostgreSQL database. All three deployment options below assume you outsource PostgreSQL to a managed provider.

### Database: Use Neon (or any managed Postgres)

[Neon](https://neon.tech) offers a generous free tier with serverless Postgres. Alternatives: [Supabase](https://supabase.com), [Aiven](https://aiven.io), Google Cloud SQL, AWS RDS.

1. Create a Neon project in the **AWS US East (Ohio)** region (closest to Cloud Run `us-central1` — ~25ms RT).
2. Toggle "Pooled connection" on and copy the DSN.
3. Save it as `PRODUCTION_DATABASE_URL` in your `.env` (see below). `just deploy` will run all Alembic migrations against it.

> No manual schema setup needed. Migrations live under `api/db/migrations/versions/` and apply automatically as the first step of every deploy.

### Option A: Google Cloud Run (Recommended)

Serverless, scales to zero, cheapest for low/medium traffic. Managed by Terraform; orchestrated by `bin/deploy`.

#### Two Cloud Run services:

- **gomoku-api** — FastAPI + React SPA, handles auth, scoring, leaderboard, and proxies game moves to the engine
- **gomoku-httpd** — C game engine, single-threaded, concurrency=1, auto-scales per demand

#### Prerequisites

- GCP project with billing enabled
- `gcloud` CLI authenticated (`gcloud auth login` and `gcloud auth application-default login`)
- Terraform >= 1.0
- Docker with `buildx` (for cross-compiling `linux/amd64` on Apple Silicon)
- A [Honeycomb](https://www.honeycomb.io) account (free tier is plenty) for distributed tracing
- A Neon (or other) Postgres connection string

#### Configure secrets

Copy `.env.sample` to `.env` at the repo root (gitignored) and fill in:

```bash
cp .env.sample .env
$EDITOR .env
```

| Key | What goes there |
|---|---|
| `PRODUCTION_DATABASE_URL` | Pooled Neon DSN |
| `PRODUCTION_JWT_SECRET` | Generate with `just jwt-secret` |
| `HONEYCOMB_INGEST_API_KEY` | "Ingest" key from Honeycomb → API Keys |
| `HONEYCOMB_CONFIG_API_KEY` | "Configuration" key — used to post deploy markers |
| `PROJECT_ID` | Your GCP project ID |
| `REGION` | Default `us-central1` |

Names use the `PRODUCTION_` prefix so they don't collide with the runtime config Pydantic reads inside the FastAPI app.

#### Deploy

```bash
just deploy
```

That single command, via `bin/deploy`, runs in order:

1. Verifies GCP application-default credentials (prompts login only if missing)
2. Runs Alembic migrations against `PRODUCTION_DATABASE_URL`
3. Builds the frontend → `api/public`
4. Builds + pushes both Docker images for `linux/amd64` to Artifact Registry
5. Applies Terraform (Cloud Run services, IAM, env vars)
6. Posts a deploy marker to Honeycomb

It's idempotent — safe to run on every deploy, picks up infra changes automatically.

#### DNS

Point your domain to the frontend service URL from the Terraform output. Cloud Run provisions and renews TLS automatically. See [doc/deployment.md](doc/deployment.md#custom-domain) for the gcloud commands.

See [iac/README.md](iac/README.md) for the full infrastructure reference and Terraform variables.

### Option B: AWS (ECS Fargate or App Runner)

If you prefer AWS, the Docker images work without modification.

#### With App Runner (simplest)

```bash
# Push images to ECR
aws ecr create-repository --repository-name gomoku-httpd
aws ecr create-repository --repository-name gomoku-api

just docker-build-all-amd64

# Tag and push (replace 123456789.dkr.ecr.us-east-1.amazonaws.com with your ECR URI)
docker tag gomoku-httpd:latest $ECR_URI/gomoku-httpd:latest
docker tag gomoku-api:latest $ECR_URI/gomoku-api:latest
docker push $ECR_URI/gomoku-httpd:latest
docker push $ECR_URI/gomoku-api:latest
```

Then create two App Runner services in the AWS console or via `aws apprunner create-service`, setting these environment variables on the `gomoku-api` service:

```env
DATABASE_URL=postgresql://user:pass@ep-xyz.us-east-2.aws.neon.tech/gomoku?sslmode=require
GOMOKU_HTTPD_URL=https://<httpd-app-runner-url>
JWT_SECRET=<your-generated-secret>
CORS_ORIGINS=["https://yourdomain.com"]
```

#### With ECS Fargate

For more control (custom VPC, ALB, autoscaling policies), define an ECS task definition with two containers and an ALB. The `gomoku-httpd` container should have `desiredCount` scaled based on CPU, since each instance handles one game move at a time.

### Option C: Any VPS with Docker Compose

Run on a $5/mo VPS (DigitalOcean, Hetzner, Fly.io).

```bash
just docker-build-all
docker compose up -d
```

Minimum setup: two containers (`gomoku-api:latest` on port 8000, `gomoku-httpd:latest` on port 8787), a reverse proxy (nginx/Caddy) for TLS. Set environment variables as shown in the [Configuration](#configuration) section.

## CONFIGURATION

The FastAPI app loads `api/.env.{development,test,ci}[.local]` based on the `ENVIRONMENT` env var (default `development`). Committed defaults live in `api/.env.development` and `api/.env.test`; `.local` overlays are gitignored for personal overrides. In production, all values come from Cloud Run env vars set by Terraform (no `.env` file is read).

The tables below split variables by whether the app can boot/run without them. See [Application Configuration](#application-configuration) below for the full reference (telemetry, database details, etc.).

### Required (the app will not function correctly without these)

| Variable | Required In | Purpose |
|---|---|---|
| `ENVIRONMENT` | always | `development`, `test`, `ci`, or `production` — selects which `.env.{stage}` file Pydantic loads. Defaults to `development`. |
| `DATABASE_URL` | production, any non-default DB | Full PostgreSQL DSN, e.g. `postgresql://user:pass@host/gomoku`. Without this, the app falls back to `postgresql://postgres@localhost/gomoku` which only works for local development. |
| `JWT_SECRET` | production | HMAC signing key for auth tokens. The committed default `change-me-in-production` MUST be overridden in any deployed environment. Generate with `just jwt-secret` or `openssl rand -base64 32`. |
| `GOMOKU_HTTPD_URL` | production | URL of the upstream C game engine daemon. Defaults to `http://localhost:10000` (envoy frontend) for local clusters. |
| `PUBLIC_DOMAIN` | production | Domain used to build outbound URLs (e.g. password-reset links in emails). Defaults to `app.gomoku.games`. |

### Required when email is enabled (`EMAIL_PROVIDER=sendgrid`)

| Variable | Purpose |
|---|---|
| `EMAIL_PROVIDER` | Set to `sendgrid` in production. Default `stdout` writes reset links to the console (development only). |
| `SENDGRID_API_KEY` | SendGrid Web API v3 bearer token. Create at <https://app.sendgrid.com/settings/api_keys>. The app raises `RuntimeError` at send time if `EMAIL_PROVIDER=sendgrid` and this is unset. |
| `EMAIL_FROM` | Sender address. Must belong to a SendGrid-authenticated domain (DKIM/SPF). Default `gomoku@email.gomoku.games`. |
| `EMAIL_FROM_NAME` | Friendly display name on the `From:` header. Default `Gomoku Support`. |

> **Note on SendGrid auth.** SendGrid's v3 API authenticates with a single API *key* (Bearer token). There is no separate API *ID* — the key alone identifies your account. Store `SENDGRID_API_KEY` in Cloud Run as a Secret Manager-backed env var, never in a committed `.env` file.

### Optional (have safe defaults)

| Variable | Default | Purpose |
|---|---|---|
| `JWT_ALGORITHM` | `HS256` | JWT signing algorithm. |
| `JWT_EXPIRE_MINUTES` | `10080` (1 week) | Token lifetime. |
| `CORS_ORIGINS` | `["*"]` | JSON array of allowed origins. Tighten in production. |
| `HONEYCOMB_API_KEY` | *(none)* | Honeycomb ingest key — enables OTel tracing when set. No-op when unset. |
| `OTEL_SERVICE_NAME` | `gomoku-api` | Service name attached to every span. |
| `CUSTOM_DOMAIN` | *(none)* | Override `PUBLIC_DOMAIN` (e.g. local dev hosts pointed at `dev.gomoku.games` via `/etc/hosts`). |

## Project Structure

```
gomoku-c/               C game engine + HTTP daemon
  src/gomoku/             AI, board, game, UI, CLI
  src/net/                Stateless HTTP daemon (JSON API)
  tests/                  Google Test suite + AI evals
api/                    FastAPI service
  app/                    Auth, scoring, leaderboard, game proxy, telemetry
  db/migrations/          Alembic migrations
  public/                 Frontend assets (built by justfile)
  tests/                  89 integration tests (parallel via pytest-xdist)
frontend/               React + TypeScript + Tailwind
iac/                    Infrastructure (Cloud Run, Cloud SQL, nginx, envoy)
bin/                    gctl cluster manager, helper scripts
doc/                    Technical documentation
justfile                Monorepo orchestration
```

## Documentation

| Document | Description |
|---|---|
| [doc/01-human-vs-ai-tui.md](doc/01-human-vs-ai-tui.md) | **Mode 1** — TUI binary, CLI flags, depth/radius, recording |
| [doc/02-human-vs-ai-web.md](doc/02-human-vs-ai-web.md) | **Mode 2** — web flow, settings panel, scoring, API |
| [doc/03-human-vs-human-web.md](doc/03-human-vs-human-web.md) | **Mode 3** — invite links, polling cadence, lifecycle |
| [doc/04-gomocup-submission.md](doc/04-gomocup-submission.md) | **Mode 4** — `pbrain-kig-standard` build, packaging, submission |
| [doc/gomocup-elo-rankings.md](doc/gomocup-elo-rankings.md) | Unified Elo system (BayesElo, recalibration) |
| [doc/deployment.md](doc/deployment.md) | Local cluster, Cloud Run, and GKE deployment |
| [doc/developer.md](doc/developer.md) | C engine technical overview and architecture |
| [doc/ai-engine.md](doc/ai-engine.md) | AI algorithm analysis, threat scoring, known issues |
| [doc/httpd.md](doc/httpd.md) | HTTP daemon API reference and cluster setup |
| [doc/game-rules.md](doc/game-rules.md) | Gomoku/Renju rules and variant support proposal |
| [doc/dtrace.md](doc/dtrace.md) | DTrace investigation of CPU busy-spin fix |
| [doc/gomocup-protocol.md](doc/gomocup-protocol.md) | Gomocup brain protocol implementation plan |
| [doc/human-vs-human-plan.md](doc/human-vs-human-plan.md) | Multiplayer feature plan + multi-agent build workflow |
| [doc/multiplayer-modal-plan.md](doc/multiplayer-modal-plan.md) | "Choose Game Type" modal + invite-link spec |
| [doc/multiplayer-bugs.md](doc/multiplayer-bugs.md) | Bug list & fixes from the original multiplayer PR |
| [iac/README.md](iac/README.md) | Cloud Run infrastructure and Terraform |
| [frontend/CLAUDE.md](frontend/CLAUDE.md) | Frontend architecture and API endpoints |

### Multiplayer (human vs human)

Two authenticated users can play each other over a shared invite link. After
logging in, the **Choose Game Type** modal appears with two options:

- **AI** (default) — drops you into the standard single-player flow.
- **Another Player** — generates a 6-character invite link
  (`/play/AB7K3X`). The link expires after 15 minutes; cancelling the modal
  marks the game `cancelled` in the database. The host can either pick the
  color up front or defer the choice to the guest, who will pick at join
  time.

The full spec is in [doc/multiplayer-modal-plan.md](doc/multiplayer-modal-plan.md);
the underlying API (six `/multiplayer/*` endpoints, asyncpg + raw-SQL,
short-poll with backoff) is documented in
[doc/human-vs-human-plan.md](doc/human-vs-human-plan.md).

## Application Configuration

The FastAPI server (`api/`) is configured via environment variables. Locally, defaults come from `api/.env.{development,test,ci}` (committed) with optional `.env.{stage}.local` overrides (gitignored). In production, all values are set as Cloud Run env vars by Terraform — no `.env` file is read.

### Database

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | *(none)* | Full PostgreSQL DSN, e.g. `postgresql://user:pass@host/gomoku`. Takes precedence over `DB_*` vars. |
| `DB_SOCKET` | *(none)* | Unix socket path for Cloud SQL Proxy. |
| `DB_NAME` | `gomoku` | Database name. |
| `DB_USER` | `postgres` | Database user. |
| `DB_PASSWORD` | *(none)* | Database password. |

### Game Engine

| Variable | Default | Description |
|---|---|---|
| `GOMOKU_HTTPD_URL` | `http://localhost:8787` | Upstream game engine. With envoy: `http://localhost:10000`. |

### Authentication (JWT)

| Variable | Default | Description |
|---|---|---|
| `JWT_SECRET` | `change-me-in-production` | HMAC signing key. Generate: `openssl rand -base64 32`. |
| `JWT_ALGORITHM` | `HS256` | JWT signing algorithm. |
| `JWT_EXPIRE_MINUTES` | `1440` | Token lifetime (default 24h). |

### CORS

| Variable | Default | Description |
|---|---|---|
| `CORS_ORIGINS` | `["*"]` | JSON array of allowed origins. |

### Email

| Variable | Default | Description |
|---|---|---|
| `EMAIL_PROVIDER` | `stdout` | `stdout` (logs the reset link — dev only) or `sendgrid` (posts to SendGrid v3). |
| `EMAIL_FROM` | `gomoku@email.gomoku.games` | Sender address. Must belong to a SendGrid-authenticated domain (DKIM/SPF). |
| `EMAIL_FROM_NAME` | `Gomoku Support` | Friendly display name shown alongside `EMAIL_FROM` in the `From:` and `Reply-To:` headers. |
| `SENDGRID_API_KEY` | *(none)* | SendGrid Web API v3 bearer token. Required when `EMAIL_PROVIDER=sendgrid` — the service raises `RuntimeError` at send time if missing. |

### Telemetry

| Variable | Default | Description |
|---|---|---|
| `HONEYCOMB_API_KEY` | *(none)* | Honeycomb Ingest key — enables OTLP/HTTP export of traces. No-op when unset. |
| `HONEYCOMB_DATASET` | *(none)* | Required only for Honeycomb classic 32-char keys. Modern env-aware keys route by `service.name`. |
| `OTEL_SERVICE_NAME` | `gomoku-api` | Resource attribute on every span. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `https://api.honeycomb.io/v1/traces` | Override only if using a different OTel collector. |

The `deployment.environment` resource attribute is set automatically from `ENVIRONMENT`, so a single Honeycomb environment can hold dev/test/prod traces filterable by `WHERE deployment.environment = "production"`.

### Example `api/.env.development.local` (personal override)

```env
# Point local dev at Neon for prod-shape debugging — copy from `.env`'s
# PRODUCTION_DATABASE_URL.
DATABASE_URL=postgresql://...neon...
HONEYCOMB_API_KEY=hcaik_xxx
```

## License

MIT License. Copyright 2025-2026, Konstantin Gredeskoul.

## Acknowledgments

- [Claude](https://claude.ai) (Sonnet, Opus) -- AI pair programming partner
- Google Test framework for C++ testing
- Pattern recognition adapted from traditional Gomoku AI research, PDFs of whidh together with paper sumaries is included in the repo.
