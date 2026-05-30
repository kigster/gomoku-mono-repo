# Gomocup Protocol Implementation Plan

Target: produce `pbrain-kig-standard64.exe` (Win64) and `pbrain-kig-standard-x86.exe` (Win32) brain executables that speak the Gomoku AI Protocol v2 and pass tournament play under the official Gomocup manager.

## 1. References

- Protocol spec: <https://plastovicka.github.io/protocl2en.htm>
- Tournament rules: <https://gomocup.org/detail-information/>
- Tournament manager (Piskvork): <https://gomocup.org/download-gomocup-manager/>
- Existing engine reference: `reference/c-engine-ai-algorithm-deep-dive.md`

## 2. Design Constraints

### Tournament rules (Standard category)

- Board size: **15x15** (Standard category is fixed at 15x15)
- Win rule: exactly five in a row; overlines do **not** win (already enforced by `has_winner()` and `evaluate_threat_fast` in our engine)
- Time limit: not stricter than 30 seconds per turn and 3 minutes per match
- Memory: not lower than 70 MB per brain
- Disk: 256 MB zip on submission, 20 MB per-brain runtime files
- Architecture: x64 required (Windows 10/11). Hybrid x86+x64 zip is allowed; the x64 file name must contain the substring `64`. We will ship both for compatibility.

### Protocol shape

**Stdin / stdout only — we do NOT implement the legacy text-file protocol.**
The Gomocup spec offers two transport variants: (a) the modern stdin/stdout
pipe protocol, and (b) an older text-file protocol where the manager writes
commands to a `*.cmd` file and reads responses from a `*.rsp` file. We
target (a) exclusively. The Piskvork manager has supported stdin/stdout
since the early 2010s and all current tournaments use it.

Single-threaded console app reading from stdin and writing line-buffered
responses to stdout. Each line ends with CR LF on the wire; brain output
may use CR LF, LF, or CR. **Output buffering must be flushed after every
response** — set `stdout` to line-buffered (or `_IONBF`) at startup
via `setvbuf(stdout, NULL, _IOLBF, 0)` (or `_IONBF` for safety on Windows).

### Coordinates

- **Gomocup**: `[X],[Y]` 0-indexed, origin top-left. X is the column, Y is the row.
- **Engine**: `board[x][y]` where the **first index is the row**, the **second is the column** (matches existing tests and `ai.c` candidate generation).
- Translation:
  - Gomocup X (column) → engine **y** (column index)
  - Gomocup Y (row) → engine **x** (row index)
- All translation lives in one place (`coords.c`). Every other layer uses engine-native indices.

### Player encoding

- Gomocup field 1 = brain's stone, 2 = opponent, 3 = winning line (renju forbidden).
- Engine uses `AI_CELL_CROSSES` (1) and `AI_CELL_NAUGHTS` (-1).
- Inside the brain, "self" is whichever side the manager asks us to play first (determined by the first `BEGIN` vs `TURN`). Map self → CROSSES, opponent → NAUGHTS.
- **Important**: `find_best_ai_move(game_state_t *game, int *best_x, int *best_y, scoring_report_t *report)` does NOT take a player argument — the engine reads `game->current_player` and the move-history to decide whose turn it is. So the brain must keep the engine's `game->current_player` in sync by replaying every opponent move through `make_move(game, x, y, NAUGHTS, ...)` (which alternates `current_player` on success). This means each `TURN [X,Y]` and each `BOARD ... DONE` cell with field=2 must call `make_move` with the right side, in the right order, before invoking `find_best_ai_move`.

## 3. Scope and Reuse

### Self-containment

**Hard rule**: every source file, header, test, fixture, build script, and submission artifact for this brain must live under `gomoku-c/` so the directory could be extracted from the monorepo and built standalone. The only artifact outside `gomoku-c/` is this planning doc itself (`reference/gomocup-protocol-v2-implementation.md`), which is a project-level note, not a build dependency. Specifically:

- All new sources go under `gomoku-c/src/gomocup/`.
- All new tests go under `gomoku-c/tests/`.
- A new `gomoku-c/src/gomocup/README.md` describes building, testing, packaging, and submitting the brain — readable by someone who only has the `gomoku-c/` directory.
- The new Makefile targets live in `gomoku-c/Makefile` (no root-level `justfile` recipes — the gomocup work-flow stays inside `gomoku-c/`).
- Cross-compile cache directories, generated `.exe` binaries, and the submission `.zip` all stay under `gomoku-c/bin/`.

