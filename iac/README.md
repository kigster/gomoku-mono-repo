# Infrastructure — Gomoku

Deployment configuration for Google Cloud Run with external PostgreSQL (Neon).

## Architecture

```
Internet → gomoku-api (Cloud Run, public) → gomoku-httpd (Cloud Run, internal)
               ↓
           Neon PostgreSQL (external)
```

- **gomoku-api** — FastAPI serving the React SPA as static files, plus auth, scoring, leaderboard, and game move proxy. Public-facing.
- **gomoku-httpd** — C game engine, stateless, single-threaded, concurrency=1. Internal only, auto-scales per demand.

Both services scale independently. Cloud Run handles TLS and load balancing automatically.

## Directory Structure

```
iac/
├── cloud_run/           # Terraform + deploy scripts for Cloud Run
│   ��── main.tf          # Two Cloud Run services + IAM
│   ├── variables.tf     # Project ID, region, images, secrets
│   ├── outputs.tf       # Service URLs
│   ├── deploy.sh        # First-time deploy (terraform init + apply)
│   ���── update.sh        # Update one or both services (build + push + gcloud)
��   └── README.md        # Full Cloud Run deployment guide
├─��� cloud_sql/           # Database schema and utilities
│   ├── setup.sql        # Schema: users, games, views, functions
│   ├── create-instance.sh  # Create Cloud SQL instance (if using GCP Postgres)
│   └── resolve-geo.sh   # Backfill IP geolocation data
├── local/               # Local development configs (used by bin/gctl)
│   ├── envoy/           # Envoy proxy config for local worker pool
│   └── templates/       # Config templates (envoy, nginx)
└── README.md            # This file
```

## Quick Start

```bash
# 1. Copy the env sample, fill in PRODUCTION_*  / STAGING_* / Honeycomb keys
cp .env.sample .env
$EDITOR .env

# 2. Deploy
just deploy             # → production (gomoku.us)
just deploy staging     # → staging   (staging.gomoku.games), min=0/0
```

The two environments are fully isolated: separate Cloud Run services
(`gomoku-api` / `gomoku-api-staging`, `gomoku-httpd` / `gomoku-httpd-staging`),
separate Terraform state under `gs://gomoku-tfstate/cloud-run/{env}/gomoku`,
and **separate Neon databases** (you point them via `PRODUCTION_DATABASE_URL`
and `STAGING_DATABASE_URL` in `.env`).

Local dev is a third, completely separate flow — see
[bin/gctl](../bin/gctl) and the README in the project root.

### Custom domains and DNS

Both stacks register a Cloud Run domain mapping. After the first
`just deploy <env>`, add the records to your DNS registrar:

| Environment | Domain | Records |
| ----------- | ---------------------- | ------------------------------------ |
| production | `gomoku.us` (apex) | 4× `A` + 4× `AAAA` (Google ghs IPs) |
| staging | `staging.gomoku.games` | 1× `CNAME` → `ghs.googlehosted.com.` |

**Step-by-step DNSMadeEasy instructions, including the exact record
values, troubleshooting, and TLS provisioning timing, live in
[`iac/DNS.md`](DNS.md).**

See [cloud_run/README.md](cloud_run/README.md) for the full deployment
guide, scaling, and monitoring.

## Database Schema

The schema is in `cloud_sql/setup.sql`. Key tables:

- **users** — UUID PK, username, email, password hash, game counters
- **games** — UUID PK, player name, winner, depth, radius, score, game JSON, IP, geo
- **password_reset_tokens** — UUID PK, token, expiry

Score formula: `1000 * depth + 50 * radius + f(human_time_seconds)` where `f(x)` rewards fast wins and penalizes slow ones.

Views: `leaderboard` (best per player), `top_scores` (global top 100).

## Environment Variables

### FastAPI (`gomoku-api`)

| Variable | Source | Purpose |
| ------------------ | ---------------------------------- | --------------------------------- |
| `DATABASE_URL` | `TF_VAR_database_url` | Neon PostgreSQL connection string |
| `GOMOKU_HTTPD_URL` | Terraform (from httpd service URL) | Internal URL to game engine |
| `JWT_SECRET` | `TF_VAR_jwt_secret` | JWT signing key |
| `CORS_ORIGINS` | Terraform variable | Allowed origins (default `["*"]`) |

### Game Engine (`gomoku-httpd`)

No environment variables — all config via CLI args (`-b 0.0.0.0:8787`).

## Local Development

Use `bin/gctl` instead of Cloud Run:

```bash
bin/gctl start              # Start nginx, envoy, gomoku-httpd workers, API
bin/gctl status             # Check what's running
bin/gctl stop               # Stop everything
```

See `bin/gctl -h` for full usage.
