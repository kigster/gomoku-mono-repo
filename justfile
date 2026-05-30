# Gomoku Monorepo
# vim: ft=just
# C engine: gomoku-c/Makefile — API: api/ — Frontend: frontend/
#
# This file is the orchestration layer. The actual recipes live under
# `./just/*.just` files, grouped by concern (build, format, test, …).
# Each sub-file defines per-component recipes (e.g. `build-gomoku-c`,
# `format-frontend`) and a joiner (`build-all`, `format-all`, …). The
# top-level entry points below alias the joiners.

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# Load .env (PROJECT_ID, REGION, PRODUCTION_DATABASE_URL, HONEYCOMB_*, ...)
# Belt-and-suspenders: direnv typically already exports these, but this lets
# `just deploy` work in a fresh shell or CI runner where direnv is absent.
set dotenv-load

version := `grep 'GAME_VERSION' gomoku-c/src/gomoku/gomoku.h | awk '{print $3}' | tr -d '"'| tr -d '\n'`
tag     := "v" + version
find    := "/usr/bin/find"

import "./just/justfile.build"
import "./just/justfile.format"
import "./just/justfile.test"
import "./just/justfile.e2e"
import "./just/justfile.docker"
import "./just/justfile.cloud-run"
import "./just/justfile.gomocup"
import "./just/justfile.evals"

[no-exit-message]
recipes:
    @just --choose

# ─── Top-level entry points ────────────────────────────────────────────────────

# Compile every component but do not copy artifacts into ./bin
build: build-all

# Build + copy compiled binaries into ./bin (and frontend dist into api/public)
install: install-all

# Format every language in place. After this, `just check` must pass.
format: format-all

# Verify formatting; non-zero on any deviation. Used by `just ci`.
check: check-all

# Run every component's unit tests (excludes Cypress and Rust integration).
test: test-all

# Full CI gate: formatting check + every test + cypress + Rust integration
ci: check test-all test-rust-integration e2e

# Clean everything
clean: clean-all

# ─── Setup & maintenance ───────────────────────────────────────────────────────

# Install Brew packages from Brewfile and other necessities
setup:
    #!/usr/bin/env bash
    # Run `brew bundle` separately to upgrade the packages to latest versions
    [[ -f Brewfile ]] && brew bundle --no-upgrade

# Generate a JWT token and append it to .env
generate-jwt:
    @grep -q JWT_SECRET .env && echo "Your JWT_SECRET is already in .env" || echo "JWT_SECRET=\"$(openssl rand -base64 32)\"" >> .env

# Boot local environment from clean state. Pass -r to start rust httpd daemon
dev-boot *args: install-all
    #!/usr/bin/env bash
    echo "\n—————————————————————————————————————————————————————————————————————"
    echo "Stopping any lingering processes..."
    echo "—————————————————————————————————————————————————————————————————————"
    echo "It's recommended to run 'just clean-all' before rebuilding everything."
    read -p "Run it? [Y/n]" answer
    if [[ -z ${answer} || answer =~ y || answer =~ Y ]]; then
        just clean-all
    fi
    SECRET=$(cat .secret) bin/gctl start {{args}}

# ─── Version & Release ─────────────────────────────────────────────────────────

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
