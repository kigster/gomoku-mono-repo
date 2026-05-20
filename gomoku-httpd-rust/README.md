# gomoku-httpd-rust

[![Format](https://github.com/kigster/gomoku-rust-httpd/actions/workflows/fmt.yml/badge.svg?branch=main)](https://github.com/kigster/gomoku-rust-httpd/actions/workflows/fmt.yml)
[![Clippy](https://github.com/kigster/gomoku-rust-httpd/actions/workflows/clippy.yml/badge.svg?branch=main)](https://github.com/kigster/gomoku-rust-httpd/actions/workflows/clippy.yml)
[![Test](https://github.com/kigster/gomoku-rust-httpd/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/kigster/gomoku-rust-httpd/actions/workflows/test.yml)
[![Doc](https://github.com/kigster/gomoku-rust-httpd/actions/workflows/doc.yml/badge.svg?branch=main)](https://github.com/kigster/gomoku-rust-httpd/actions/workflows/doc.yml)
[![Whitespace](https://github.com/kigster/gomoku-rust-httpd/actions/workflows/whitespace.yml/badge.svg?branch=main)](https://github.com/kigster/gomoku-rust-httpd/actions/workflows/whitespace.yml)
[![Build](https://github.com/kigster/gomoku-rust-httpd/actions/workflows/build.yml/badge.svg?branch=main)](https://github.com/kigster/gomoku-rust-httpd/actions/workflows/build.yml)
[![Rust 2024](https://img.shields.io/badge/rust-2024-orange.svg)](https://www.rust-lang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#license)

A Rust port of the C `gomoku-httpd` daemon. The two binaries are wire-level
compatible: requests and responses use exactly the same JSON shape, the same
compact board notation (`K9` etc.), and the same CLI flags. Compared to the
C reference this build adds:

- Concurrent request handling capped at the detected CPU core count.
- **Root-level parallelism inside a single search.** When a single AI
  request has the box mostly to itself, the iterative-deepening root
  fans out across all available cores via rayon — measured ~10x speed-up
  versus the C reference on the same depth-6 input (72.4s → 6.8s on a
  16-core machine, identical evaluation count).
- Coloured CLI help and one-line per-record colour logging.
- A semaphore-driven `/ready` and HAProxy agent-check that flips to
  `busy` only when every worker is actually busy.
- Request-latency reporting: every `play:` INFO log line ends with
  `request latency [N.NNN seconds]` at 3-decimal precision.

> **Two halves below.** Part I is for **operators** running the daemon.
> Part II is for **developers** extending the AI.

______________________________________________________________________

## Part I — Operations

### Prerequisites

- Rust 1.85+ via [rustup](https://rustup.rs/) (`edition = "2024"` is used).
- [`just`](https://github.com/casey/just) for the convenience recipes.
- macOS / Linux. The bundled `bin/gomoku-http-client` is a precompiled
  arm64 macOS binary; rebuild it from the C monorepo for other platforms.

```bash
brew bundle install     # just, lefthook, python@3 (used by the integration test)
rustup update
just build-release      # produces ./bin/gomoku-httpd-rust
```

### Quick start

```bash
just start              # release build, listens on 127.0.0.1:9931
# …or…
./bin/gomoku-httpd-rust -b 0.0.0.0:9900 -L INFO
```

### Demo against the bundled client

```bash
just demo               # starts daemon + a single game on port 9931
just demo PORT=9999 DEPTH=4 RADIUS=3 BOARD=19
```

### CLI reference

| Flag | Long | Default | Purpose |
|------|------|---------|---------|
| `-b` | `--bind <ADDR>` | *required* | `host:port`, just `port`, or `[::]:port` |
| `-a` | `--agent-port <PORT>` | off | TCP port for HAProxy agent-check |
| `-d` | `--daemonize` | off | Accepted for CLI parity with C; no-op in Rust |
| `-l` | `--log-file <FILE>` | stderr | Append log records to a file |
| `-L` | `--log-level <LEVEL>` | `INFO` | `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `-r` | `--report-scoring` | off | Embed the AI scoring pipeline in JSON responses |
| `-j` | `--max-concurrency <N>` | detected cores | Cap on concurrent `/gomoku/play` searches |
| `-C` | `--no-color` | off | Disable ANSI colours in log output |

`gomoku-httpd-rust --help` shows the same table with bold-cyan section
headers and bold-yellow examples.

### HTTP endpoints

| Method + path | Purpose |
|---------------|---------|
| `GET /health` | Liveness check. Always 200 if the process is up. |
| `GET /ready` | Returns 200 `{"status":"ready"}` while a worker slot is free, 503 `{"status":"busy"}` once every slot is taken. |
| `POST /gomoku/play` | Submit a full game state, receive the next AI move. |

Sample request — start a fresh game and let the AI play X first:

```bash
curl -s -X POST http://127.0.0.1:9931/gomoku/play \
  -H 'Content-Type: application/json' \
  -d '{
    "X": {"player": "AI", "depth": 4},
    "O": {"player": "human"},
    "board_size": 19,
    "radius": 3,
    "moves": []
  }'
```

Continue an existing game (the human played `K9`, AI responds):

```bash
curl -s -X POST http://127.0.0.1:9931/gomoku/play \
  -H 'Content-Type: application/json' \
  -d '{
    "X": {"player": "human"},
    "O": {"player": "AI", "depth": 4},
    "board_size": 19,
    "moves": [{"X (human)": "K9", "time_ms": 500}]
  }'
```

### JSON shape

Inputs:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `X` | object | yes | `{"player": "human"\|"AI", "depth": 1..6}` |
| `O` | object | yes | same as `X` |
| `board_size` | int | no | 15 or 19 (default 19) |
| `radius` | int | no | 1..4 (default 3, matches C version) |
| `timeout` | int or `"none"` | no | per-move timeout in seconds |
| `undo`, `undo_limit` | bool/int | no | undo policy |
| `moves` | array | no | history; each move is `{ "X (human)": "K9", … }` or legacy `{ "X (AI)": [row, col] }` |

Outputs include all input fields plus:

- `winner` — `"X"`, `"O"`, `"draw"`, or `"none"`.
- `board_state` — array of row strings using `X`, `O`, `.`.
- updated `moves` array; the most recent move is the AI's. With
  `--report-scoring` it also gets `offensive_max_score`,
  `defensive_max_score`, `think_time_ms`, and a `scoring` array describing
  every step of the pipeline.

Compact coordinates use `<column letter><display row>` where columns skip
`I` (so `A=0, B=1, …, H=7, J=8, K=9, …`) and display rows are 1-indexed
(internal `(row=0, col=0)` ↔ `A1`, `(row=8, col=9)` ↔ `K9`). This mirrors
the C reference exactly.

### HAProxy agent-check

When `-a` is set the daemon opens a second TCP listener on that port.
Every accepted connection receives `ready\n` while permits are available
or `drain\n` while every worker is busy. Use `agent-check` in the HAProxy
backend to balance based on real saturation, not just port reachability.

### Logs

One line per record, regardless of payload size — embedded newlines are
escaped to `\n`. With colour enabled the timestamp is dimmed and the level
is colourised; with `-C` or `NO_COLOR` set the output is plain ASCII.

```
[2026-05-03 08:35:45.241] INFO  play: player=O move=[8,8] type=minimax depth=6 radius=3 evals=468 time=0.355s queue=0.13ms pipeline=have_win(0.00ms) -> block_threat(0.00ms) -> have_vct(0.01ms) -> block_vct(0.00ms) -> minimax(355.07ms) request latency [0.355 seconds]
```

Per-request: `INFO` produces 1–2 lines (one per move; an extra line on
game-over). `DEBUG` adds the parsed-game and decision-pipeline detail.
The trailing `request latency [N.NNN seconds]` is wall time from
request arrival to response generation, including the queue wait at
the per-CPU semaphore.

### Troubleshooting

- **"Worker semaphore closed unexpectedly"** — the runtime is shutting down;
  send a fresh request after restart.
- **403 / no response** — `--bind` is required. Common typo: `-b 9931`
  binds to `0.0.0.0:9931`; bind to `127.0.0.1:9931` for local-only.
- **Mismatched coordinates** — the wire format is **1-indexed** for display
  rows. `A1` is the top-left cell; in legacy array form it's `[0, 0]`.

______________________________________________________________________

## Part II — Developing the AI

### Module map

```
src/
  main.rs      HTTP server (actix-web), CLI (clap), routing, semaphore,
               coloured single-line logger
  board.rs     Flat-vec board, win detection, coordinate notation
  eval.rs      Threat pattern matrix and position evaluation
  game.rs      Game state, transposition table, Zobrist hashing,
               killer moves
  ai.rs        Move generation, VCT search, minimax with alpha-beta
               pruning + iterative deepening, the 7-step pipeline
  json_api.rs  JSON parsing/serialization matching json_api.c
```

### AI pipeline

`ai::find_best_ai_move` consults heuristics in order; the first one that
returns a move wins. Each step records a `ScoringEntry` so `--report-scoring`
can surface the decision path. Threat values come from
`eval::evaluate_threat_fast`, which mirrors the C reference exactly
(including the overline distinction — six or more contiguous stones is
not a win in standard gomoku).

1. **`have_win`** — does any candidate immediately make five-in-a-row
   (threat ≥ 1 000 000)?
1. **`block_threat`** — must we block an opponent move that wins
   immediately or creates an open four (threat ≥ 500 000)? Closed fours
   are intentionally NOT force-blocked here — minimax weighs them against
   offensive replies.
1. **`open_four`** — play our own open four (threat ≥ 500 000), now safe
   that opponent immediate threats have been checked. Wins in two turns
   barring a counter-five.
1. **`have_vct`** — Victory by Continuous Threats: forced-win sequence
   exists for us within 10 plies of forcing moves.
1. **`block_vct`** — block the opponent's VCT by finding a move that
   removes their forced sequence.
1. **`minimax`** — fall back to iterative-deepening minimax with
   alpha-beta pruning, a transposition table per AI side, killer-move
   ordering, and a heuristic evaluator that combines the threat matrix
   from Allis (1994) with the open-three / open-two weighting from the
   Stanford 2000 poster.

Compound-three / open-three / forcing-four heuristics that used to live
between `block_vct` and `minimax` have been removed because minimax with
threat-aware move ordering handles those positions better with multi-ply
lookahead — and the prologue versions sometimes overrode minimax's
correct answer.

The threat constants (`THREAT_FIVE`, `THREAT_STRAIGHT_FOUR`, etc.) and
their numeric weights are defined as the compile-time `THREAT_COST`
table in `eval.rs`. Combination scoring (e.g. `THREE_AND_FOUR`) is in
`eval.rs::calc_combination_threat`.

#### Root-level parallelism

`ai::run_root_search` drives iterative deepening. When
`available_parallelism() ≥ 2`, the search is non-trivial
(`max_depth ≥ 3`, more than one root move) and the current depth is
≥ 2, the sorted root moves are split into `cores`-sized chunks and
searched in parallel via rayon. Each worker takes a `GameState` clone
so its transposition table, killer-move table, board mutations and
zobrist hash are thread-local. A shared `AtomicBool` lets workers
cooperate on timeout and on early termination when one of them finds
a near-win.

The HTTP-layer semaphore (`-j N`, default = detected cores) bounds the
number of concurrent searches. Inside each search, rayon's global pool
work-steals across whichever cores are idle. Two concurrent searches
on a 12-core box do **not** strictly partition into 6+6 — they share
the same thread pool, each making progress on whichever cores happen
to be free. To enforce stricter isolation, lower `-j`.

### Adding a new heuristic

1. Add the threat-pattern recogniser in `eval.rs`, ideally in
   `evaluate_threat_fast` so `generate_moves` ranks candidates correctly.
1. Insert the new step into `ai::find_best_ai_move` between `block_vct`
   and the `run_root_search` call. Push a `ScoringEntry` with
   `evaluated_moves`, `score`, `time_ms`, and `decisive=true` if the
   step short-circuits.
1. Add a test in `src/ai.rs::tests` that builds a board the new
   heuristic should fire on and asserts the returned `move_type`.
1. Re-run `cargo test` and the integration script.

### Tests

```bash
cargo test                # 39 unit tests (board, eval, game, ai, json_api)
just integration          # two clients vs one daemon, must finish both
```

Coverage tooling (`just coverage`, `just coverage-open`) is wired up via
`cargo-llvm-cov`. Install it with `cargo install cargo-llvm-cov --locked`.

### Dev loop

```bash
just fmt          # cargo fmt
just lint         # clippy with -D warnings (clean as of step-04)
just test         # cargo test
just precommit    # fmt + lint-package + test
just ci           # fmt-check + lint + test-all + doc + integration + audit + machete
```

`lefthook install` once, and pre-commit/pre-push hooks will run the same
gates locally.

### References

The PDFs in `doc/` cover the algorithmic foundations:

- Allis, van den Herik, Huntjens (1994), *Go-Moku and Threat-Space Search.*
  The threat-space terminology used throughout this codebase (open three,
  straight four, …) traces back to this paper.
- Stanford CS poster (2000), *AI Agent for Playing Gomoku.* Inspires the
  beam-search style ordering inside `generate_moves`.
- Wágner, Virág (2001), *Solving Renju.* Background reading for the iterative
  deepening / threat-sequence search behind `ai::find_forced_win`.

### Project journey

Step-by-step notes describing how this repo got from a fresh checkout to
its current state:

- [step-01-bootstrap.md](doc/step-01-bootstrap.md)
- [step-02-concurrency-and-cli.md](doc/step-02-concurrency-and-cli.md)
- [step-03-integration-and-tests.md](doc/step-03-integration-and-tests.md)
- [step-04-final-polish.md](doc/step-04-final-polish.md)

## License

MIT.
