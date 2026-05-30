# Step 03 — Integration test, unit tests, justfile / lefthook / Brewfile

## Goals

- Provide a real-world integration test that proves two simultaneous clients
  can drive separate games against one daemon.
- Cover every module with unit tests so `cargo test` becomes meaningful.
- Wire `just build` / `just ci` to install the binary into `./bin` and run
  formatting, linting, tests, docs, and the integration test.
- Drop a minimal `lefthook.yml` and `Brewfile` for contributor onboarding.

## What this step did

### Integration test

- Copied the existing `gomoku-http-client` binary from the C monorepo into
  `./bin/` (it is platform-specific, but matches the active arm64 macOS dev
  loop).
- Added `tests/integration_two_clients.sh`. It:
  1. Builds (or uses) `target/release/gomoku-httpd-rust`.
  1. Boots the daemon, polls `/health`, then launches two
     `gomoku-http-client` processes in parallel with the daemon configured
     to play both X and O sides for each game.
  1. Each client writes its game JSON to
     `target/integration-logs/game-{A,B}.json`.
  1. The script extracts the `winner` field of each game and exits 0 when
     both runs finished cleanly.
- Verified end to end:

```text
==> game A finished: winner=O
==> game B finished: winner=draw
==> integration test passed
```

### Unit tests (cargo test)

39 tests across `board`, `eval`, `game`, `ai`, and `json_api`:

- `board.rs` — cell get/set, win detection (horizontal + diagonal), notation
  round-trip including the C-compatible 1-indexed rows and the deliberately
  skipped letter `I`.
- `eval.rs` — empty-board score is zero, winning position returns
  `WIN_SCORE`, `evaluate_threat_fast` correctly orders open-four > open-three
  > open-two.
- `game.rs` — initial player is X, `make_move` updates history and zobrist,
  duplicate moves rejected, transposition / killer-move tables round-trip.
- `ai.rs` — opening centre on an empty board, generated candidates respect
  search radius and never include occupied cells, AI takes immediate wins,
  AI blocks an opponent's open four.
- `json_api.rs` — empty-game round-trip, invalid board sizes / missing
  player fields rejected, compact and legacy coord formats both replay,
  radius and depth clamping, health/error/`format_uptime` shapes.

### `justfile`

- `just build` and `just build-release` now install the binary into
  `./bin/gomoku-httpd-rust`.
- New `just integration` recipe runs the shell integration test.
- `just ci` composes formatting, clippy, tests, docs, integration, security
  audit, and dead-dependency check.
- `just demo` boots the daemon and starts a one-game live demo with the
  HTTP client.

### `lefthook.yml`

Pre-commit runs `cargo fmt --check`, `cargo clippy -- -D warnings`,
`cargo test`, and a conflict-marker / whitespace check. Pre-push runs the
integration test.

### `Brewfile`

Minimal: `just`, `lefthook`, `python@3` (used by the integration script for
JSON parsing), and `curl`. Rust itself is left to `rustup`.

### Cleanup

- Module-level doc comments switched from `///` to `//!` to satisfy clippy.
- Lint allow-list at the crate root for stylistic-only warnings that fight
  the literal port from C (`too_many_arguments`, `if_same_then_else`,
  `manual_clamp`, `needless_range_loop`, `type_complexity`).
- `cargo clippy --all-targets --all-features -- -D warnings` is clean.

## Next step

[Step 04](step-04-final-polish.md): write the user-facing README, capture
journey docs, and verify the final state.
