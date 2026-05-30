#!/usr/bin/env bash
set -euo pipefail

# Resolves geolocation for game records that have an IP but no geo data.
# Uses ip-api.com's free JSON endpoint (limit: 45 req/min, no key needed).
# Run periodically via cron or Cloud Scheduler.

DB_HOST="${DB_HOST:-/cloudsql/fine-booking-486503-k7:us-central1:gomoku-db}"
DB_NAME="${DB_NAME:-gomoku}"
DB_USER="${DB_USER:-postgres}"

PSQL="psql -X -h $DB_HOST -U $DB_USER -d $DB_NAME -t -A"

# Fetch IPs needing resolution (batch of 40 to stay under rate limit)
IPS=$($PSQL -c "SELECT id || '|' || host(client_ip) FROM games_pending_geo LIMIT 40")

if [ -z "$IPS" ]; then
  echo "No IPs to resolve."
  exit 0
fi

while IFS='|' read -r id ip; do
  # Skip private/reserved ranges
  if [[ "$ip" =~ ^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|127\.) ]]; then
    $PSQL -c "UPDATE games SET geo_country='Local', geo_city='Local' WHERE id=$id" >/dev/null
    continue
  fi

  # Query ip-api.com (free, no key, JSON response)
  GEO=$(curl -sf "http://ip-api.com/json/${ip}?fields=status,country,regionName,city,lat,lon" 2>/dev/null || echo '{}')

  STATUS=$(echo "$GEO" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','fail'))" 2>/dev/null || echo "fail")

  if [ "$STATUS" = "success" ]; then
    COUNTRY=$(echo "$GEO" | python3 -c "import sys,json; print(json.load(sys.stdin)['country'])")
    REGION=$(echo "$GEO" | python3 -c "import sys,json; print(json.load(sys.stdin)['regionName'])")
    CITY=$(echo "$GEO" | python3 -c "import sys,json; print(json.load(sys.stdin)['city'])")
    LAT=$(echo "$GEO" | python3 -c "import sys,json; print(json.load(sys.stdin)['lat'])")
    LON=$(echo "$GEO" | python3 -c "import sys,json; print(json.load(sys.stdin)['lon'])")

    $PSQL -c "UPDATE games SET
      geo_country = '$(echo "$COUNTRY" | sed "s/'/''/g")',
      geo_region  = '$(echo "$REGION" | sed "s/'/''/g")',
      geo_city    = '$(echo "$CITY" | sed "s/'/''/g")',
      geo_loc     = point($LON, $LAT)
      WHERE id = $id" >/dev/null

    echo "  [$id] $ip → $CITY, $REGION, $COUNTRY"
  else
    echo "  [$id] $ip → lookup failed"
  fi

  sleep 1.5 # Stay under 45 req/min rate limit
done <<<"$IPS"

echo "Done."
