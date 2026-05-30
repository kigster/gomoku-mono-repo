# gomoku-httpd-rust — Claude project notes

This is the Rust port of the C `gomoku-httpd` daemon. The binaries are
wire-compatible: same JSON shape, same compact board notation, same CLI
flags. The C source lives at
`../gomoku-multi-mode-monorepo/gomoku-c/` and is the algorithmic
reference whenever Rust behavior is unclear.

## Repository expectations

When working in this repo, please uphold the following:

1. Follow current Rust conventions and use `edition = "2024"`. Prefer the
   newest stable APIs.
1. Keep dependencies up to date when there is no breaking-change risk.
1. Reuse the existing HTTPD library choice (actix-web). Do not swap web
   frameworks without a strong reason.
1. JSON parsing/serialization must produce output byte-equivalent to
   `gomoku-c`'s — this is checked by the integration script.
1. Logging: `INFO` produces 1–2 lines per request (one for the move,
   one extra on game over). `DEBUG` adds 5–9 lines (parsed game state,
   decision pipeline, etc.). Each `play:` INFO line ends with
   `request latency [N.NNN seconds]` (3 decimals).
1. Multiple concurrent `/gomoku/play` requests are supported. Each
   request constructs a fresh `GameState` from the JSON payload —
   fresh transposition table, killer-move table, board, hash. Nothing
   is shared between requests.
1. CLI: rich `clap` interface with both short and long flags, bold-cyan
   section headers in `--help`, bold-yellow examples and command names.
1. Auto-detect CPU count via `available_parallelism()` and use it both
   as the `actix-web` worker count and as the default search-concurrency
   semaphore (`-j` overrides).
1. CLI argument names match the C version. Flag-by-flag parity is
   tested by the integration script.

## Algorithm

The minimax + threat-evaluation algorithm is a faithful port of
`gomoku-c/src/gomoku/{ai,eval,game,board}.c` with the bugfixes and
performance work applied (see commit history). Whenever the two
diverge, the C version is the reference.

The Rust port adds **root-level parallelism** via rayon: when more
than one CPU is available and the search is non-trivial, root moves
are split across cores, each worker holding its own `GameState`
clone. See `ai.rs::run_root_search`.

## Build, test, run

```bash
just build              # cargo build, copies binary into ./bin/
just build-release      # release build, copies into ./bin/
just test               # cargo test
just ci                 # fmt-check + lint + test-all + doc + integration + audit
just integration        # spins up the daemon and runs two clients against it
just demo               # quick local game using the bundled HTTP client
```

The release binary lives at both `target/release/gomoku-httpd-rust`
and `bin/gomoku-httpd-rust` after `just build-release`.

## Files of interest

```
src/
  main.rs       HTTP server, CLI, semaphore, logger, request handler
  ai.rs         Move generation, VCT, minimax, root-parallel iterative deepening
  eval.rs       Threat-pattern matrix and position evaluation
  game.rs       GameState, transposition table, Zobrist hashing, killer moves
  board.rs      Flat-vec board, win detection, coordinate notation
  json_api.rs   Wire-compatible JSON parsing / serialization

doc/            Algorithmic notes and step-by-step build journal
.github/workflows/ci.yml   GitHub Actions: fmt, clippy, test (Linux+macOS), build
lefthook.yml    Local pre-commit/pre-push gates (mirror of CI)
Brewfile        Optional toolchain dependencies (just, lefthook, etc.)
```

## When extending

- New heuristics: add the pattern recognizer in `eval.rs::evaluate_threat_fast`
  (so it shows up in move ordering), then insert the step in
  `ai::find_best_ai_move` between `block_vct` and the `run_root_search`
  call. Push a `ScoringEntry`. Add a unit test in `src/ai.rs::tests`.
- New CLI flag: extend `Cli` in `main.rs`; document in `--help` text and
  in the README's CLI table.
- New JSON field: parse in `json_api::parse_game`, emit in
  `json_api::serialize_game_ex`. Round-trip tests in
  `json_api::tests` should cover both directions.

## Style

- 4-space indentation (rustfmt default).
- `cargo clippy --all-targets -- -D warnings` is clean. CI enforces it.
- No `unsafe` outside `main.rs`'s pre-`env_logger`-init env var write
  (which is documented as safe at startup).
- Comments explain *why*, not *what*. Prefer self-explanatory names.
