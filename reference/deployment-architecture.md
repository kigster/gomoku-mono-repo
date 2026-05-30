# Deployment Guide

Production deployment uses Google Cloud Run with external PostgreSQL (Neon). For local development, use the `gctl` cluster controller.

______________________________________________________________________

## 1. Local Development Cluster

Since `gomoku-httpd` is single-threaded, serving concurrent game requests requires a pool of worker processes behind a load balancer. The local cluster replicates the production architecture on your dev machine.

### Architecture

```mermaid
graph TB
    subgraph Browser
        Client["Browser / curl"]
    end

    subgraph "Local Dev Machine"
        Nginx["nginx :443 / :80<br/>(TLS termination via mkcert)"]

        subgraph "FastAPI :8000"
            API["Auth, Scoring, Leaderboard<br/>Game Proxy, Static SPA"]
        end

        subgraph "Game Engine Pool"
            Envoy["Envoy :10000<br/>(least-request LB, health checks)"]
            W1["gomoku-httpd :9500"]
            W2["gomoku-httpd :9501"]
            W3["gomoku-httpd :9502"]
            WN["gomoku-httpd :950N"]
        end

        PG[("PostgreSQL<br/>localhost:5432")]
        Vite["Vite :5173<br/>(dev server, HMR)"]
    end

    Client -->|"HTTPS"| Nginx
    Nginx --> API
    Nginx --> Vite
    API -->|"POST /gomoku/play"| Envoy
    Envoy --> W1 & W2 & W3 & WN
    API -->|"asyncpg"| PG

    style Client fill:#4A90D9,color:#fff
    style Nginx fill:#009639,color:#fff
    style API fill:#2D6A4F,color:#fff
    style Envoy fill:#E76F51,color:#fff
    style PG fill:#7B68EE,color:#fff
    style Vite fill:#646CFF,color:#fff
```

### Components

| Component | Default Port(s) | Description |
| ---------------- | ------------------------------ | ---------------------------------------------------- |
| **nginx** | 80, 443 | TLS termination (mkcert), routing to API and Vite |
| **envoy** | 10000 (frontend), 9901 (admin) | Least-request LB across gomoku-httpd workers |
| **gomoku-httpd** | 9500+ | Worker pool (one process per port, one per CPU core) |
| **FastAPI** | 8000 | Auth, scoring, leaderboard, game move proxy |
| **Vite** | 5173 | React dev server with HMR |
| **PostgreSQL** | 5432 | Local database for leaderboard and user accounts |

### `gctl` — Cluster Controller

![gctl help](../.features/img/gctl-help.jpg)

