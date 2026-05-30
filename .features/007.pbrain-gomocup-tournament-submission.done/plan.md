# 04 — Gomocup Tournament Submission

The repo ships **`pbrain-kig-standard`**, a Gomocup-protocol brain
that wraps the same C99 engine the TUI and web flows use. It targets
the **Standard** category at <https://gomocup.org/> (15×15 board,
exact five-in-a-row, overlines do not win).

- Brain name: `kig-standard`
- Version: `1.0.0`
- Author: Konstantin Gredeskoul
- Protocol: <https://plastovicka.github.io/protocl2en.htm>
- Tournament rules: <https://gomocup.org/detail-information/>

## Where it lives

The brain is a self-contained subdirectory under
`gomoku-c/src/gomocup/`. It links against the shared engine in
`gomoku-c/src/gomoku/` compiled with `-DNO_JSON` so it has zero
runtime dependencies (no json-c, no HTTP daemon, no TUI tooling).

```
gomoku-c/
|-- src/
|   |-- gomocup/
|   |   |-- main.c          stdin/stdout dispatch loop
|   |   |-- protocol.{c,h}  command parser (no engine state)
|   |   |-- coords.{c,h}    Gomocup [X],[Y] <-> engine (row, col)
|   |   |-- time_budget.{c,h} per-turn budget computation
|   |   |-- metadata.h      ABOUT line strings
|   |   `-- README.md       brain-local docs (more detail than this page)
|   `-- gomoku/             shared engine (linked with -DNO_JSON)
|-- tests/
|   |-- gomocup_test.cpp           parser + coord unit tests
|   `-- gomocup_protocol_e2e.sh    scripted-stdin integration test
`-- Makefile                       build + packaging recipes
```

The full local README lives at
[gomoku-c/src/gomocup/README.md](../gomoku-c/src/gomocup/README.md).

## Build

### Native (macOS / Linux) — for development

```bash
cd gomoku-c
make pbrain-kig-standard
./bin/pbrain-kig-standard
```

The native binary speaks the same protocol as the Windows submission;
you can drive it interactively to exercise the parser:

```bash
printf 'START 15\nABOUT\nBEGIN\nTURN 7,8\nEND\n' | ./bin/pbrain-kig-standard
```

### Windows (cross-compile from macOS / Linux)

The two `.exe` files are the actual tournament artefacts. Both are
statically linked so they run on a stock Windows install with no
mingw runtime DLLs.

```bash
brew install mingw-w64                      # macOS
# or: apt install mingw-w64                  # Linux
cd gomoku-c
make gomocup-win
ls bin/pbrain-kig-standard-x86-64.exe bin/pbrain-kig-standard-x86-32.exe
```

Verify there are no third-party DLL dependencies:

```bash
x86_64-w64-mingw32-objdump -p bin/pbrain-kig-standard64.exe | grep "DLL Name"
# Should show only KERNEL32 + api-ms-win-crt-* (Windows 10/11 baseline UCRT).
```

## Package the submission ZIP

```bash
cd gomoku-c
make gomocup-zip
ls bin/pbrain-kig-standard.zip
```

The ZIP contains:

- `pbrain-kig-standard-x86-64.exe` — Win64 (filename must contain `64` per
  Gomocup rules)
- `pbrain-kig-standard-x86-32.exe` — Win32
- `README.txt` stamped with the git SHA and build timestamp

Total size is a few hundred KB, well under the 256 MB Gomocup
ceiling.

## Find the latest submission

The pre-built ZIP is in `gomoku-c/bin/pbrain-kig-standard.zip` after
running `make gomocup-zip`. The CI pipeline does **not** publish the
ZIP as a release artefact today — to grab a fresh submission you
must build it locally on a machine with `mingw-w64` installed.

The brain version lives in `gomoku-c/src/gomocup/metadata.h` (used
in the protocol's `ABOUT` line). Bump it when the engine or protocol
behaviour changes.

## Submit to Gomocup

1. Sign in at <https://gomocup.org/>.
1. Upload `bin/pbrain-kig-standard.zip` to the **Standard** category.
1. Watch the result page for tournament games and crash logs.

Before submitting, manually exercise the binaries against the
official **Piskvork** tournament manager on a Windows host. Piskvork
catches wire-format and behavioural regressions that the automated
tests can miss. Download it from
<https://gomocup.org/download-gomocup-manager/>.

## Protocol notes

- Board size is fixed at 15 in the Standard category. `START n` for
  `n != 15` is rejected with `ERROR unsupported board size`.
- `RECTSTART`, `SWAP2BOARD`, and `PLAY` are recognised but declined
  with `ERROR <reason>` (not used in Standard).
- `INFO` keys honoured: `timeout_turn`, `timeout_match`, `time_left`.
  All other keys are silently consumed per spec.
- `time_left` from the manager is authoritative; the brain's internal
  estimate is overwritten on every `INFO time_left`.
- The brain reserves a **200 ms safety margin** against the
  manager's deadline so transmission delay or a context switch does
  not cause a forfeit.
- Default search depth is **5** with iterative deepening; default
  search radius is **3**. The first move on `BEGIN` is the centre
  square `(7, 7)`.
- Tournament limits: ≤ 30 s per turn, ≤ 3 min per match, ≥ 70 MB
  memory, ≤ 256 MB ZIP, ≤ 20 MB per-brain runtime.

## Tests

```bash
cd gomoku-c
make test                    # full suite: engine + daemon + gomocup parser + e2e
make test-gomocup-e2e        # just the scripted-stdin scenarios
```

The full `make test` includes:

- 33 engine unit tests (`tests/gomoku_test.cpp`)
- 34 daemon unit tests (`tests/daemon_test.cpp`)
- 17 gomocup parser + coord unit tests (`tests/gomocup_test.cpp`)
- 4 scripted protocol scenarios (`tests/gomocup_protocol_e2e.sh`)

## Smoke-test under Wine (optional)

If `wine` is available you can dry-run the cross-built binaries
before packaging:

```bash
brew install --cask --no-quarantine wine-stable     # macOS, once
printf 'START 15\nBEGIN\nEND\n' | wine64 bin/pbrain-kig-standard-x86-64.exe
printf 'START 15\nBEGIN\nEND\n' | wine   bin/pbrain-kig-standard-x86-32.exe
```

Wine isn't strictly required — the Windows-VM submission step
catches any wire-format issues — but it's a fast sanity check.

## Rating implications

Gomocup itself uses **BayesElo with `eloAdvantage=0`,
`eloDraw=0.01`** to rank submitted brains. Our local Elo system
mirrors those parameters so the human-vs-AI rating numbers on
<https://app.gomoku.games> are commensurable with what an engine
would score against the field. See
[doc/gomocup-elo-rankings.md](../../reference/gomocup-bayesian-elo-system.md) for the full
treatment.

## See also

- [gomoku-c/src/gomocup/README.md](../gomoku-c/src/gomocup/README.md)
  — long-form brain README with build, test, and protocol detail.
- [doc/gomocup-protocol.md](../../reference/gomocup-protocol-v2-implementation.md) — protocol
  implementation plan.
- [doc/ai-engine.md](../../reference/c-engine-ai-algorithm-deep-dive.md) — engine internals.
- [doc/gomocup-elo-rankings.md](../../reference/gomocup-bayesian-elo-system.md) — BayesElo
  scoring system.
