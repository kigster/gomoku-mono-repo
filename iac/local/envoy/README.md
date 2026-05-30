# Envoy Load Balancer for Gomoku

This directory contains Envoy Proxy configuration as an alternative to HAProxy for load balancing gomoku-httpd instances.

## Key Advantages Over HAProxy

- **Request Queueing**: Circuit breakers with `max_pending_requests: 1000` queue requests when all servers are busy, instead of returning 503 errors
- **HTTP Health Checks**: Uses the `/ready` endpoint which returns 503 when busy, allowing smarter routing
- **Automatic Retries**: Built-in retry policy for 503 errors with exponential backoff

## Installation

### macOS (Homebrew)

```bash
brew install envoy
```

### Linux (Ubuntu/Debian)

```bash
# Add Envoy GPG key and repo
sudo apt update
sudo apt install -y apt-transport-https gnupg2 curl lsb-release
curl -sL 'https://deb.dl.getenvoy.io/public/gpg.8115BA8E629CC074.key' | sudo gpg --dearmor -o /usr/share/keyrings/getenvoy-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/getenvoy-keyring.gpg] https://deb.dl.getenvoy.io/public/deb/ubuntu $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/getenvoy.list
sudo apt update
sudo apt install -y getenvoy-envoy
```

### Docker

```bash
docker pull envoyproxy/envoy:v1.28-latest
```

## Running Envoy

### Validate Configuration

```bash
envoy --mode validate -c iac/envoy/envoy.yaml
```

### Start Envoy (Foreground)

```bash
envoy -c iac/envoy/envoy.yaml
```

### Start Envoy with Docker

```bash
docker run --rm -it \
  --network host \
  -v $(pwd)/iac/envoy/envoy.yaml:/etc/envoy/envoy.yaml:ro \
  envoyproxy/envoy:v1.28-latest \
  -c /etc/envoy/envoy.yaml
```

## Configuration Overview

### Listener

Envoy listens on `127.0.0.1:10000` (same as HAProxy frontend), receiving requests from nginx.

### Cluster (Backend Pool)

The `gomoku_cluster` contains all 10 gomoku-httpd instances:

- Ports 9500-9504 (AZ-a primary servers)
- Ports 9505-9509 (AZ-b backup servers)

### Circuit Breakers (Request Queueing)

```yaml
circuit_breakers:
  thresholds:
    - priority: DEFAULT
      max_connections: 100
      max_pending_requests: 1000 # Queue up to 1000 requests
      max_requests: 100
      max_retries: 10
```

When all servers are busy:

1. New requests queue in Envoy (up to 1000)
1. As servers become available, queued requests are dispatched
1. Only after 1000 pending requests will Envoy return 503

### Health Checks

Envoy uses the `/ready` endpoint for health checks:

```yaml
health_checks:
  - timeout: 2s
    interval: 1s
    unhealthy_threshold: 2
    healthy_threshold: 1
    http_health_check:
      path: "/ready"
```

The `/ready` endpoint returns:

- `200 OK` with `{"status":"ready"}` when server is idle
- `503 Service Unavailable` with `{"status":"busy"}` when processing a request

### Load Balancing

Uses `LEAST_REQUEST` policy to route requests to the server with the fewest active connections, combined with health checks to prefer idle servers.

### Retry Policy

Automatic retries on 503 errors:

```yaml
retry_policy:
  retry_on: "503"
  num_retries: 3
  retry_back_off:
    base_interval: 0.1s
    max_interval: 10s
```

## Admin Interface

Envoy provides an admin interface at `http://127.0.0.1:9901` with:

- `/stats` - Prometheus-format metrics
- `/clusters` - Cluster and endpoint status
- `/config_dump` - Current configuration
- `/ready` - Envoy readiness status

### Useful Admin Endpoints

```bash
# Check cluster health
curl http://127.0.0.1:9901/clusters

# Get circuit breaker stats
curl http://127.0.0.1:9901/stats | grep circuit

# Check pending requests
curl http://127.0.0.1:9901/stats | grep pending
```

## Comparison: HAProxy vs Envoy

| Feature | HAProxy | Envoy |
| --------------- | ----------------------------- | -------------------------------------- |
| Health Check | TCP agent-check (drain/ready) | HTTP /ready endpoint |
| Request Queue | Limited (via maxconn) | Circuit breaker (max_pending_requests) |
| Retry Policy | Manual configuration | Built-in with backoff |
| Admin Interface | Stats page on :8404 | Full API on :9901 |
| Config Format | Custom DSL | YAML |
| Hot Reload | Via socket | Via xDS or SIGHUP |

## Switching Between HAProxy and Envoy

Both configurations listen on the same port (10000), so you can only run one at a time.

### Use HAProxy

```bash
# Stop Envoy if running
pkill envoy

# Start HAProxy
haproxy -f iac/config/haproxy.cfg
```

### Use Envoy

```bash
# Stop HAProxy if running
pkill haproxy

# Start Envoy
envoy -c iac/envoy/envoy.yaml
```

## Testing

1. Start gomoku-httpd servers:

   ```bash
   bin/gomoku-ctl start
   ```

1. Start Envoy:

   ```bash
   envoy -c iac/envoy/envoy.yaml
   ```

1. Run test clients:

   ```bash
   # Run multiple clients in parallel
   for i in {1..20}; do
     ./gomoku-http-client -p 10000 &
   done
   wait
   ```

1. Monitor Envoy stats:

   ```bash
   # Watch pending requests
   watch -n1 'curl -s http://127.0.0.1:9901/stats | grep pending'
   ```
