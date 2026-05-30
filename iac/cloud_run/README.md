# Cloud Run Deployment

Two Cloud Run services with external PostgreSQL (Neon).

## Architecture

```
Internet → gomoku-api (Cloud Run, public)  → gomoku-httpd (Cloud Run, internal)
               ↓
           Neon PostgreSQL (external)
```

- **gomoku-api** — FastAPI serving the React SPA as static files, plus auth, scoring, leaderboard, and game move proxy. Public-facing, auto-scales 0-5 instances.
- **gomoku-httpd** — C game engine, single-threaded, concurrency=1. Internal only, auto-scales 0-20 instances. Cloud Run load-balances across instances automatically (no envoy needed).

Cloud Run handles TLS and issues certificates automatically for both the default `*.run.app` URL and any mapped custom domain.

## Prerequisites

- GCP project with billing enabled
- `gcloud` CLI authenticated (`gcloud auth login`)
- Terraform >= 1.0
- Docker with `buildx` (for cross-compiling to `linux/amd64` on Apple Silicon)
- A [Neon](https://neon.tech) database (or any managed PostgreSQL)

## Database Setup

1. Create a Neon project and database named `gomoku`
1. Run the schema migration:
   ```bash
   psql "$NEON_DATABASE_URL" -f iac/cloud_sql/setup.sql
   ```
1. Keep the connection string — you'll export it as `TF_VAR_database_url`

## First-Time Deploy

```bash
# Set required environment variables
export PROJECT_ID="your-gcp-project-id"
export TF_VAR_jwt_secret="$(openssl rand -base64 32)"
export TF_VAR_database_url="postgresql://user:pass@ep-xyz.us-east-2.aws.neon.tech/gomoku?sslmode=require"

# Build frontend assets and Docker images (linux/amd64)
just cr-prepare

# Deploy via Terraform
cd iac/cloud_run
./deploy.sh
```

Or from the project root in one step:

```bash
just cr-init
```

The deploy script:

1. Initializes Terraform and enables Cloud Run + Artifact Registry APIs
1. Creates an Artifact Registry repository (`gomoku-repo`)
1. Builds both Docker images for `linux/amd64` and pushes them
1. Applies the full Terraform plan (two Cloud Run services + IAM)

## Updating Services

Update all services:

```bash
just cr-update
```

Update individual services:

```bash
cd iac/cloud_run
./update.sh httpd        # Game engine only
./update.sh api          # API + frontend only
./update.sh httpd api    # Both (default)
```

The update script rebuilds the Docker image, pushes it, and tells Cloud Run to pull the new image. No Terraform needed for code-only updates.

## Custom Domain

Map your domain to the API service (the public-facing one):

```bash
gcloud domains verify gomoku.us
gcloud run domain-mappings create \
    --service gomoku-api \
    --domain gomoku.us \
    --region us-central1
```

Then add the DNS records shown in the output. For a subdomain like `app.gomoku.us`, a single CNAME to `ghs.googlehosted.com` is enough. For the apex domain, add the A/AAAA records Google provides.

Cloud Run provisions and auto-renews the TLS certificate. No certbot, no manual SSL.

## Environment Variables

All configuration is passed to the `gomoku-api` container via Terraform:

| Variable | Source | Purpose |
| ------------------ | ---------------------------------- | --------------------------------- |
| `DATABASE_URL` | `TF_VAR_database_url` | Neon PostgreSQL connection string |
| `GOMOKU_HTTPD_URL` | Terraform (from httpd service URL) | Internal URL to game engine |
| `JWT_SECRET` | `TF_VAR_jwt_secret` | HMAC signing key for auth tokens |
| `CORS_ORIGINS` | Terraform variable | Allowed origins (default `["*"]`) |

The `gomoku-httpd` container has no environment variables — all config is via CLI args.

## Terraform State

State is stored in a GCS bucket. Create it once before the first deploy:

```bash
gsutil mb -l us-central1 "gs://${PROJECT_ID}-tfstate"
```

Then update the `backend "gcs"` block in `main.tf` to match your bucket name.

## Scaling

| Setting | gomoku-api | gomoku-httpd |
| ------------- | ---------- | ------------ |
| Min instances | 0 | 0 |
| Max instances | 5 | 20 |
| Concurrency | 80 | 1 |
| CPU | 1 vCPU | 1 vCPU |
| Memory | 512 Mi | 512 Mi |

The game engine uses `concurrency=1` because `gomoku-httpd` is single-threaded. Cloud Run spins up a new instance for each concurrent request. Adjust via:

```bash
gcloud run services update gomoku-httpd --region=us-central1 --max-instances=50
gcloud run services update gomoku-httpd --region=us-central1 --min-instances=1  # avoid cold starts
```

## Cost

Cloud Run scales to zero when idle. With the Neon free tier, total cost for low traffic is **$0/month**.

| Resource | Free Tier |
| ----------------- | ----------------------------------- |
| Cloud Run | 2M requests/mo, 360K vCPU-sec |
| Artifact Registry | 500MB storage |
| Neon PostgreSQL | 0.5GB storage, 190 compute hours/mo |

## Monitoring

```bash
# Live logs
gcloud run services logs tail gomoku-api --region=us-central1
gcloud run services logs tail gomoku-httpd --region=us-central1

# Recent logs
gcloud run services logs read gomoku-api --region=us-central1 --limit=50

# Service status
gcloud run services describe gomoku-api --region=us-central1 --format="yaml(status)"
gcloud run revisions list --service=gomoku-httpd --region=us-central1
```

## Files

```
iac/cloud_run/
├── main.tf         Two Cloud Run services + IAM
├── variables.tf    Project ID, region, images, secrets
├── outputs.tf      Service URLs
├── deploy.sh       First-time deploy (Terraform init + apply)
└── update.sh       Rebuild and push one or both services
```
