variable "project_id" {
  description = "The Google Cloud Project ID"
  type        = string
}

variable "region" {
  description = "The Google Cloud region to deploy to"
  type        = string
  default     = "us-central1"
}

# Environment selector. Drives:
#   - Cloud Run service names: production keeps the bare names
#     (`gomoku-api`, `gomoku-httpd`); other envs append `-${env}`
#     (`gomoku-api-staging`, `gomoku-httpd-staging`).
#   - The ENVIRONMENT runtime env var on the api container so Pydantic +
#     the OTLP exporter pick the right config.
#   - Default sizing knobs (api min_instances, httpd max_instances).
# State separation per environment is handled at `terraform init` time
# via `-backend-config="prefix=cloud-run/${ENVIRONMENT}/gomoku"`, NOT
# here — keep this var purely declarative.
variable "environment" {
  description = "Deployment environment name (production | staging | other)"
  type        = string
  default     = "production"
  validation {
    condition     = contains(["production", "staging"], var.environment)
    error_message = "environment must be one of: production, staging."
  }
}

variable "httpd_image" {
  description = "Docker image for gomoku-httpd (C game engine)"
  type        = string
}

variable "api_image" {
  description = "Docker image for gomoku-api (FastAPI + React SPA)"
  type        = string
  default     = "placeholder"
}

variable "rust_httpd_image" {
  description = "Docker image for gomoku-httpd-rust (Rust premium engine). Deployed to every rust_tiers service."
  type        = string
  default     = "placeholder"
}

# Premium Rust engine tiers, keyed by vCPU count. Each key becomes its own
# scale-to-zero Cloud Run service (`gomoku-httpd-rust-<k>vcpu`) sized per the
# object. The FastAPI router picks a tier per game from a verified entitlement
# token. Cloud Run caps vCPU at 8 per instance; memory minimums apply
# (4 vCPU ≥ 2Gi, 8 vCPU ≥ 4Gi) — the defaults below sit at those minimums.
variable "rust_tiers" {
  description = "Map of vCPU count → Cloud Run cpu/memory sizing for each premium Rust tier."
  type = map(object({
    cpu    = string
    memory = string
  }))
  default = {
    "2" = { cpu = "2000m", memory = "1Gi" }
    "4" = { cpu = "4000m", memory = "2Gi" }
    "8" = { cpu = "8000m", memory = "4Gi" }
  }
}

variable "rust_max_instances" {
  description = "Max instances per Rust premium tier. Each premium game pins one instance (concurrency=1)."
  type        = number
  default     = 4
}

variable "premium_vcpu_coefficient" {
  description = "Premium game price = vcpus × this coefficient (USD). 0.5 → 2/4/8 vCPU = $1/$2/$4."
  type        = number
  default     = 0.5
}

# httpd is single-threaded (max_instance_request_concurrency = 1) so each
# inflight game move pins an entire instance. The api is configured for
# 80 concurrent in-flight requests, so production needs at least
# httpd_max_instances == 80 to fully saturate one api instance without
# queueing.
variable "httpd_min_instances" {
  description = "Minimum number of gomoku-httpd instances to keep warm. 0 = scale to zero."
  type        = number
  default     = 0
}

variable "httpd_max_instances" {
  description = "Maximum number of gomoku-httpd instances. >= api_max_instances * 80 to avoid queueing."
  type        = number
  default     = 80
}

variable "api_min_instances" {
  description = "Minimum number of gomoku-api instances to keep warm. Production: 1. Staging: 0."
  type        = number
  default     = 1
}

variable "api_max_instances" {
  description = "Maximum number of gomoku-api instances."
  type        = number
  default     = 5
}

variable "jwt_secret" {
  description = "JWT signing secret for the API"
  type        = string
  sensitive   = true
}

variable "database_url" {
  description = "PostgreSQL connection string (e.g. Neon DSN)"
  type        = string
  sensitive   = true
}

variable "cors_origins" {
  description = "List of allowed CORS origins"
  type        = list(string)
  default     = ["*"]
}

variable "honeycomb_api_key" {
  description = "Honeycomb ingest key for OTLP traces. Empty disables tracing."
  type        = string
  default     = ""
  sensitive   = true
}

variable "honeycomb_dataset" {
  description = "Honeycomb dataset name for classic keys. Ignored for env-aware keys."
  type        = string
  default     = ""
}

variable "custom_domain" {
  description = "Custom domain to map to gomoku-api (e.g. gomoku.us, app.gomoku.us, staging.gomoku.games). Empty disables the mapping."
  type        = string
  default     = ""
}

# ─── Email (password reset, account notifications) ────────────────────
# `email_provider` selects the delivery backend on Cloud Run. Deployed
# environments use 'sendgrid' (the default); 'localsmtp' targets a local mail
# catcher and only makes sense in dev. See api/app/services/email.py for the
# registry of providers.

variable "email_provider" {
  description = "Email delivery backend: 'sendgrid' or 'resend' send via their Web APIs; 'localsmtp' posts to a local SMTP server (dev only)."
  type        = string
  default     = "sendgrid"
  validation {
    condition     = contains(["sendgrid", "resend", "localsmtp"], var.email_provider)
    error_message = "email_provider must be one of: sendgrid, resend, localsmtp."
  }
}

variable "email_from" {
  description = "From address for outbound mail. Must be a verified sender in SendGrid when email_provider='sendgrid'."
  type        = string
  default     = "gomoku@email.gomoku.games"
}

variable "email_from_name" {
  description = "Display name for the From header."
  type        = string
  default     = "Gomoku Support"
}

variable "sendgrid_api_key" {
  description = "SendGrid API key. Required when email_provider='sendgrid'. Generate at https://app.sendgrid.com/settings/api_keys with 'Mail Send' permission."
  type        = string
  default     = ""
  sensitive   = true
}

variable "resend_api_key" {
  description = "Resend API key. Required when email_provider='resend'. Generate at https://resend.com/api-keys with send access."
  type        = string
  default     = ""
  sensitive   = true
}