> **Tip:** Use [direnv](https://direnv.net/) so that `bin/` is on your `$PATH` — then you can type `gctl` instead of `bin/gctl`.

#### Setup (One-Time)

```bash
gctl setup
```

This installs dependencies, creates log files under `/var/log/`, generates local SSL certs via mkcert, and configures envoy/nginx templates.

#### Cluster Lifecycle

```bash
gctl start                  # Start all components (1 worker per CPU core)
gctl start -w 16            # Start with 16 workers
gctl stop                   # Stop everything
gctl restart                # Restart all components
gctl status                 # Show what's running
```

#### Individual Components

```bash
gctl start nginx api        # Start only nginx and FastAPI
gctl restart envoy          # Restart just envoy
gctl stop frontend          # Stop Vite dev server
```

Components: `nginx`, `envoy`, `gomoku`, `api`, `frontend`.

#### Monitoring

```bash
gctl ps                     # Process table (PID, PPID, CPU, MEM, ARGS)
gctl observe btop           # Launch btop filtered to gomoku processes
gctl observe htop           # Or htop, ctop, btm
```

#### Admin Interfaces

- **Envoy admin:** http://127.0.0.1:9901
- **Vite dev server:** http://localhost:5173
- **Local HTTPS:** https://dev.gomoku.games

### Log Files

| File | Component |
| ------------------------------ | --------------- |
| `/var/log/nginx/access.log` | nginx access |
| `/var/log/nginx/error.log` | nginx errors |
| `/var/log/envoy.log` | Envoy proxy |
| `/var/log/gomoku-httpd.log` | gomoku workers |
| `/var/log/gomoku-api.log` | FastAPI |
| `/var/log/gomoku-frontend.log` | Vite dev server |

______________________________________________________________________

## 2. Production — Google Cloud Run + Neon PostgreSQL

Serverless, scales to zero, $0/month at low traffic. Two Cloud Run services, database outsourced to Neon.

### Architecture

```mermaid
graph TB
    subgraph Internet
        Browser["Browser"]
    end

    subgraph "Google Cloud Run"
        subgraph "gomoku-api (public)"
            API["FastAPI + React SPA<br/>Auth, Scoring, Leaderboard<br/>Game Proxy<br/><br/>concurrency: 80<br/>auto-scale: 0–5"]
        end

        subgraph "gomoku-httpd (internal)"
            Engine["C Game Engine<br/>Minimax + Alpha-Beta<br/><br/>concurrency: 1<br/>auto-scale: 0–20"]
        end
    end

    subgraph "Neon (External)"
        PG[("PostgreSQL<br/>serverless")]
    end

    Browser -->|"HTTPS :443<br/>(Google-managed TLS)"| API
    API -->|"POST /gomoku/play<br/>(service-to-service auth)"| Engine
    API -->|"asyncpg<br/>(TLS, connection pooling)"| PG

    style Browser fill:#4A90D9,color:#fff
    style API fill:#2D6A4F,color:#fff
    style Engine fill:#E76F51,color:#fff
    style PG fill:#7B68EE,color:#fff
```

### How It Works

- **gomoku-api** is the only public-facing service. It serves the React SPA as static files, handles authentication, scoring, and leaderboard queries against Neon PostgreSQL, and proxies game move requests to gomoku-httpd.
- **gomoku-httpd** is internal-only. Each instance handles one request at a time (`concurrency=1`). Cloud Run automatically spins up new instances for concurrent game moves and scales back to zero when idle.
- **Cloud Run handles TLS** — your containers listen on plain HTTP. Google provisions and renews certificates for both the default `*.run.app` URL and any custom domain you map.
- **No envoy, no nginx, no load balancer config** — Cloud Run's built-in request routing replaces all of that in production.

### Request Flow

```mermaid
sequenceDiagram
    participant B as Browser
    participant CR as Cloud Run Ingress
    participant API as gomoku-api
    participant PG as Neon PostgreSQL
    participant E as gomoku-httpd

    B->>CR: HTTPS POST /game/play
    CR->>API: HTTP :8000 (TLS terminated)
    API->>API: Validate JWT, parse game state
    API->>E: POST /gomoku/play (internal, service-to-service auth)
    Note over E: AI computes best move<br/>(minimax + alpha-beta pruning)
    E-->>API: JSON with AI move
    API->>PG: UPDATE game state, score
    PG-->>API: OK
    API-->>CR: JSON response
    CR-->>B: HTTPS response with AI move
```

### Prerequisites

- GCP project with billing enabled
- `gcloud` CLI authenticated (`gcloud auth login` and `gcloud auth application-default login`)
- Terraform >= 1.0
- Docker with `buildx` (for cross-compiling `linux/amd64` on Apple Silicon)
- A [Neon](https://neon.tech) database (free tier works) — use the **AWS US East (Ohio)** region for lowest latency to GCP `us-central1`
- A [Honeycomb](https://www.honeycomb.io) account (free tier is plenty) for distributed tracing

### Database Setup

1. Create a Neon project in **AWS US East (Ohio)**, default Postgres version is fine.
1. Toggle "Pooled connection" on and copy the DSN — it'll look like `postgresql://user:pass@ep-xxxx-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require`. The pooler is required because Cloud Run instances are short-lived and would otherwise exhaust direct connection limits.
1. That's it — `just deploy` runs Alembic migrations against the DSN as its first step. There is no separate `psql -f setup.sql`.

### Configure secrets

Copy the deploy-time `.env` template at the repo root (gitignored) and fill it in:

```bash
cp .env.sample .env
$EDITOR .env
```

| Key | What goes there |
| -------------------------- | ---------------------------------------------------------------------------- |
| `PRODUCTION_DATABASE_URL` | Pooled Neon DSN from above |
| `PRODUCTION_JWT_SECRET` | Generate with `just jwt-secret` |
| `HONEYCOMB_INGEST_API_KEY` | "Ingest" key from Honeycomb → Environment Settings → API Keys |
| `HONEYCOMB_CONFIG_API_KEY` | "Configuration" key — used to post deploy markers (optional but recommended) |
| `PROJECT_ID` | Your GCP project ID |
| `REGION` | Default `us-central1` |

Names use the `PRODUCTION_` prefix so `just`'s dotenv-load can't accidentally export them into a runtime FastAPI process and shadow the runtime config Pydantic reads.

### Deploy

```bash
just deploy
```

That single command, via `bin/deploy`, runs in order:

1. Verifies GCP application-default credentials (prompts login only if missing).
1. Runs Alembic migrations against `PRODUCTION_DATABASE_URL`.
1. Builds the frontend → `api/public`.
1. Builds + pushes both Docker images for `linux/amd64` to Artifact Registry.
1. Applies Terraform (Cloud Run services, IAM bindings, Cloud Run env vars including `ENVIRONMENT=production`, `HONEYCOMB_API_KEY`, etc.).
1. Posts a deploy marker to Honeycomb with the git SHA + commit subject so dashboard queries show a vertical line at deploy time.

It's idempotent — safe to run on every deploy. New env vars or scaling changes in `iac/cloud_run/main.tf` are picked up automatically.

#### Legacy escape hatches

`just cr-init` and `just cr-update` are pre-`bin/deploy` recipes that **skip the migration step**. Useful only for emergency rollback or infra-only changes; prefer `just deploy` for everything else. If `cr-update` ships a new image that needs a column the live DB doesn't have, the new instance will crash on first request.

```bash
cd iac/cloud_run
./update.sh httpd        # Game engine container only
./update.sh api          # API + frontend container only
```

See [iac/cloud_run/README.md](../iac/cloud_run/README.md) for the full Terraform reference.

### Custom Domain

```bash
gcloud domains verify gomoku.us
gcloud run domain-mappings create \
    --service gomoku-api \
    --domain gomoku.us \
    --region us-central1
```

For the apex domain, add the A/AAAA records Google provides. For a subdomain (e.g. `app.gomoku.us`), add a single CNAME to `ghs.googlehosted.com`. Cloud Run provisions the TLS certificate automatically.

### Scaling

| Setting | gomoku-api | gomoku-httpd |
| ------------- | ---------- | ------------ |
| Min instances | 0 | 0 |
| Max instances | 5 | 20 |
| Concurrency | 80 | 1 |
| CPU | 1 vCPU | 1 vCPU |
| Memory | 512 Mi | 512 Mi |

Adjust via gcloud:

```bash
gcloud run services update gomoku-httpd --region=us-central1 --max-instances=50
gcloud run services update gomoku-httpd --region=us-central1 --min-instances=1
```

### Cost

| Resource | Free Tier |
| ----------------- | ----------------------------------- |
| Cloud Run | 2M requests/mo, 360K vCPU-sec |
| Artifact Registry | 500MB storage |
| Neon PostgreSQL | 0.5GB storage, 190 compute hours/mo |
| Honeycomb | 20M events/mo |

**Total for hobby traffic: $0/month.** Set `min-instances=1` on `gomoku-api` (Python boot is ~3-5s cold) to avoid noticeable cold starts; that costs ~$5-10/month. The C engine cold-starts in \<1s, so leave it at `min=0`.

### Telemetry — Honeycomb tracing

Every Cloud Run instance auto-instruments FastAPI, httpx, and asyncpg via OpenTelemetry, exporting to Honeycomb's OTLP/HTTP endpoint. You'll see one server span per inbound request, with child spans for each DB query and the outgoing call to `gomoku-httpd`. Disabling tracing is a no-op: just leave `HONEYCOMB_INGEST_API_KEY` unset (in dev or in your Cloud Run env) and the tracer initializer logs a "telemetry_disabled" line and exits.

The `gomoku-httpd` C engine doesn't push OTLP itself. Instead, the FastAPI httpx client injects the W3C `traceparent` header, the engine reads it via `http_request_header()`, and logs the trace ID with each request line:

```
127.0.0.1 /gomoku/play 200 1234.5ms trace_id=4bf92f3577b34da6a3ce929d0e0e4736
```

So engine logs join to FastAPI traces by trace_id in Honeycomb queries.

#### Per-environment routing

Spans carry `deployment.environment` resource attributes set from the `ENVIRONMENT` env var (`production` in Cloud Run, `development`/`test`/`ci` locally). One Honeycomb environment can hold all three:

```
WHERE deployment.environment = "production"
GROUP BY name
```

When traffic justifies the split, create a separate "production" Honeycomb environment with its own ingest key — change a single env var on the Cloud Run service and you're done.

#### Deploy markers

`bin/deploy` posts a marker to Honeycomb at the end of every successful deploy:

```
POST https://api.honeycomb.io/1/markers/__all__
{ "message": "<sha> <commit subject>", "type": "deploy" }
```

These show as vertical lines on every graph in the affected dataset. Disabled silently when `HONEYCOMB_CONFIG_API_KEY` is unset. Override the dataset with `HONEYCOMB_MARKER_DATASET=gomoku-api` if you want markers limited to one dataset instead of `__all__`.

### Monitoring

```bash
# Live logs
gcloud run services logs tail gomoku-api --region=us-central1
gcloud run services logs tail gomoku-httpd --region=us-central1

# Health check
curl https://gomoku-api-HASH-uc.a.run.app/health

# Service status
gcloud run services describe gomoku-api --region=us-central1 --format="yaml(status)"
gcloud run revisions list --service=gomoku-httpd --region=us-central1
```

______________________________________________________________________

## 3. Troubleshooting

| Problem | Fix |
| ---------------------------- | ------------------------------------------------------------------------------- |
| 405 on POST | Ensure `VITE_API_BASE` is empty in frontend `.env` for production (same-origin) |
| CPU < 1 with concurrency > 1 | Cloud Run requires CPU >= 1000m when concurrency > 1 |
| Memory < 512Mi | CPU always-allocated requires memory >= 512Mi |
| Image not updating | Use `gcloud run services update` to force a new revision with `:latest` |
| ARM64 image on Cloud Run | Always build with `docker buildx build --platform linux/amd64` |
| Database connection refused | Check `DATABASE_URL` includes `?sslmode=require` for Neon |
| Cold starts slow | Set `min-instances=1` on gomoku-httpd |

### Links

- [Cloud Run infrastructure](../iac/cloud_run/README.md) — Terraform config, deploy scripts, environment variables
- [AI Engine](ai-engine.md) — Algorithm details, threat scoring, known issues
- [HTTP Daemon](httpd.md) — API reference and JSON schema
