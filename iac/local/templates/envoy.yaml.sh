#!/usr/bin/env bash
# Generate envoy.yaml with a dynamic number of backend workers.
# Usage: envoy.yaml.sh <num_workers>
set -euo pipefail

WORKERS="${1:-10}"
BASE_PORT=9500

cat <<'HEADER'
# envoy.yaml - Auto-generated from iac/local/templates/envoy.yaml.sh
# Frontend listens on port 10000, backends are gomoku-httpd instances.
#
# Usage: envoy -c iac/envoy/envoy.yaml

admin:
  address:
    socket_address:
      address: 127.0.0.1
      port_value: 9901

static_resources:
  listeners:
    - name: gomoku_listener
      address:
        socket_address:
          address: 127.0.0.1
          port_value: 10000
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: gomoku_http
                codec_type: AUTO
                request_timeout: 600s
                common_http_protocol_options:
                  idle_timeout: 600s
                route_config:
                  name: gomoku_route
                  virtual_hosts:
                    - name: gomoku_service
                      domains: ["*"]
                      routes:
                        - match:
                            prefix: "/"
                          route:
                            cluster: gomoku_cluster
                            timeout: 600s
                            retry_policy:
                              retry_on: "5xx"
                              num_retries: 3
                              per_try_timeout: 600s
                              retry_back_off:
                                base_interval: 0.1s
                                max_interval: 10s
                http_filters:
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router

  clusters:
    - name: gomoku_cluster
      connect_timeout: 5s
      type: STATIC
      lb_policy: LEAST_REQUEST

      circuit_breakers:
        thresholds:
          - priority: DEFAULT
            max_connections: 100
            max_pending_requests: 1000
            max_requests: 100
            max_retries: 10

      health_checks:
        - timeout: 2s
          interval: 1s
          unhealthy_threshold: 2
          healthy_threshold: 1
          http_health_check:
            path: "/health"

      typed_extension_protocol_options:
        envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
          "@type": type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
          common_http_protocol_options:
            idle_timeout: 600s
          explicit_http_config:
            http_protocol_options: {}

      outlier_detection:
        consecutive_5xx: 5
        interval: 10s
        base_ejection_time: 30s
        max_ejection_percent: 50

      load_assignment:
        cluster_name: gomoku_cluster
        endpoints:
          - lb_endpoints:
HEADER

for ((i = 0; i < WORKERS; i++)); do
  port=$((BASE_PORT + i))
  cat <<EOF
              # gomoku-httpd instance $((i + 1))
              - endpoint:
                  address:
                    socket_address:
                      address: 127.0.0.1
                      port_value: ${port}
EOF
done