### Reuse from existing engine

- `gomoku-c/src/gomoku/gomoku.{h,c}` — pattern detection, `has_winner()`, `evaluate_threat_fast()`
- `gomoku-c/src/gomoku/board.{h,c}` — board allocation
- `gomoku-c/src/gomoku/game.{h,c}` — `game_state_t`, `make_move`, `init_game`, `cleanup_game`, transposition table, killer moves
- `gomoku-c/src/gomoku/ai.{h,c}` — `find_best_ai_move`, threat eval, minimax, iterative deepening, time bookkeeping (`search_start_time`, `search_timed_out`)
- `gomoku-c/src/gomoku/cli.h` — **header only** — defines `cli_config_t`, which `init_game()` consumes by value. We do NOT link `cli.c` (POSIX-heavy `getopt`-based arg parsing). The new `main.c` constructs a `cli_config_t` literal directly with `headless = 1`, `stateless_mode = 0`, `enable_undo = 1`, `max_depth = 7`, `search_radius = 3`, etc.

### Engine board-size considerations

The engine has compile-time `[19][19]` candidate buffers in `ai.c` and `[361]` move arrays (= 19²). 15×15 fits inside these without any change. The brain will therefore allocate `game_state_t` with `board_size = 15` (Standard tournament category) and the oversized auxiliary buffers will simply have unused cells. **This is intentional, not a bug.** Size 20 (which the protocol spec says brains should support) would require lifting these buffers; we deliberately punt that to v2 because the Standard tournament uses 15×15 only — see §12.

### Do NOT link

- `ui.{h,c}` — TUI rendering
- `cli.{h,c}` — TUI CLI parsing (we have our own arg parsing)
- `main.c` (TUI entry)
- `src/net/*` — HTTP daemon, JSON, json-c, httpserver
- `src/vendor/json-c/*`

### New code

All under `gomoku-c/src/gomocup/`:

| File | Purpose |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `main.c` | Process entry, stdio setup, main command loop |
| `protocol.h` / `protocol.c` | Command parsing, response writers |
| `coords.h` / `coords.c` | Gomocup `[X],[Y]` ↔ engine `(row,col)` translation |
| `time_budget.h` / `time_budget.c` | Per-turn / per-match clock and `time_left` updates |
| `metadata.h` | Compile-time `name="..."`, `version="..."`, `author="..."`, etc. for `ABOUT` |

## 4. Protocol Coverage

### Commands the brain MUST handle

| Command | Status | Response |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `START [size]` | Required | `OK` only when `size == 15` (Standard category); else `ERROR unsupported board size`. **Known deviation**: the protocol spec says brains "must support size 20" but the Standard tournament fixes 15×15, so this binary intentionally accepts only 15. |
| `BEGIN` | Required | `[X],[Y]` — the canonical centre square. For board size N, that is `floor((N-1)/2), floor((N-1)/2)`. On 15×15 = `7,7`. |
| `TURN [X],[Y]` | Required | `[X],[Y]` |
| `BOARD ... DONE` | Required | `[X],[Y]` |
| `INFO [key] [value]` | Required | No response — store key for later |
| `END` | Required | exit cleanly with code 0 |
| `ABOUT` | Required | One single line with comma-separated `key="value"` pairs (no embedded newlines): `name="kig-standard", version="1.0.0", author="Konstantin Gredeskoul", country="USA", www="https://kig.re", email="kigster@gmail.com"` |
| `RESTART` | Optional but supported | `OK` — clear board, keep config |
| `TAKEBACK [X],[Y]` | Optional but supported | `OK` — undo last move at cell |
| `RECTSTART [w],[h]` | Decline | `ERROR rectangular boards not supported` |
| `SWAP2BOARD` | Decline initially | `ERROR swap2 not supported` — `SWAP2BOARD` is a _known_ command in the spec, so the spec-correct way to refuse a known-but-unimplemented command is `ERROR`, not `UNKNOWN`. Standard tournament does not invoke Swap2; Freestyle does. |
| `PLAY` | Decline | We never issue `SUGGEST`, so `PLAY` should not arrive |

