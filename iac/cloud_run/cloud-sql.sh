#!/usr/bin/env bash
set -euo pipefail

# Cloud SQL helper for the per-environment PostgreSQL 18 instance defined in
# cloud_sql.tf. Two subcommands:
#
#   cloud-sql.sh provision
#       terraform-applies ONLY the Cloud SQL resources (instance, database,
#       user, password secret, IAM). bin/deploy runs this before migrations
#       so the very first deploy has a database to migrate.
#
#   cloud-sql.sh exec -- <command> [args...]
#       Starts cloud-sql-proxy on 127.0.0.1:${CLOUD_SQL_PROXY_PORT:-5434},
#       exports DATABASE_URL pointing at it, runs <command>, then stops the
#       proxy. Used by bin/deploy for Alembic, and by humans for psql /
#       pg_restore (e.g. moving data off Supabase — see iac/README.md).
#
# Env: ENVIRONMENT (production | staging), PROJECT_ID, REGION, and for
# `provision` also TF_VAR_jwt_secret. Requires `cloud-sql-proxy`
# (brew install cloud-sql-proxy) and gcloud application-default credentials
# with roles/cloudsql.client + secretmanager.secretAccessor.

ENVIRONMENT="${ENVIRONMENT:-production}"
REGION="${REGION:-us-central1}"
PROXY_PORT="${CLOUD_SQL_PROXY_PORT:-5434}"
: "${PROJECT_ID:?Set PROJECT_ID to your GCP project ID}"

# Terraform runs via -chdir so `exec` keeps the caller's working directory
# (bin/deploy runs Alembic from api/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tf() { terraform -chdir="${SCRIPT_DIR}" "$@"; }

tf_init() {
  tf init -reconfigure -input=false \
    -backend-config="bucket=gomoku-tfstate" \
    -backend-config="prefix=cloud-run/${ENVIRONMENT}/gomoku" >/dev/null
}

provision() {
  : "${TF_VAR_jwt_secret:?Set TF_VAR_jwt_secret}"
  tf_init
  # httpd_image is a required var with no default; the targeted apply never
  # touches the services, so a placeholder is safe (deploy.sh does the same).
  tf apply \
    -target=google_sql_database.gomoku \
    -target=google_sql_user.gomoku \
    -target=google_secret_manager_secret_version.db_password \
    -target=google_secret_manager_secret_iam_member.db_password_access \
    -target=google_project_iam_member.cloudsql_client \
    -var="project_id=${PROJECT_ID}" \
    -var="region=${REGION}" \
    -var="environment=${ENVIRONMENT}" \
    -var="httpd_image=placeholder" \
    -var="cloud_sql_enabled=true" \
    -auto-approve
}

exec_with_proxy() {
  command -v cloud-sql-proxy >/dev/null ||
    {
      echo "ERROR: cloud-sql-proxy not found (brew install cloud-sql-proxy)" >&2
      exit 1
    }
  tf_init
  local conn secret password
  conn="$(tf output -raw cloud_sql_connection_name)"
  secret="$(tf output -raw cloud_sql_password_secret)"
  [[ -n "${conn}" ]] || {
    echo "ERROR: Cloud SQL is not provisioned for ${ENVIRONMENT} (run: $0 provision)" >&2
    exit 1
  }
  password="$(gcloud secrets versions access latest --secret="${secret}" --project="${PROJECT_ID}")"

  cloud-sql-proxy --address 127.0.0.1 --port "${PROXY_PORT}" "${conn}" &
  local proxy_pid=$!
  trap 'kill "${proxy_pid}" 2>/dev/null || true' EXIT

  # Wait up to ~15s for the proxy to accept connections.
  for _ in $(seq 1 30); do
    (exec 3<>"/dev/tcp/127.0.0.1/${PROXY_PORT}") 2>/dev/null && break
    sleep 0.5
  done

  # Password is alphanumeric (random_password special=false) — no escaping.
  DATABASE_URL="postgresql://gomoku:${password}@127.0.0.1:${PROXY_PORT}/gomoku" "$@"
}

case "${1:-}" in
provision) provision ;;
exec)
  shift
  [[ "${1:-}" == "--" ]] && shift
  (($# > 0)) || {
    echo "usage: $0 exec -- <command> [args...]" >&2
    exit 2
  }
  exec_with_proxy "$@"
  ;;
*)
  echo "usage: $0 provision | exec -- <command> [args...]" >&2
  exit 2
  ;;
esac
