#!/usr/bin/env bash
set -e

# FastAPI backend URL (internal Cloud Run service or docker-compose service)
export API_URL="${API_URL:-gomoku-api:8000}"

echo "Starting nginx with API backend: http://${API_URL}"

# Substitute only our variable in the nginx config template
envsubst '${API_URL}' \
  </etc/nginx/conf.d/gomoku.conf.template \
  >/etc/nginx/conf.d/gomoku.conf

exec nginx -g 'daemon off;'
