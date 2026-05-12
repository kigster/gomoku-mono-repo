# Gomoku Monorepo
# C engine: gomoku-c/Makefile — API: api/ — Frontend: frontend/

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# Load .env (PROJECT_ID, REGION, PRODUCTION_DATABASE_URL, HONEYCOMB_*, ...)
# Belt-and-suspenders: direnv typically already exports these, but this lets
# `just deploy` work in a fresh shell or CI runner where direnv is absent.
set dotenv-load

version := `grep 'GAME_VERSION' gomoku-c/src/gomoku/gomoku.h | awk '{print $3}' | tr -d '"'| tr -d '\n'`
tag     := "v" + version

[no-exit-message]
recipes:
    @just --choose

# ─── Build ────────────────────────────────────────────────────────────────────

# generates a JWT token and appends it to .env
generate-jwt:
    @grep -q JWT_SECRET .env && echo "Your JWT_SECRET is already in .env" || echo "JWT_SECRET=\"$(openssl rand -base64 32)\"" >> .env

# Build terminal game only (no frontend/API dependencies)
build-game:
    make -C gomoku-c all install

# Build everything: C engine + frontend + copy assets to api/public
build: install-frontend
    make -C gomoku-c all install

# Clean and rebuild the game binary
rebuild:
    make -C gomoku-c rebuild

# Clean all build artifacts
clean:
    make -C gomoku-c clean
    find . -maxdepth 1 -type f -name 'gomoku*' -delete

# Build frontend static assets into frontend/dist
build-frontend:
    cd frontend && npm run build

# Copy frontend dist into API public directory (preserve .gitkeep so the
# directory remains tracked in git after the rm/cp dance).
install-frontend: build-frontend
    rm -rf api/public
    cp -r frontend/dist api/public
    touch api/public/.gitkeep

clean-start: clean build
    SECRET=$(cat .secret) bin/gctl start

# ─── Test ─────────────────────────────────────────────────────────────────────

# Run C engine unit tests (game + daemon)
test: test-daemon test-api test-frontend
    ENVIRONMENT=test make -C gomoku-c test

test-gomoku-c: 
    ENVIRONMENT=test make -C gmoku-c test

# Run daemon unit tests only
test-daemon:
    ENVIRONMENT=test make -C gomoku-c test-daemon

# Run API tests in parallel across 4 workers (each gets its own gomoku_test_gwN DB)
test-api:
    ENVIRONMENT=test cd api && just install && just test -n 5

# Run frontend tests
test-frontend:
    ENVIRONMENT=test cd frontend && npm test

# Run Cypress end-to-end tests. Restarts the local cluster from a known
# state first (gctl stop is a no-op if nothing's up; gctl start is
# idempotent). Override the targets with CYPRESS_BASE_URL /
# CYPRESS_API_BASE / CYPRESS_DB_URL to point at dev.gomoku.games or
# another deployment, in which case skip the gctl dance and run cypress
# directly: `cd frontend && npx cypress run --e2e`.
test-cypress:
    export SECRET="$(cat .secret)"; \
    bin/gctl stop || true; \
    bin/gctl start || exit $?; \
    cd frontend && npx cypress run --e2e

alias test-e2d := test-cypress

# Runs JSON schema validator on any games stored under gomoku-c/games folder.
validate-games: 
    @cd schema-validator && bundle check || bundle install >/dev/null
    @cd schema-validator && bundle exec bin/schema-validator validate-json ../gomoku-c/games

# Run all tests across the monorepo
test-all: test test-api test-frontend

# Run all pre-commit tests and linters
ci:
    @lefthook run --all-files pre-commit

# ─── Version & Release ────────────────────────────────────────────────────────

# Print the current version and tag
version:
    @echo "Version is {{ version }}"
    @echo "The tag is {{ tag }}"

# Tag the current commit with the version
tag:
    git tag -f {{ tag }} -m {{ tag }} && git push --tags --force || true

# Create a GitHub release from the current version tag
release: tag
    gh release create {{ tag }} --generate-notes

# ─── Code Quality ─────────────────────────────────────────────────────────────

# Format all source, test, and script files
format:
    find gomoku-c/src/gomoku gomoku-c/src/net -maxdepth 1 -name '*.c**' | xargs clang-format -i
    find gomoku-c/tests -maxdepth 1 -name '*.c**' | xargs clang-format -i
    find bin -type f -exec bash -c 'file {} | grep -Eqvi ruby' \; -print | xargs shfmt -i 2 -w

# ─── AI Evaluations ──────────────────────────────────────────────────────────

# Run all AI evaluation scripts (tactical + tournament)
evals: build
    #!/usr/bin/env bash
    set -uo pipefail
    echo "=== Running Tactical Tests ==="
    chmod +x gomoku-c/tests/evals/bash/run-tactical-tests
    gomoku-c/tests/evals/bash/run-tactical-tests || true
    echo ""
    echo "=== Running Depth Tournament ==="
    chmod +x gomoku-c/tests/evals/bash/depth-tournament
    gomoku-c/tests/evals/bash/depth-tournament --games 10 --depths "2,3,4"

