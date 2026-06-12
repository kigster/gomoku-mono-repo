#!/usr/bin/env bash
set -euo pipefail

# Per-environment Cloud Run deploy. Driven by these env vars (set by
# bin/deploy from the .env file):
#   ENVIRONMENT      production | staging   (default: production)
#   PROJECT_ID       GCP project id
#   REGION           GCP region (default: us-central1)
#   TF_VAR_jwt_secret
#   TF_VAR_database_url
#   TF_VAR_honeycomb_api_key   (optional)
#   TF_VAR_honeycomb_dataset   (optional)
#   TF_VAR_custom_domain       (optional)
#
# Per-env knobs (defaults baked in TF):
#   TF_VAR_api_min_instances   prod=1, staging=0
#   TF_VAR_api_max_instances
#   TF_VAR_httpd_min_instances
#   TF_VAR_httpd_max_instances
#
# Per-env state lives at gs://gomoku-tfstate/cloud-run/${ENVIRONMENT}/gomoku
# so prod and staging are completely isolated.

ENVIRONMENT="${ENVIRONMENT:-production}"
REGION="${REGION:-us-central1}"
REPO_NAME="gomoku-repo"

# Required environment variables
: "${PROJECT_ID:?Set PROJECT_ID to your GCP project ID}"
: "${TF_VAR_jwt_secret:?Set TF_VAR_jwt_secret (openssl rand -base64 32)}"
: "${TF_VAR_database_url:?Set TF_VAR_database_url to your PostgreSQL DSN}"

# Make ENVIRONMENT visible to Terraform too.
export TF_VAR_environment="${ENVIRONMENT}"

export PROJECT_ID
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "Deploying ENVIRONMENT=$ENVIRONMENT to project=$PROJECT_ID region=$REGION"

# 1. Initialize Terraform with the per-environment state prefix. -reconfigure
#    discards any prior backend config so re-running deploy.sh against a
#    different ENVIRONMENT swaps state cleanly.
echo "Initializing Terraform (state prefix: cloud-run/${ENVIRONMENT}/gomoku)..."
terraform init -reconfigure -upgrade \
  -backend-config="bucket=gomoku-tfstate" \
  -backend-config="prefix=cloud-run/${ENVIRONMENT}/gomoku"

# 2. Enable APIs and create Artifact Registry (the registry is shared across
#    environments — it's a project-level resource keyed by REPO_NAME).
echo "Ensuring APIs and registry exist..."
terraform apply \
  -target=google_project_service.run_api \
  -target=google_project_service.artifact_registry_api \
  -target=google_project_service.cloudbuild_api \
  -target=google_artifact_registry_repository.repo \
  -var="project_id=$PROJECT_ID" \
  -var="region=$REGION" \
  -var="environment=$ENVIRONMENT" \
  -var="httpd_image=placeholder" \
  -var="jwt_secret=$TF_VAR_jwt_secret" \
  -var="database_url=$TF_VAR_database_url" \
  -auto-approve

# 3. Configure Docker auth for Artifact Registry
gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet

# 4. Build and push Docker images. We tag with the env so prod and staging
#    images don't trample each other in the registry.
#    Push the human-readable tag, but pass the immutable digest
#    (@sha256:...) to Terraform — without the digest, Terraform sees the
#    same `:latest` string every deploy and Cloud Run keeps serving the
#    old revision.
REGISTRY="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO_NAME"

resolve_digest() {
  local image="$1"
  local digest
  digest=$(docker inspect --format='{{range .RepoDigests}}{{.}}{{"\n"}}{{end}}' "$image" 2>/dev/null |
    grep -F "${image%:*}@" | head -n1)
  if [[ -z "$digest" ]]; then
    digest=$(gcloud artifacts docker images describe "$image" \
      --format="value(image_summary.digest)" 2>/dev/null)
    [[ -n "$digest" ]] && digest="${image%:*}@${digest}"
  fi
  [[ -z "$digest" ]] && {
    echo "ERROR: could not resolve digest for $image" >&2
    exit 1
  }
  echo "$digest"
}

HTTPD_TAG="$REGISTRY/gomoku-httpd:${ENVIRONMENT}"
echo "Building and pushing gomoku-httpd ($HTTPD_TAG)..."
docker buildx build --platform linux/amd64 -t "$HTTPD_TAG" --load "$REPO_ROOT/gomoku-c/"
docker push "$HTTPD_TAG"
HTTPD_IMAGE="$(resolve_digest "$HTTPD_TAG")"
echo "  → $HTTPD_IMAGE"

# Rust premium engine — one image, deployed to every var.rust_tiers service.
RUST_TAG="$REGISTRY/gomoku-httpd-rust:${ENVIRONMENT}"
echo "Building and pushing gomoku-httpd-rust ($RUST_TAG)..."
docker buildx build --platform linux/amd64 -t "$RUST_TAG" --load "$REPO_ROOT/gomoku-httpd-rust/"
docker push "$RUST_TAG"
RUST_IMAGE="$(resolve_digest "$RUST_TAG")"
echo "  → $RUST_IMAGE"

API_TAG="$REGISTRY/gomoku-api:${ENVIRONMENT}"
echo "Building and pushing gomoku-api ($API_TAG)..."
docker buildx build --platform linux/amd64 -t "$API_TAG" --load "$REPO_ROOT/api/"
docker push "$API_TAG"
API_IMAGE="$(resolve_digest "$API_TAG")"
echo "  → $API_IMAGE"

# 5. Apply the full stack. Pass all TF_VAR_* env vars implicitly — only the
#    required ones are repeated here as `-var` for clarity / failure-fast.
echo "Applying Terraform (full stack)..."
terraform apply \
  -var="project_id=$PROJECT_ID" \
  -var="region=$REGION" \
  -var="environment=$ENVIRONMENT" \
  -var="httpd_image=$HTTPD_IMAGE" \
  -var="rust_httpd_image=$RUST_IMAGE" \
  -var="api_image=$API_IMAGE" \
  -var="jwt_secret=$TF_VAR_jwt_secret" \
  -var="database_url=$TF_VAR_database_url" \
  -auto-approve

echo ""
echo "Deployment complete (environment: $ENVIRONMENT)!"
echo "Game engine (internal): $(terraform output -raw httpd_url)"
echo "API + SPA (public):     $(terraform output -raw api_url)"
if [[ -n "${TF_VAR_custom_domain:-}" ]]; then
  echo "Custom domain:          ${TF_VAR_custom_domain}"
  echo ""
  echo "DNS records to add at your registrar:"
  terraform output -json custom_domain_dns_records | jq -r '
        if length == 0 then "  (none — apex A records may need to be added manually; see iac/README.md)"
        else .[] | "  \(.type)  \(.name)  →  \(.rrdata)"
        end
    ' 2>/dev/null || terraform output custom_domain_dns_records
fi
