# Spec — 1.0.1 HTTP daemon and containerized cluster

**Span:** `30d2025` → `503ddba` (5 commits, 2026-02-02)
**Version:** `1.0.0` → `1.0.1`

## Theme

Expose the engine as a stateless HTTP service and ship the full deployment
stack — the architectural pivot from local binary to scalable backend.

## What was built

- **Stateless HTTP daemon** (#37). A new `src/net/` subsystem: `main.c` (server),
  `handlers.c`, `json_api.c` (~544 lines), `logger.c`, `cli.c`, plus a
  `test_client.c` and `daemon_test.cpp` (~497 lines). Each request carries the
  full board and gets the AI's move back — no server-side session.
- **Containerization** (#38). Dockerization and Kubernetes manifests
  (`iac/k8s/configmaps.yaml`, etc.).
- **Infrastructure as Code** (#39). Production deployment definitions, including
  `iac/systemd/` units (`gomokud-ctl`) and `iac/README.md`.
- **HAProxy cluster** (#40). A working cluster of 10 `gomoku-httpd` servers behind
  a load balancer; client switches to the globally installed `gomoku-httpd` (#41).
- **`doc/HTTPD.md`** (~539 lines) documenting the daemon and protocol.

## Oracle: version-bump assessment

**Mis-versioned.** Labeled a patch (`1.0.0` → `1.0.1`), this span introduces an
entire networked service architecture — the single largest structural change to
date. By SemVer it is at minimum a **minor** (`1.1.0`), and arguably a **major**
given the new public HTTP contract. Recorded here as a notable
under-numbering; the tag is preserved as-is (no history rewrite), but readers
should treat 1.0.1 as the "Gomoku-as-a-service" milestone.
