# ──────────────────────────────────────────────
# Cloud SQL — PostgreSQL 18 (optional, per environment)
# ──────────────────────────────────────────────
# Enabled with var.cloud_sql_enabled. When on, the api reaches the
# instance through the Cloud Run Cloud SQL connector (unix socket under
# /cloudsql) — public IP with no authorized networks, so nothing can
# connect except through the IAM-gated connector / cloud-sql-proxy. No VPC,
# no Serverless VPC connector, nothing billed beyond the instance itself.
#
# Cost: Cloud SQL has no always-free tier. db-f1-micro (shared core,
# 0.6 GB RAM) on the ENTERPRISE edition is the cheapest tier available,
# roughly $9-10/month plus ~$0.17/GB-month of SSD. db-f1-micro is only
# valid under ENTERPRISE — PG16+ defaults to ENTERPRISE_PLUS, so the
# edition must be explicit.
#
# Connection ceiling: db-f1-micro defaults to max_connections = 25. Each
# api instance opens an asyncpg pool of up to 10 (api/app/database.py), so
# keep var.api_max_instances <= 2 on this tier or bump the tier.
#
# Mirrors qualified-at's iac/modules/gcp_stack Cloud SQL wiring.

locals {
  cloud_sql_instance_name = "gomoku-db${local.name_suffix}"
  cloud_sql_secret_id     = "gomoku-db-password${local.name_suffix}"
  cloud_sql_db_name       = "gomoku"
  cloud_sql_db_user       = "gomoku"
  # The api runs as the default compute service account (no
  # service_account set on the template). Computed from the project number
  # rather than read off the api service, so the IAM grants below can be
  # created BEFORE the api revision that needs them.
  runtime_service_account = "${data.google_project.current.number}-compute@developer.gserviceaccount.com"
}

data "google_project" "current" {}

resource "google_project_service" "sqladmin_api" {
  count              = var.cloud_sql_enabled ? 1 : 0
  service            = "sqladmin.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "secretmanager_api" {
  count              = var.cloud_sql_enabled ? 1 : 0
  service            = "secretmanager.googleapis.com"
  disable_on_destroy = false
}

# Alphanumeric only, so the password can be dropped into a DSN without
# URL-escaping (iac/cloud_run/cloud-sql.sh builds one for migrations).
resource "random_password" "db_password" {
  count   = var.cloud_sql_enabled ? 1 : 0
  length  = 32
  special = false
}

resource "google_sql_database_instance" "postgres" {
  count            = var.cloud_sql_enabled ? 1 : 0
  name             = local.cloud_sql_instance_name
  database_version = "POSTGRES_18"
  region           = var.region

  settings {
    tier              = var.cloud_sql_tier
    edition           = "ENTERPRISE" # shared-core tiers are invalid under ENTERPRISE_PLUS
    availability_type = "ZONAL"

    disk_type             = "PD_SSD"
    disk_size             = var.cloud_sql_disk_size_gb
    disk_autoresize       = true
    disk_autoresize_limit = var.cloud_sql_disk_autoresize_limit_gb

    # API-level guard, independent of Terraform's own deletion_protection.
    deletion_protection_enabled = var.cloud_sql_deletion_protection

    ip_configuration {
      # The Cloud Run connector and cloud-sql-proxy both dial the public IP
      # over mTLS; with no authorized_networks nothing else can reach it.
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      start_time                     = "09:00" # UTC
      point_in_time_recovery_enabled = false   # WAL retention costs storage
      backup_retention_settings {
        retained_backups = 7
      }
    }

    maintenance_window {
      day          = 7 # Sunday
      hour         = 10
      update_track = "stable"
    }

    database_flags {
      name  = "log_min_duration_statement"
      value = "1000"
    }
  }

  deletion_protection = var.cloud_sql_deletion_protection
  depends_on          = [google_project_service.sqladmin_api]
}

resource "google_sql_database" "gomoku" {
  count    = var.cloud_sql_enabled ? 1 : 0
  name     = local.cloud_sql_db_name
  instance = google_sql_database_instance.postgres[0].name
}

resource "google_sql_user" "gomoku" {
  count    = var.cloud_sql_enabled ? 1 : 0
  name     = local.cloud_sql_db_user
  instance = google_sql_database_instance.postgres[0].name
  password = random_password.db_password[0].result
}

# The password lives in Secret Manager; Cloud Run injects it as
# DB_PASSWORD, so it never appears as a plain env value in the console.
# (It is still in Terraform state — keep gs://gomoku-tfstate private.)
resource "google_secret_manager_secret" "db_password" {
  count     = var.cloud_sql_enabled ? 1 : 0
  secret_id = local.cloud_sql_secret_id
  replication {
    auto {}
  }
  depends_on = [google_project_service.secretmanager_api]
}

resource "google_secret_manager_secret_version" "db_password" {
  count       = var.cloud_sql_enabled ? 1 : 0
  secret      = google_secret_manager_secret.db_password[0].id
  secret_data = random_password.db_password[0].result
}

resource "google_secret_manager_secret_iam_member" "db_password_access" {
  count     = var.cloud_sql_enabled ? 1 : 0
  secret_id = google_secret_manager_secret.db_password[0].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.runtime_service_account}"
}

resource "google_project_iam_member" "cloudsql_client" {
  count   = var.cloud_sql_enabled ? 1 : 0
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${local.runtime_service_account}"
}
