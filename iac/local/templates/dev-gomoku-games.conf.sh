#!/usr/bin/env bash
# Generate the per-site nginx config (server blocks) for dev.gomoku.games.
# Global http{} settings live in iac/local/nginx.conf; this file is included
# from there via sites-enabled/.
# Usage: dev-gomoku-games.conf.sh [api_port] [ssl_cert] [ssl_key]
# shellcheck disable=SC2155
set -euo pipefail

export API_PORT="${1:-8000}"
export LETSENCRYPT_CERTIFICATE="${2:-${HOME}/.letsencrypt/live/dev.gomoku.games/fullchain.pem}"
export LETSENCRYPT_PRIVATE_KEY="${3:-${HOME}/.letsencrypt/live/dev.gomoku.games/privkey.pem}"

export SCRIPT_DIR="$(cd "$(dirname "$(dirname "${BASH_SOURCE[0]}")")" && pwd -P)"
export PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
export STATIC_DIR="${PROJECT_DIR}/api/public"

cat <<CONF
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
          add_header Content-Type application/json;
          return 200 '{"status":"OK"}';
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
CONF
