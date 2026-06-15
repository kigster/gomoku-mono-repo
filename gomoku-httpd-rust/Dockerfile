# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: Builder
# ---------------------------------------------------------------------------
# Compile the release binary on the official Rust image (Debian bookworm,
# glibc 2.36). `just build-release` runs `cargo build --release` and copies
# the binary into bin/.
FROM rust:latest AS builder

# `just` drives the build; build-essential/git satisfy native-dep compilation.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential git just \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the full source tree (host target/ and bin/ are excluded via
# .dockerignore so the in-container cargo build is clean and the context
# stays small).
COPY . .

# Produces target/release/gomoku-httpd-rust (+ bin/ copies/symlink).
RUN just build-release

# ---------------------------------------------------------------------------
# Stage 2: Runtime
# ---------------------------------------------------------------------------
# Distroless cc-debian12 matches the builder's Debian 12 / glibc 2.36, ships
# libgcc and ca-certificates, and has no shell or package manager (~25MB).
# CA certs are required for the OTLP/rustls HTTPS export to api.honeycomb.io.
FROM gcr.io/distroless/cc-debian12

WORKDIR /app

# Distroless has no shell to recreate the `gomoku-httpd` symlink, so copy the
# real binary straight to the path Terraform / the runtime contract invokes.
COPY --from=builder /app/target/release/gomoku-httpd-rust /app/bin/gomoku-httpd

# 8787: HTTP API port
EXPOSE 8787

# Default command; Cloud Run / Terraform may override it.
CMD ["./bin/gomoku-httpd", "-b", "0.0.0.0:8787", "-L", "info"]
