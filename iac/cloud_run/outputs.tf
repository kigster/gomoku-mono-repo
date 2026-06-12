output "httpd_url" {
  description = "The URL of the gomoku-httpd Cloud Run service (internal)"
  value       = google_cloud_run_v2_service.httpd.uri
}

output "httpd_rust_urls" {
  description = "Map of vCPU tier → gomoku-httpd-rust premium service URL (internal)"
  value       = { for k, s in google_cloud_run_v2_service.httpd_rust : k => s.uri }
}

output "api_url" {
  description = "The URL of the gomoku-api Cloud Run service (public)"
  value       = google_cloud_run_v2_service.api.uri
}

output "artifact_registry_repo" {
  description = "The Artifact Registry repository path"
  value       = google_artifact_registry_repository.repo.name
}

output "custom_domain" {
  description = "Custom domain mapped to gomoku-api (empty when not configured)"
  value       = var.custom_domain
}

output "custom_domain_dns_records" {
  description = "DNS records to add at your DNS provider so Google can provision TLS"
  value = (
    var.custom_domain != ""
    ? google_cloud_run_domain_mapping.api[0].status[0].resource_records
    : []
  )
}
