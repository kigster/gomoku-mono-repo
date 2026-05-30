# pbrain-kig-standard — Gomocup Tournament Brain

## Goal

Ship `pbrain-kig-standard`, a Gomocup-protocol brain wrapping the same
C engine the TUI and web flows use, targeting the **Standard** category
at <https://gomocup.org/> (15×15 board, exact five-in-a-row, overlines
do not win).

## Users and use cases

- **Tournament submission** to Gomocup competitions — uploaded as a ZIP
  containing both Win64 and Win32 executables.
- **Developers** smoke-testing the brain locally against the
  reference protocol stream (`printf … | ./bin/pbrain-kig-standard`).
- **Engine rating calibration** — running the same brain against the
  Gomocup field validates the local Elo numbers shown on
  app.gomoku.games against an external benchmark.

## Functional requirements

### Brain identity

- Name: `kig-standard`
- Version: `1.0.0` (bump on engine / protocol changes)
- Author: Konstantin Gredeskoul
- Protocol: <https://plastovicka.github.io/protocl2en.htm> (v2,
  stdin/stdout pipe — **not** the legacy text-file variant)

### Self-containment

- All sources live under `gomoku-c/` so the directory could be
  extracted from the monorepo and built standalone.
- Brain code under `gomoku-c/src/gomocup/`.
- Shared engine compiled with `-DNO_JSON` so the brain has zero
  runtime dependencies (no json-c, no HTTP daemon, no TUI).

### Build artefacts

- Native binary for dev: `make pbrain-kig-standard` (macOS / Linux).
- Cross-compiled Windows binaries via mingw-w64:
  - `pbrain-kig-standard-x86-64.exe` (Win64 — filename must contain `64`
    per Gomocup rules)
  - `pbrain-kig-standard-x86-32.exe` (Win32)
- Both Windows binaries statically linked — no third-party DLL
  dependencies beyond `KERNEL32` + UCRT (Windows 10/11 baseline).
- Submission ZIP: `make gomocup-zip` produces
  `bin/pbrain-kig-standard.zip` with both `.exe` files plus a
  `README.txt` stamped with the git SHA and build timestamp.

### Protocol behaviour

- Board size fixed at 15 for the Standard category; `START n` for
  `n != 15` is rejected with `ERROR unsupported board size`.
- `RECTSTART`, `SWAP2BOARD`, `PLAY` recognised but declined with
  `ERROR <reason>`.
- `INFO` keys honoured: `timeout_turn`, `timeout_match`,
  `time_left`. All other keys silently consumed per spec.
- `time_left` from the manager is authoritative.
- **200 ms safety margin** against the manager's deadline (transmission
  delay / context switch protection).
- Default search depth **5** with iterative deepening; default radius
  **3**. First move on `BEGIN` is the centre square `(7, 7)`.
- Per-turn line-buffered stdout flushed after every response.

### Tournament constraints

- ≤ 30 s per turn, ≤ 3 min per match.
- ≥ 70 MB memory budget honoured.
- ≤ 256 MB ZIP; ≤ 20 MB per-brain runtime files.

### Tests

- `make test` covers the full suite:
  - 33 engine unit tests
  - 34 daemon unit tests
  - 17 gomocup parser + coord unit tests
  - 4 scripted protocol scenarios (`tests/gomocup_protocol_e2e.sh`)
- Optional Wine smoke-test for the cross-compiled binaries before
  packaging.

## Quality criteria

- All translation between Gomocup `[X],[Y]` and engine
  `board[row][col]` lives in one place (`coords.c`); every other
  layer uses engine-native indices.
- Player encoding: brain's stone (Gomocup field 1) maps to
  `AI_CELL_CROSSES`; opponent (field 2) to `AI_CELL_NAUGHTS`. Manager
  side assignment is read from the first `BEGIN` / `TURN`.
- The brain replays every opponent move through `make_move` to keep
  `game->current_player` in sync — `find_best_ai_move` reads turn
  state from the game, never from a parameter.

## Out of scope

- Freestyle / Renju / Caro categories (separate brains if pursued).
- Tournament-manager integration testing on Linux (Piskvork is
  Windows-only; verified via Wine + the final Windows VM check).
- CI release-artefact publication of the ZIP — built locally on a
  machine with mingw-w64.

## Cross-references

- Implementation plan, packaging, submission steps: `plan.md`.
- Brain-local README: `gomoku-c/src/gomocup/README.md`.
- Engine internals: `reference/c-engine-ai-algorithm-deep-dive.md`.
- Bayesian Elo system Gomocup uses:
  `reference/gomocup-bayesian-elo-system.md`.
