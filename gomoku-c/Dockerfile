# syntax=docker/dockerfile:1
#
# Multi-stage build for the Gomoku C engine HTTP daemon.
#
# Stage 1 compiles everything on ubuntu:22.04 (glibc 2.35) and gates the
# build on `make test`. Stage 2 ships only the gomoku-httpd binary on a
# distroless base. json-c is linked statically (BUILD_SHARED_LIBS=OFF), so
# the binary's only runtime deps are glibc, libm, and libpthread — all
# provided by distroless/cc-debian12 (glibc 2.36, forward-compatible with
# the 2.35 we built against).

# ---------------------------------------------------------------------------
# Stage 1: builder
# ---------------------------------------------------------------------------
FROM ubuntu:22.04 AS builder

# build-essential (gcc/g++/make), cmake (json-c + googletest), git
# (tests-setup clones googletest), ca-certificates (https git clone).
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        cmake \
        git \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/source

# Copy the source (context is trimmed by .dockerignore).
COPY . .

# Clean any stray artifacts, build all targets, then run the full test
# suite. A test failure aborts the image build here.
RUN make clean && make all -j4 && make test

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
# distroless/cc-debian12: glibc + libgcc + ca-certs, no shell (~25MB).
FROM gcr.io/distroless/cc-debian12

WORKDIR /app

# Only the daemon binary is shipped. Everything else (compilers, source,
# test binaries, json-c .a) stays in the builder stage.
COPY --from=builder /app/source/bin/gomoku-httpd /app/bin/gomoku-httpd

# 8787: HTTP API port. 8788: agent-check port (optional).
EXPOSE 8787 8788

# Default command. Cloud Run / Terraform override this; the contract is a
# binary at ./bin/gomoku-httpd that binds 0.0.0.0:8787 and serves /health.
CMD ["./bin/gomoku-httpd", "-b", "0.0.0.0:8787", "-a", "8788", "-r", "-L", "info"]
