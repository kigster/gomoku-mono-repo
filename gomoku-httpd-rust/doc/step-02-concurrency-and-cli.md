# Step 02 — Concurrency, CLI polish, and one-line logging

## Goals

- Allow more than one `/gomoku/play` request at a time, capped at the
  detected CPU count.
- Make the CLI help screen match the spec — bold-cyan section headers,
  bold-yellow examples, both short- and long-form flags.
- Print exactly one line per log message (even when the payload is long),
  with colour by level.

## What this step did

### Concurrency

The previous code used a single `AtomicBool` `server_busy` flag and rejected
overlapping searches via `/ready`. The replacement model is:

- A `tokio::sync::Semaphore` sized to `available_parallelism()` (or the
  user-supplied `--max-concurrency`).
- `/gomoku/play` `acquire_owned()`s a permit before computing, then runs the
  CPU-bound minimax on `tokio::task::spawn_blocking` to keep the actix
  runtime responsive.
- A small `refresh_busy()` helper updates the `busy` `AtomicBool` after each
  acquire/drop, so `/ready` and the HAProxy agent-check still report
  saturation correctly (busy === all permits taken).
- The actix `HttpServer` is configured with the same worker count.

Each request carries the entire game state in JSON, so requests are fully
independent — no state escapes the per-request `GameState`.

### CLI

- Custom clap `Styles` set headers/usage to bold cyan, literals to bold
  yellow, placeholders to green.
- `after_help` text adds an "EXAMPLES:" block, also coloured.
- Added `-j`/`--max-concurrency` (worker cap) and `-C`/`--no-color`
  (disable ANSI colour) flags.

### Logging

- Custom `env_logger::Builder.format()` callback writes a single line per
  record: `[YYYY-MM-DD HH:MM:SS.mmm] LEVEL message`.
- Embedded newlines in messages are escaped as `\n` so that no record ever
  spans more than one line.
- Levels are colourised through `nu-ansi-term`.
- Added `-l`/`--log-file` support that pipes logs to a file when supplied.

### Wire-level smoke test

```bash
./target/release/gomoku-httpd-rust -b 127.0.0.1:9931 -L INFO &
curl -s http://127.0.0.1:9931/health
curl -s -X POST http://127.0.0.1:9931/gomoku/play \
    -H 'Content-Type: application/json' \
    -d '{"X":{"player":"AI","depth":3},"O":{"player":"human"},"board_size":15,"radius":2,"moves":[]}'
```

Both endpoints respond as expected, and `/gomoku/play` produces a single
`info!` line such as:

```
[2026-05-02 …] INFO  play: player=X move=[7,7] type=center depth=3 radius=2 evals=0 time=0.000s queue=0.59ms pipeline=
```

## Next step

[Step 03](step-03-integration-and-tests.md): copy the C HTTP client into
`./bin`, write the two-client shell integration test, and seed unit tests
across every module.
