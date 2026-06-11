# Plan — 1.0.1 HTTP daemon and containerized cluster

## Steps

1. **Design a stateless protocol.** Each request carries the full game state;
   the response is the AI's move. No server-side sessions, so any node can serve
   any request.
2. **Build the daemon** (`src/net/`). HTTP server loop, request handlers, a JSON
   API layer reusing the engine, structured logging, and a CLI.
3. **Write a test client + daemon tests.** `test_client.c` and `daemon_test.cpp`
   exercise the protocol end to end.
4. **Containerize.** Dockerfile + Kubernetes configmaps/manifests.
5. **Author IaC.** systemd units and infra definitions for production.
6. **Stand up a cluster.** 10 daemon instances behind HAProxy; point the client at
   the globally installed binary.
7. **Document** the protocol in `doc/HTTPD.md`. Bump to `1.0.1`, tag.

## Testing strategy

- Daemon protocol tests (request → legal move) and load tests against the cluster
  (with 503-retry handling, as later refined in 1.1.0).

## Deviations from the code

This should have been a minor or major version, and the HTTP request/response
schema should ship as a versioned contract from day one — later daemons (the Rust
port) and the web frontend depend on it. Pinning the protocol version in the
response would let clients negotiate compatibility instead of assuming it.
