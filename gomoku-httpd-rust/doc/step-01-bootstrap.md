# Step 01 — Bootstrap

## Goal

Bring the existing Rust port of `gomoku-httpd` from a freshly-checked-in tree
to a state that builds, runs, and meets the requirements in `CLAUDE.md`:

- modern Rust idioms and dependencies
- HTTP daemon that accepts the same JSON as the C version
- colourful CLI/help and one-line log entries
- concurrent request handling capped at the detected CPU count
- shell-based two-client integration test
- clean `just build` / `just ci` workflow with linting and formatting
- comprehensive unit tests
- documentation of the journey in `doc/step-NN-*.md`

## Initial state

- Source tree was already checked in but had no commits yet.
- `cargo build` worked but produced six warnings (unused symbols, an unused
  assignment).
- The single shared `server_busy` `AtomicBool` serialised every request
  one at a time — directly contradicting the concurrency requirement.
- Coordinate notation (`coord_to_notation`/`notation_to_coord`) was
  zero-indexed, while the C reference uses one-indexed display rows. This
  silently broke wire-level JSON parity.

## What this step did

- Read every source file under `src/` and the C reference at
  `../gomoku-multi-mode-monorepo/gomoku-c/src/{gomoku,net}/`.
- Identified the JSON parity bug above and patched both notation helpers in
  `src/board.rs`.
- Aligned the default `radius` with the C version (3, not 2) in
  `src/json_api.rs`.
- Removed dead constants, fields, and helpers (`NEED_TO_WIN`,
  `MAX_VCT_SEQUENCE`, `stateless_mode`, `has_winner`/`invalidate_winner_cache`
  on `GameState`, `determine_ai_player`).
- `cargo build` is now warning-free.

## Next step

[Step 02](step-02-concurrency-and-cli.md): replace the busy flag with a
semaphore so that searches run concurrently up to the detected CPU count,
and polish the CLI help / logging.
