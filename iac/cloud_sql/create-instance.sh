#!/usr/bin/env bash
set -euo pipefail

# Cloud SQL instance for Gomoku game history
PROJECT="fine-booking-486503-k7"
REGION="us-central1"
INSTANCE="gomoku-db"
DATABASE="gomoku"
NETWORK="default"

# ─── Prerequisites ────────────────────────────────────────────────────────────
# Private IP requires Service Networking API and VPC peering.

echo "=== Enabling required APIs ==="
gcloud services enable servicenetworking.googleapis.com \
  sqladmin.googleapis.com \
  --project="$PROJECT"

echo "=== Ensuring VPC peering range exists ==="
gcloud compute addresses describe google-managed-services-${NETWORK} \
  --global --project="$PROJECT" >/dev/null 2>&1 ||
  gcloud compute addresses create google-managed-services-${NETWORK} \
    --global --purpose=VPC_PEERING --prefix-length=16 \
    --network="$NETWORK" --project="$PROJECT"

echo "=== Ensuring VPC peering connection exists ==="
gcloud services vpc-peerings list \
  --network="$NETWORK" --project="$PROJECT" 2>/dev/null |
  grep -q servicenetworking.googleapis.com ||
  gcloud services vpc-peerings connect \
    --service=servicenetworking.googleapis.com \
    --ranges=google-managed-services-${NETWORK} \
    --network="$NETWORK" --project="$PROJECT"

# ─── Create Instance ─────────────────────────────────────────────────────────
# PostgreSQL 17 requires Enterprise Plus (~$300/mo minimum).
# PostgreSQL 16 on Enterprise with db-f1-micro is ~$7/mo.

echo "=== Creating Cloud SQL PostgreSQL 16 instance ==="
gcloud sql instances create "$INSTANCE" \
  --project="$PROJECT" \
  --database-version=POSTGRES_16 \
  --edition=enterprise \
  --tier=db-f1-micro \
  --region="$REGION" \
  --no-assign-ip \
  --network="$NETWORK" \
  --storage-type=SSD \
  --storage-size=10GB \
  --database-flags=log_min_duration_statement=1000

echo "=== Creating database ==="
gcloud sql databases create "$DATABASE" \
  --project="$PROJECT" \
  --instance="$INSTANCE"

echo "=== Setting postgres password ==="
echo "You will be prompted to set a password for the postgres user."
gcloud sql users set-password postgres \
  --instance="$INSTANCE" \
  --project="$PROJECT" \
  --prompt-for-password

echo "=== Applying schema ==="
echo "Enter the postgres password you just set:"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
gcloud sql connect "$INSTANCE" \
  --project="$PROJECT" \
  --database="$DATABASE" \
  --user=postgres \
  <"$SCRIPT_DIR/setup.sql"

CONN="${PROJECT}:${REGION}:${INSTANCE}"

echo ""
echo "Done."
echo "  Instance:   $INSTANCE (PostgreSQL 16, Enterprise, db-f1-micro)"
echo "  Database:   $DATABASE"
echo "  Connection: /cloudsql/${CONN}"
echo ""
echo "Next steps:"
echo "  1. Set DB_PASSWORD in your Cloud Run API service:"
echo "     gcloud run services update gomoku-api \\"
echo "       --project=$PROJECT --region=$REGION \\"
echo "       --add-cloudsql-instances=$CONN \\"
echo "       --set-env-vars=DB_SOCKET=/cloudsql/${CONN},DB_NAME=${DATABASE},DB_USER=postgres,DB_PASSWORD=<your-password>"
echo ""
echo "  2. Or deploy via Terraform (iac/cloud_run/) which handles this automatically."
