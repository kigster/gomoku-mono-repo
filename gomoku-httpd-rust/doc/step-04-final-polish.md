# Step 04 — Final polish

## Goal

Bring the project to "done" state per `CLAUDE.md`:

- README.md split into operations and developer/algorithm halves.
- Journey notes preserved as `step-NN` documents.
- Confirm builds, tests, integration test, clippy, and fmt all pass.

## What this step did

### README.md rewrite

The README now has two clearly labelled halves:

- **Operations** — install, prerequisites, the CLI flag table, every HTTP
  endpoint with a `curl` example, JSON request/response field reference,
  HAProxy agent-check semantics, and a tiny troubleshooting box.
- **Developing the AI further** — module map, AI pipeline write-up,
  threat-pattern background, where to add new heuristics, and how to
  rerun the integration loop while iterating.

### Verification

```bash
cargo fmt --all -- --check    # passes
cargo clippy --all-targets --all-features -- -D warnings   # passes
cargo test                     # 39 tests pass
just integration               # two concurrent games against daemon
```

The integration script confirmed the daemon handles two games in parallel
with the new semaphore-based concurrency model and that the JSON round-trip
matches the C reference (compact `K9`-style notation parses to internal
`(8, 9)` and serialises back to `K9`).

### Open items / future work

- Replace static-mut `THREAT_COST` with `OnceLock<[i32; 20]>` to remove
  the last `unsafe` block.
- Add a benchmark recipe (`just bench`) that drives the daemon with a
  fixed seed for repeatable timing comparisons against the C version.
- Wire up `cargo-llvm-cov` in CI to track the >90% line-coverage target.
- Cross-compile `gomoku-http-client` from C source so non-arm64 hosts
  can run the integration test.

## Where to look next

- The user-facing introduction is in [`/README.md`](../README.md).
- Algorithm theory and references live in [`doc/README.md`](README.md) plus
  the bundled PDFs (Allis 1994, Stanford 2000, Wágner & Virág 2001).
