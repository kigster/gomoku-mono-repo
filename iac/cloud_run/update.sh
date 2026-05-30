#!/usr/bin/env bash
set -euo pipefail

REGION="us-central1"
REPO_NAME="gomoku-repo"
PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID to your GCP project ID}"
REGISTRY="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO_NAME"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Which services to update (default: both)
SERVICES="${*:-httpd api}"

gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet

if [[ "$SERVICES" == *"httpd"* ]]; then
  IMAGE="$REGISTRY/gomoku-httpd:latest"
  echo "Building and pushing gomoku-httpd..."
  docker buildx build --platform linux/amd64 -t "$IMAGE" --load "$REPO_ROOT/gomoku-c/"
  docker push "$IMAGE"
  gcloud run services update gomoku-httpd --region="$REGION" --image="$IMAGE"
fi

if [[ "$SERVICES" == *"api"* ]]; then
  IMAGE="$REGISTRY/gomoku-api:latest"
  echo "Building and pushing gomoku-api..."
  docker buildx build --platform linux/amd64 -t "$IMAGE" --load "$REPO_ROOT/api/"
  docker push "$IMAGE"
  gcloud run services update gomoku-api --region="$REGION" --image="$IMAGE"
fi

echo "Update complete."
