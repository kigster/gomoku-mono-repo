# Infrastructure — Gomoku

Deployment configuration for Google Cloud Run with PostgreSQL — either a Terraform-managed Cloud SQL PostgreSQL 18 instance (`<ENV>_CLOUD_SQL=1`) or any external DSN (Neon, Supabase).

## Architecture

```
Internet → gomoku-api (Cloud Run, public) → gomoku-httpd (Cloud Run, internal)
               ↓  /cloudsql unix socket (Cloud SQL connector)
           Cloud SQL PostgreSQL 18 (db-f1-micro)   — or an external DSN
```

- **gomoku-api** — FastAPI serving the React SPA as static files, plus auth, scoring, leaderboard, and game move proxy. Public-facing.
- **gomoku-httpd** — C game engine, stateless, single-threaded, concurrency=1. Internal only, auto-scales per demand.

Both services scale independently. Cloud Run handles TLS and load balancing automatically.

## Directory Structure

```
iac/
├── cloud_run/           # Terraform + deploy scripts for Cloud Run
│   ├── main.tf          # Two Cloud Run services + IAM
│   ├── cloud_sql.tf     # Optional Cloud SQL PostgreSQL 18 instance (cloud_sql_enabled)
│   ├── variables.tf     # Project ID, region, images, secrets
│   ├── outputs.tf       # Service URLs, Cloud SQL connection name
│   ├── deploy.sh        # First-time deploy (terraform init + apply)
│   ├── cloud-sql.sh     # Provision Cloud SQL / run a command through cloud-sql-proxy
│   ├── update.sh        # Update one or both services (build + push + gcloud)
│   └── README.md        # Full Cloud Run deployment guide
├── cloud_sql/           # Database schema and utilities
│   ├── setup.sql        # Schema: users, games, views, functions
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
and **separate databases** (a Cloud SQL instance each, or external DSNs via
`PRODUCTION_DATABASE_URL` and `STAGING_DATABASE_URL` in `.env`).

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

## Cloud SQL (PostgreSQL 18)

`iac/cloud_run/cloud_sql.tf` provisions one instance per environment (`gomoku-db`, `gomoku-db-staging`) when `cloud_sql_enabled = true`. Turn it on per environment in `.env`:

```bash
PRODUCTION_CLOUD_SQL=1   # PRODUCTION_DATABASE_URL is then ignored
STAGING_CLOUD_SQL=0      # staging keeps its external DSN
```

| Setting | Value | Why |
| --------------- | ------------------------------------------ | ----------------------------------------------------------- |
| Version | `POSTGRES_18` | Matches local dev (Homebrew `postgresql@18`) |
| Tier / edition | `db-f1-micro` / `ENTERPRISE` | Cheapest tier; shared-core is invalid under Enterprise Plus |
| Availability | `ZONAL` | No HA standby (halves the bill) |
| Disk | 10 GB SSD, autoresize to 50 GB | Minimum size |
| Network | Public IP, **no** authorized networks | Only reachable via the IAM-gated connector / proxy; no VPC |
| Backups | Daily, 7 retained, no PITR | PITR WAL storage is billed |
| Password | `random_password` → Secret Manager | Injected as `DB_PASSWORD`; never a plain env value |
| Deletion | Protected (Terraform + API) | `cloud_sql_deletion_protection = false` to tear down |

The api gets `DB_SOCKET=/cloudsql/<connection-name>`, `DB_NAME=gomoku`, `DB_USER=gomoku`, and `DB_PASSWORD` from Secret Manager. `api/app/config.py::database_dsn` already builds the unix-socket DSN from these.

> [!WARNING]
> **There is no always-free Cloud SQL tier.** `db-f1-micro` runs about **$9–10/month** plus ~$0.17/GB-month of SSD, per environment. Google's 30-day Cloud SQL free trial is Enterprise Plus only, needs a fresh project, and is suspended afterwards, so this stack doesn't use it.

> [!CAUTION]
> `db-f1-micro` defaults to `max_connections = 25`. Each api instance opens an asyncpg pool of up to 10 connections, so keep `api_max_instances <= 2` (production default is 5) or move to `db-g1-small` via `cloud_sql_tier`.

### Deploying

`just deploy` does everything when `PRODUCTION_CLOUD_SQL=1`:

1. `iac/cloud_run/cloud-sql.sh provision` — targeted apply of the instance, database, user, secret and IAM (~10 min the first time).
1. `cloud-sql.sh exec -- uv run alembic upgrade head` — starts `cloud-sql-proxy` on `127.0.0.1:5434`, runs Alembic, stops the proxy.
1. The usual image build + full `terraform apply`.

Prerequisite: `brew install cloud-sql-proxy`.

### Moving data off Supabase / Neon

```bash
# 1. Dump the old database (data only; Alembic owns the schema)
pg_dump --data-only --no-owner --no-privileges \
  --exclude-table=alembic_version -Fc "$OLD_DATABASE_URL" -f gomoku.dump

# 2. Provision + migrate the schema on Cloud SQL
ENVIRONMENT=production iac/cloud_run/cloud-sql.sh provision
ENVIRONMENT=production iac/cloud_run/cloud-sql.sh exec -- \
  sh -c 'cd api && uv run alembic upgrade head'

# 3. Restore the data through the proxy
ENVIRONMENT=production iac/cloud_run/cloud-sql.sh exec -- \
  sh -c 'pg_restore --data-only --no-owner --single-transaction -d "$DATABASE_URL" gomoku.dump'
```

Skip `--disable-triggers`: Cloud SQL users are never true superusers, so it fails. `pg_dump` already orders data by foreign-key dependency, and `--single-transaction` makes a failed restore leave nothing behind. Then set `PRODUCTION_CLOUD_SQL=1` and `just deploy`.

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
| `DATABASE_URL` | `TF_VAR_database_url` | External Postgres DSN (unset when Cloud SQL is on) |
| `DB_SOCKET` / `DB_NAME` / `DB_USER` | Terraform (`cloud_sql.tf`) | Cloud SQL unix socket + credentials |
| `DB_PASSWORD` | Secret Manager (`gomoku-db-password[-env]`) | Cloud SQL user password |
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
