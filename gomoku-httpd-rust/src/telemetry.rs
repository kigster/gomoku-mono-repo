//! Honeycomb / OpenTelemetry wiring.
//!
//! When both a Honeycomb ingest key and a dataset name are present in the
//! environment, a global OTLP/HTTP tracer is installed that batches spans to
//! Honeycomb. Otherwise the call is a silent no-op so local dev runs aren't
//! forced to configure a backend.
//!
//! Each variable is looked up under the bare name and three deployment-env
//! prefixed names — the first non-empty match wins. This lets a single shell
//! profile keep distinct keys for staging/production/development side-by-side
//! without juggling per-shell exports.
//!
//! Honeycomb classic keys (32 chars) require the `x-honeycomb-dataset` header;
//! newer environment-keyed ingest routes by `service.name` alone. We send the
//! header unconditionally since the user explicitly names a dataset.

use std::collections::HashMap;
use std::env;

use log::{info, warn};
use opentelemetry::KeyValue;
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::trace as sdktrace;
use opentelemetry_sdk::{Resource, runtime::Tokio};

pub const SERVICE_NAME: &str = "gomoku-httpd-rust";

const HONEYCOMB_ENDPOINT: &str = "https://api.honeycomb.io/v1/traces";

/// Ordered list of env-var names to probe for a given setting. First entry
/// is the bare unsuffixed name; remaining entries are deployment-env
/// prefixed variants.
const API_KEY_VARS: &[&str] = &[
    "HONEYCOMB_INGEST_API_KEY",
    "PRODUCTION_HONEYCOMB_INGEST_API_KEY",
    "STAGING_HONEYCOMB_INGEST_API_KEY",
    "DEVELOPMENT_HONEYCOMB_INGEST_API_KEY",
];

const DATASET_VARS: &[&str] = &[
    "HONEYCOMB_DATASET",
    "PRODUCTION_HONEYCOMB_DATASET",
    "STAGING_HONEYCOMB_DATASET",
    "DEVELOPMENT_HONEYCOMB_DATASET",
];

/// Return `(value, name)` for the first env var in `candidates` that holds a
/// non-empty value, or `None` if none of them do.
fn lookup_env(candidates: &[&'static str]) -> Option<(String, &'static str)> {
    candidates.iter().find_map(|name| {
        env::var(name)
            .ok()
            .filter(|s| !s.is_empty())
            .map(|v| (v, *name))
    })
}

/// Install a global OTLP/HTTP tracer that exports to Honeycomb.
///
/// Returns `true` if telemetry was wired up, `false` if either the api-key
/// or dataset env var is missing/empty or if the SDK refused to initialize.
pub fn init_tracer(service_version: &'static str) -> bool {
    let api_key = lookup_env(API_KEY_VARS);
    let dataset = lookup_env(DATASET_VARS);

    let ((api_key, api_key_var), (dataset, dataset_var)) = match (api_key, dataset) {
        (Some(k), Some(d)) => (k, d),
        (None, None) => return false,
        (Some((_, k_var)), None) => {
            warn!(
                "telemetry disabled: {} set but no {} variant is set",
                k_var, "HONEYCOMB_DATASET"
            );
            return false;
        }
        (None, Some((_, d_var))) => {
            warn!(
                "telemetry disabled: {} set but no {} variant is set",
                d_var, "HONEYCOMB_INGEST_API_KEY"
            );
            return false;
        }
    };

    let mut headers = HashMap::new();
    headers.insert("x-honeycomb-team".to_string(), api_key);
    headers.insert("x-honeycomb-dataset".to_string(), dataset.clone());

    let endpoint = env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| HONEYCOMB_ENDPOINT.to_string());

    let exporter = opentelemetry_otlp::new_exporter()
        .http()
        .with_endpoint(&endpoint)
        .with_headers(headers);

    let resource = Resource::new(vec![
        KeyValue::new("service.name", SERVICE_NAME),
        KeyValue::new("service.version", service_version),
        KeyValue::new(
            "deployment.environment",
            env::var("ENVIRONMENT").unwrap_or_else(|_| "development".to_string()),
        ),
    ]);

    let install = opentelemetry_otlp::new_pipeline()
        .tracing()
        .with_exporter(exporter)
        .with_trace_config(sdktrace::config().with_resource(resource))
        .install_batch(Tokio);

    match install {
        Ok(_tracer) => {
            // install_batch already registered the provider as global.
            info!(
                "telemetry enabled: service={} dataset={} (from {}) key_from={} endpoint={}",
                SERVICE_NAME, dataset, dataset_var, api_key_var, endpoint
            );
            true
        }
        Err(e) => {
            warn!("telemetry init failed: {}", e);
            false
        }
    }
}

/// Flush pending spans and tear the tracer down. Called at process exit.
pub fn shutdown() {
    opentelemetry::global::shutdown_tracer_provider();
}

/// Return the tracer this binary uses for all spans. Cheap to call — the
/// global no-op tracer is used when telemetry was never initialized.
pub fn tracer() -> opentelemetry::global::BoxedTracer {
    opentelemetry::global::tracer(SERVICE_NAME)
}

/// Open a span on the named tracer. Returns a `BoxedSpan` so callers can set
/// attributes and end it at the right moment without dragging the full
/// `Tracer` trait into scope.
pub fn start_span(name: &'static str) -> opentelemetry::global::BoxedSpan {
    use opentelemetry::trace::Tracer;
    tracer().start(name)
}
