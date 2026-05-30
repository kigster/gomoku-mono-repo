#!/usr/bin/env bash
# Generate nginx.conf for local development.
# Usage: nginx.conf.sh [api_port] [nginx_user] [ssl_cert] [ssl_key]
# shellcheck disable=SC2155
set -euo pipefail

export API_PORT="${1:-8000}"
export NGINX_USER="${2:-${USER}}"
export LETSENCRYPT_CERTIFICATE="${3:-${HOME}/.letsencrypt/live/dev.gomoku.games/fullchain.pem}"
export LETSENCRYPT_PRIVATE_KEY="${4:-${HOME}/.letsencrypt/live/dev.gomoku.games/privkey.pem}"

export SCRIPT_DIR="$(cd "$(dirname "$(dirname "${BASH_SOURCE[0]}")")" && pwd -P)"
export PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
export STATIC_DIR="${PROJECT_DIR}/api/public"

declare CONNECTION_METHOD
if [[ ${OSTYPE:-} == darwin* ]]; then
  CONNECTION_METHOD=kqueue
else
  CONNECTION_METHOD=epoll
fi

cat <<CONF
# nginx.conf — Local development reverse proxy for dev.gomoku.games
# Serves static assets directly, proxies API routes to FastAPI (:${API_PORT}).
# FastAPI handles /game/play proxy to gomoku-httpd via envoy internally.

user ${NGINX_USER} staff;

worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

events {
    worker_connections 1024;
    multi_accept on;
    use ${CONNECTION_METHOD};
}

http {
    include /opt/homebrew/etc/nginx/mime.types;
    default_type application/octet-stream;

    log_format main '\$remote_addr - \$remote_user [\$time_local] "\$request" '
                    '\$status \$body_bytes_sent "\$http_referer" '
                    '"\$http_user_agent" '
                    'rt=\$request_time urt="\$upstream_response_time"';

    access_log /var/log/nginx/access.log main;

    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;

    # Gzip
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml application/json application/javascript
               application/xml application/xml+rss text/javascript image/svg+xml;

    # Rate limiting
    limit_req_zone \$binary_remote_addr zone=api_limit:10m rate=30r/s;

    # FastAPI backend
    upstream api_backend {
        server 127.0.0.1:${API_PORT};
        keepalive 32;
    }

    server {
        listen 80;
        server_name localhost;

        location /nginx_status {
            stub_status on;
            access_log off;
            allow 127.0.0.1;        # Permit localhost to view status
            deny all;               # Restrict public access
        }

        location /health {
             access_log off;
             return 200 '"{ "status": "OK" }';
             add_header Content-Type application/json;
        }
    }

    # --- HTTP: redirect to HTTPS ------------------------------------------------
    server {
        listen 80;
        server_name dev.gomoku.games;
        return 301 https://\$server_name\$request_uri;
    }

    # --- HTTPS: main server block ------------------------------------------------
    server {
        listen 443 ssl;
        http2 on;
        server_name dev.gomoku.games;

        # SSL
        ssl_certificate     ${LETSENCRYPT_CERTIFICATE};
        ssl_certificate_key ${LETSENCRYPT_PRIVATE_KEY};
        ssl_session_timeout 1d;
        ssl_session_cache   shared:SSL:10m;
        ssl_session_tickets off;
        ssl_protocols       TLSv1.2 TLSv1.3;
        ssl_ciphers         ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
        ssl_prefer_server_ciphers off;

        # Security headers
        add_header X-Frame-Options    "SAMEORIGIN" always;
        add_header X-Content-Type-Options "nosniff" always;

        # ----- nginx own health check -----
        location = /nginx-health {
            access_log off;
            return 200 "healthy\n";
            add_header Content-Type text/plain;
        }

        # ----- Static assets (Vite-hashed filenames, long cache) -----
        location /assets/ {
            alias ${STATIC_DIR}/assets/;
            expires 1y;
            add_header Cache-Control "public, immutable";
            access_log off;
        }

        # ----- API routes → FastAPI -----
        location ~ ^/(auth|chat|game|leaderboard|user|multiplayer|social|health) {
            limit_req zone=api_limit burst=40 nodelay;

            proxy_pass         http://api_backend;
            proxy_http_version 1.1;
            proxy_set_header   Host              \$host;
            proxy_set_header   X-Real-IP         \$remote_addr;
            proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
            proxy_set_header   X-Forwarded-Proto \$scheme;
            proxy_set_header   Connection        "";

            # AI moves via /game/play can take a while
            proxy_connect_timeout 5s;
            proxy_send_timeout    120s;
            proxy_read_timeout    120s;

            proxy_buffering    on;
            proxy_buffer_size  8k;
            proxy_buffers      8 8k;
        }

        # ----- SPA fallback: serve static files or index.html -----
        location / {
            root ${STATIC_DIR};
            try_files \$uri /index.html;
        }
    }
}
CONF