### Brain-initiated outputs

| Output | Purpose |
| ------------------------ | ---------------------------------------------------------------- |
| `[X],[Y]` | Move response |
| `OK` / `ERROR <message>` | Init responses |
| `UNKNOWN <message>` | For commands we don't recognise |
| `MESSAGE <text>` | Optional progress shown to user (we won't use during tournament) |
| `DEBUG <text>` | Author-only logs (gated behind a flag) |

### INFO keys to honour

| Key | Action |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeout_turn` | Store as max ms for the next move (0 = play instantly). Default if never sent: 30000 ms (the tournament cap). |
| `timeout_match` | Store as overall match budget in ms. Default if never sent: 180000 ms. |
| `time_left` | Manager's authoritative remaining match time in ms, sent before each move. **Replaces** the locally-tracked match clock — do not just decrement our estimate when this arrives. |
| `max_memory` | Log only — we'll never approach the 70 MB floor |
| `game_type` | Log only |
| `rule` | Bitmask: 1 = exactly 5 (Standard, what we play), 2 = continuous, 4 = renju, 8 = caro. We accept rule = 1 silently. For 4 (renju) or 8 (caro) we'd want to log a warning; submitting our binary in non-Standard categories is a future concern. |
| `evaluate` | Ignore (debug feature) |
| `folder` | Store the persistent file path; we currently have nothing to persist |

Unknown INFO keys: silently ignored per spec.

## 5. Time Management

The engine has `game->search_start_time` (a `double` wall-clock seconds), `game->move_timeout` (currently typed `int` seconds — see below), `game->search_timed_out` (flipped inside the search), and an iterative-deepening loop that checks the flag between depths.

**Engine-side prerequisite (BLOCKER from review)**: `move_timeout` is declared `int` in `game.h` and the search-timeout check `is_search_timed_out` does `elapsed >= move_timeout` against a `double` elapsed in seconds. Sub-second budgets (any `timeout_turn < 1000ms`) would round to 0 and behave as "no timeout" — wrong. **Fix as the very first implementation step**: widen `move_timeout` to `double` (seconds, fractional). One-line change in `game.h`, plus updates to:

- `game.c::is_search_timed_out` — already does `double` arithmetic; just stop casting through `int`.
- `cli.c` and `net/json_api.c` — both assign integer seconds to this field; assigning an int-to-double is automatic so no rewrite needed beyond a re-test.
- TUI tests in `tests/gomoku_test.cpp` — `cli_config_t.move_timeout` will need to widen too if it is set there. Check during the refactor.

This change is independent of the gomocup brain and could be backported even without the brain.

After the widening:

1. On `BEGIN` / `TURN` / `BOARD`, compute the budget for this move:
   - `budget_s = min(timeout_turn / 1000.0, (time_left - safety_margin) / 1000.0)` where `safety_margin_ms = 200` to leave room for response transmission and protocol overhead.
   - If `timeout_turn == 0` ("play instantly"), set `game->max_depth = 2` and skip iterative deepening.
1. Set `game->search_start_time = get_current_time()`; set `game->move_timeout = budget_s`.
1. Call `find_best_ai_move`. The engine short-circuits to the deepest completed depth when `search_timed_out` flips.
1. Subtract elapsed wall clock from our local `time_left` cache so the next turn is computed correctly even if no `INFO time_left` arrives. **When the next `INFO time_left` does arrive, it overrides our estimate** — the manager's value is authoritative.

Default `max_depth = 7`. Iterative deepening guarantees we always have a usable move from depth 1 even if depth 2+ time out.

## 6. Caching Across Moves

The transposition table and zobrist hash live on `game_state_t` and persist across `make_move` calls. The plan:

- One `game_state_t` is allocated at process `START` and reused for the whole match.
- On `START` and `RESTART`, reset the board cells AND call `init_transposition_table(game)` (which `init_game` already does; `RESTART` should follow the same path). Killer moves and the zobrist hash are also reset here.
- On `BOARD ... DONE`, **replay every stone through `make_move`** with the correct alternating player. `make_move` triggers `update_post_move_state`, which keeps the zobrist hash incrementally correct and invalidates the winner cache. The TT does NOT need to be flushed because every position the search visits is keyed on the same hash space — entries from previous turns are still valid for the current move and just won't match unless reached via the same hash.
- Killer moves are stored per-search-depth on `game->killer_moves[MAX_SEARCH_DEPTH][MAX_KILLER_MOVES][2]`. They are populated within a single search and stay; this is fine — they're guesses, not invariants.

This is simpler than the original draft (which reset TT on every BOARD) and gives us free reuse of any prior position-evaluation work the manager replays.

## 7. Build Plan

### 7.1 Native (macOS / Linux) build for development and CI

Add a target to `gomoku-c/Makefile`:

```makefile
GOMOCUP_TARGET   = $(BINDIR)/pbrain-kig-standard
GOMOCUP_CORE     = src/gomoku/gomoku.o src/gomoku/board.o src/gomoku/game.o src/gomoku/ai.o
GOMOCUP_SRC      = src/gomocup/main.o src/gomocup/protocol.o src/gomocup/coords.o src/gomocup/time_budget.o
GOMOCUP_CFLAGS   = -Wall -Wextra -O3 -Isrc/gomoku -Isrc/gomocup -DNO_JSON

$(GOMOCUP_TARGET): $(GOMOCUP_CORE) $(GOMOCUP_SRC) | $(BINDIR)
	$(CC) $(GOMOCUP_CORE) $(GOMOCUP_SRC) -lm -o $(GOMOCUP_TARGET)
```

Note `-DNO_JSON`: only `gomoku-c/src/gomoku/game.c` includes `json.h` (line 10). `ai.c`, `gomoku.c`, `board.c`, and their headers are JSON-clean. The dirty surface inside `game.c` is concentrated:

- `json_ms_from_seconds` helper (top of file)
- `write_game_json` (~line 733)
- `load_game_json` (~line 908)
- the `replay_data_t` plumbing in `game.h` (around lines 466 and 488)

We add `#ifndef NO_JSON ... #endif` brackets around all four sections plus the `#include "json.h"`. The TUI binary (`bin/gomoku`) will continue to define those functions because it is built without `-DNO_JSON`. The gomocup brain is built with `-DNO_JSON` and the json-c static lib is not in its link line.

### 7.2 Windows cross-compile (mingw-w64 on macOS)

Cross-compilation is feasible without a Windows VM. mingw-w64 ships in
Homebrew and produces native PE binaries that run on Windows 10/11 without
the engineer leaving macOS.

mingw-w64 is already installed on this machine (verified
`/opt/homebrew/bin/x86_64-w64-mingw32-gcc` and `i686-w64-mingw32-gcc`,
both gcc 15.2.0). For new dev machines:

```sh
brew install mingw-w64       # installs both x86_64-w64-mingw32-gcc and i686-w64-mingw32-gcc
```

Makefile targets:

```makefile
WIN64_CC = x86_64-w64-mingw32-gcc
WIN32_CC = i686-w64-mingw32-gcc
WIN_CFLAGS = -Wall -Wextra -O3 -Isrc/gomoku -Isrc/gomocup -DNO_JSON -static -static-libgcc

pbrain-kig-standard64.exe: $(GOMOCUP_CORE_WIN64) $(GOMOCUP_SRC_WIN64) | $(BINDIR)
	$(WIN64_CC) $(WIN_CFLAGS) $^ -o $(BINDIR)/$@

pbrain-kig-standard-x86.exe: $(GOMOCUP_CORE_WIN32) $(GOMOCUP_SRC_WIN32) | $(BINDIR)
	$(WIN32_CC) $(WIN_CFLAGS) -m32 $^ -o $(BINDIR)/$@

gomocup-win: pbrain-kig-standard64.exe pbrain-kig-standard-x86.exe
```

`-static` and `-static-libgcc` are critical — Gomocup judges run binaries on standard Windows installs that may not have any mingw runtime DLLs.

### POSIX-header audit (cross-compile risks)

| File | Headers | Cross-compile risk |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `gomoku.{h,c}`, `board.{h,c}`, `ai.{h,c}` | `<stdio.h>`, `<stdlib.h>`, `<string.h>`, `<time.h>`, `<math.h>`, `<ctype.h>`, `<stddef.h>`, `<stdint.h>` | None — all portable |
| `game.c::get_current_time` | `clock_gettime(CLOCK_MONOTONIC, ...)` | Supported by mingw-w64's winpthreads since ~2017 — verify at first build, fall back to `QueryPerformanceCounter` only if the build fails |
| `ansi.h` | macros only, no headers | None — the brain's `main.c` won't `printf` ANSI escapes anyway |
| `cli.c` | `<unistd.h>`, `<getopt.h>` | POSIX-only — **not linked** into the brain (we use `cli.h` for the type only, not the parser) |
| `net/*` | `<sys/socket.h>`, `httpserver.h`, json-c | **Not linked** into the brain |

Only one wrinkle is unknown until first build: `clock_gettime`. If mingw-w64 15.2 doesn't provide it out of the box, the fix is a small `get_current_time()` shim in `gomoku-c/src/gomocup/` using `QueryPerformanceCounter` on Windows and `clock_gettime` elsewhere.

### 7.3 Smoke-testing Windows binaries on the Mac

`wine64` and `wine` (32-bit) are available via `brew install --cask --no-quarantine wine-stable`. After cross-build:

```sh
wine64 bin/pbrain-kig-standard64.exe
wine bin/pbrain-kig-standard-x86.exe
```

Pipe a scripted protocol session in (see §9) to verify both binaries respond correctly before packaging.

## 8. File / Directory Layout

```
gomoku-c/
├── src/
│   ├── gomocup/                    NEW — fully self-contained
│   │   ├── main.c
│   │   ├── protocol.h
│   │   ├── protocol.c
│   │   ├── coords.h
│   │   ├── coords.c
│   │   ├── time_budget.h
│   │   ├── time_budget.c
│   │   ├── metadata.h
│   │   └── README.md               build, test, package, submit instructions
│   ├── gomoku/                     existing, lightly modified
│   │   ├── game.{h,c}              guard json includes with NO_JSON; widen move_timeout
│   │   └── ...                     ai.c, board.c, gomoku.c untouched
│   └── net/                        unchanged, not linked into the brain
├── tests/
│   ├── gomocup_test.cpp            NEW: googletest cases for parser + coords
│   └── gomocup_protocol_e2e.sh     NEW: scripted-stdin integration test
└── Makefile                        new targets: gomocup, gomocup-win, gomocup-zip
```

Everything the brain needs lives under `gomoku-c/`. No root-level `justfile`, no monorepo `bin/`, no shared assets. The `gomoku-c/src/gomocup/README.md` is the standalone-readable entry point for anyone working on the brain alone.

## 9. Testing Plan

### 9.1 Unit tests (`tests/gomocup_test.cpp`)

- `coords_round_trip`: every `(x, y)` translates and back without loss
- `parse_start`: `START 15` → size 15; `START` (no size) → error; `START -1` → error; `START 9999` → error
- `parse_turn`: `TURN 7,7` → x=7, y=7; `TURN 7,7\r\n` → same; `TURN  7 , 7` → tolerated
- `parse_board_done`: full `BOARD ... DONE` sequence reconstructs board correctly
- `parse_info_known`: `INFO timeout_turn 5000` updates the turn budget
- `parse_info_unknown`: `INFO foo bar` is silently consumed
- `format_move`: `(7, 7)` formats as `7,7`
- `about_string`: matches expected format with all fields quoted

### 9.2 Integration test (`tests/gomocup_protocol_e2e.sh`)

A bash script that pipes a known scenario through the binary and checks the output:

```
START 15
INFO timeout_turn 1000
INFO timeout_match 60000
BEGIN
TURN 7,8
END
```

Expected:

- Line 1 ≡ `OK`
- Line 2 ≡ `7,7` (centre opening on a 15x15 board)
- Line 3 ≡ a move adjacent to `(7,8)`
- Process exits 0 within ~2 seconds

Run as part of `make test` so it stays green.

### 9.3 End-to-end via Piskvork tournament manager

After the binaries pass the smoke tests:

1. Download the Piskvork manager: <https://gomocup.org/download-gomocup-manager/>
1. Place `pbrain-kig-standard64.exe` next to the manager (or in a configured brain directory)
1. Run a self-play match (kig-standard64 vs. kig-standard-x86) for 20 games at 30s/turn, 3min/match, board size 15
1. Inspect the manager's log for: illegal moves (disqualification trigger), timeouts, crashes
1. Compare game outcomes against an existing strong brain (e.g. Yixin or Wine-installable open-source brain) to gauge relative strength

This step happens after the build/test pipeline is green; we'll script it once we have a Windows machine or a Wine setup with the manager.

## 10. Submission Packaging

```
pbrain-kig-standard.zip
├── pbrain-kig-standard64.exe       (Win64 binary, must contain "64" in filename)
├── pbrain-kig-standard-x86.exe     (Win32 binary, must NOT contain "64")
└── README.txt                      (brain name, version, author, build provenance)
```

`make gomocup-zip` recipe (lives in `gomoku-c/Makefile`, no monorepo `justfile` involvement):

1. `make gomocup-win` (produces both `.exe` files in `gomoku-c/bin/`)
1. Generate `bin/README.txt` from a template + git SHA + build timestamp
1. `zip -j bin/pbrain-kig-standard.zip bin/pbrain-kig-standard64.exe bin/pbrain-kig-standard-x86.exe bin/README.txt`
1. Verify total < 256 MB (will be a few MB)

## 11. Step-by-Step Execution Order

The following order minimises risk by building outwards from a working core:

1. **Engine pre-work** (independent of the brain itself; could land in its own commit):
   - Widen `game_state_t.move_timeout` from `int` to `double` (seconds, fractional). Update `is_search_timed_out` accordingly. Existing int-second assignments in `cli.c` and `net/json_api.c` keep working via implicit promotion.
   - Add `NO_JSON` guards around the JSON-only helpers in `game.c` and the JSON prototypes in `game.h` (only `game.c` actually includes `json.h`; `ai.c` does not).
   - Verify the existing TUI binary, daemon binary, and existing tests still build and pass.
1. **Implement `coords.h/c`** with unit tests for the (column,row) ↔ (x,y) mapping. This is the smallest, most-error-prone piece; getting it right first prevents whole-system bugs later.
1. **Implement `protocol.h/c`** with a parser-only first pass (no engine calls). Unit-test parsing in isolation.
1. **Implement `metadata.h`** and the `ABOUT` response.
1. **Implement `time_budget.h/c`**: `time_left` accounting and turn budget calculation. Unit-test the math.
1. **Implement `main.c`**: the stdio dispatch loop, wiring parsed commands to engine calls. Allocate one `game_state_t` per process, default depth 7, default radius 3, rule = standard.
1. **Add native Makefile target** `pbrain-kig-standard` (no `.exe`). Build, smoke-test with the e2e script.
1. **Add Windows cross-build targets** `pbrain-kig-standard64.exe` and `pbrain-kig-standard-x86.exe`. Verify both run under `wine64` / `wine`.
1. **Write the integration test** that scripts a real game tree against the binary. Run under both native and Wine.
1. **Add a `gomocup-zip` recipe** in the root `justfile` for packaging.
1. **Manual end-to-end** with Piskvork manager (separate effort, may require a Windows VM or a Wine + Piskvork install on the Mac).
1. **Submit** to Gomocup.

## 12. Open Questions / Future Work

- **Board size 20 support**. Standard tournament uses 15x15, so we are safe. But `START 20` would currently be rejected by our brain. The engine has hardcoded `[19][19]` candidate arrays in `ai.c` and `move_t moves[361]` (= 19²) in several places. To support size 20 we would need either dynamic sizing or a `MAX_BOARD` macro lift to 25, plus a recompile. Out of scope for v1.
- **Renju and Caro categories**. Different rules require different threat scoring (e.g. Renju has forbidden moves for Black). Future work; would ship as `pbrain-kig-renju*.exe` etc.
- **Swap2 opening protocol**. Not needed for Standard tournaments. If we want to enter Freestyle later we will implement it.
- **Persistent learning across games** via `INFO folder`. Possible future opening book or refined heuristics, but the current AI is purely tactical and has no learning state.
- **Multi-threading**. The protocol allows one I/O thread + one search thread for cleaner cancellation. Our iterative-deepening time check is already cooperative inside the search; we'll start single-threaded and revisit only if tournament timing data shows it costs us games.
