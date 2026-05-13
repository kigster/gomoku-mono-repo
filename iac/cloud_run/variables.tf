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
# `email_provider = "sendgrid"` activates real outbound mail; "stdout"
# (the default) just logs the rendered template so dev/staging can run
# without a SendGrid key. See api/app/email.py for the provider switch.

variable "email_provider" {
  description = "Email delivery backend: 'stdout' logs the rendered body; 'sendgrid' sends via the SendGrid Web API."
  type        = string
  default     = "stdout"
  validation {
    condition     = contains(["stdout", "sendgrid"], var.email_provider)
    error_message = "email_provider must be one of: stdout, sendgrid."
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