# Run tactical position tests
eval-tactical: build
    #!/usr/bin/env bash
    set -uo pipefail
    echo "=== Running Tactical Tests ==="
    chmod +x gomoku-c/tests/evals/bash/run-tactical-tests
    gomoku-c/tests/evals/bash/run-tactical-tests || true

# Run depth tournament (AI vs AI at different depths)
eval-tournament: build
    @echo "=== Running Depth Tournament ==="
    chmod +x gomoku-c/tests/evals/bash/depth-tournament
    gomoku-c/tests/evals/bash/depth-tournament --games 10 --depths "2,3,4"

# Run LLM-based game evaluation (requires ANTHROPIC_API_KEY)
eval-llm: build
    @echo "=== Running LLM Evaluation ==="
    uv run gomoku-c/tests/evals/python/llm_eval.py

# Run bash depth tournament with custom params
evals-bash:
    gomoku-c/tests/evals/bash/depth-tournament -d 1,2,3,4,5 -r 3,4 --games 10

# Run ruby tournament against gomoku-httpd cluster behind envoy
evals-ruby:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Starting gomoku-httpd cluster behind envoy..."
    (gctl ps | grep -q -E 'gomoku-httpd' && gctl ps | grep -q -E 'envoy') && \
        echo "Cluster is already up :)" || gctl start -p envoy
    cd gomoku-c/tests/evals/ruby
    bundle check || bundle install -j 12
    ln -nfs ../../bin/gomoku-http-client .
    bundle exec depth-tournament tournament -d 1,2,3,4 -r 2,3 --games 5 --verbose

# ─── Docker ───────────────────────────────────────────────────────────────────

# Build the gomoku-httpd docker container
docker-build-httpd:
    docker build -t gomoku-httpd:latest gomoku-c/

# Build the gomoku-api docker container (includes frontend static assets)
docker-build-api: install-frontend
    docker build -t gomoku-api:latest api/

# Build all docker containers
docker-build-all: docker-build-httpd docker-build-api

# Build gomoku-httpd for linux/amd64 (for GCP)
docker-build-httpd-amd64:
    docker buildx build --platform linux/amd64 -t gomoku-httpd:latest --load gomoku-c/

# Build gomoku-api for linux/amd64 (for GCP, includes frontend)
docker-build-api-amd64: install-frontend
    docker buildx build --platform linux/amd64 -t gomoku-api:latest --load api/

# Build all containers for linux/amd64
docker-build-all-amd64: docker-build-httpd-amd64 docker-build-api-amd64

# Build everything and prepare Docker images for Cloud Run deploy
cr-prepare: docker-build-all-amd64

# Run the gomoku-httpd docker container
docker-run:
    docker run -p 8787:8787 gomoku-httpd:latest

# ─── Cloud Run ────────────────────────────────────────────────────────────────

# Generate a fresh JWT signing secret. Paste into .env as JWT_SECRET=...
jwt-secret:
    @openssl rand -base64 32

# Canonical deploy: .env → migrations → images → Terraform → Honeycomb marker.
# Pass `production` (default) or `staging`. Each environment reads its own
# {ENV}_DATABASE_URL / {ENV}_JWT_SECRET / {ENV}_CUSTOM_DOMAIN keys from
# .env and lands in a separate Terraform state file under
# gs://gomoku-tfstate/cloud-run/{env}/gomoku.
#
#   just deploy             → production (gomoku.us)
#   just deploy staging     → staging (staging.gomoku.games), min=0/0
#   bin/gctl start          → local dev (dev.gomoku.games via /etc/hosts)
deploy environment="production":
    bin/deploy {{ environment }}

# (legacy) Terraform-only deploy, no DB migrations. Prefer `just deploy`.
cr-init: docker-build-all-amd64
    #!/usr/bin/env bash
    set -euo pipefail
    echo "WARNING: cr-init skips DB migrations. Prefer 'just deploy'."
    export ENVIRONMENT=production
    gcloud auth application-default login
    cd ./iac/cloud_run && bash deploy.sh

# (legacy) Push images + restart services, no migrations. Prefer `just deploy`.
cr-update: docker-build-all-amd64
    #!/usr/bin/env bash
    set -euo pipefail
    echo "WARNING: cr-update skips DB migrations. Prefer 'just deploy'."
    export ENVIRONMENT=production
    gcloud auth application-default login
    cd ./iac/cloud_run && bash update.sh

# ─── Gomokup ────────────────────────────────────────────────────────────────────

# Build the submission into gomoku executables for Win32/Win64 for Gomocup Tournament
gomocup:
    make -C gomoku-c pbrain-kig-standard
    make -C gomoku-c gomocup-win
    cp -pv gomoku-c/bin/pbrain-* bin/

# ─── CMake ────────────────────────────────────────────────────────────────────

# Build using CMake
cmake-build:
    mkdir -p gomoku-c/build
    cd gomoku-c/build && cmake .. && make

# Clean CMake build directory
cmake-clean:
    make -C gomoku-c cmake-clean

# Run tests using CMake
cmake-test: cmake-build
    cd gomoku-c/build && ctest --verbose

# Clean and rebuild using CMake
cmake-rebuild: cmake-clean cmake-build
