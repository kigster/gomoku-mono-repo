# Terminal AI Game Binary

## Goal

A self-contained ANSI-coloured C99 binary that lets a human play Gomoku
against an AI opponent in any terminal, with **zero runtime dependencies**.
The binary is the fastest way to "feel" the engine and the canonical
reference for the gameplay rules, board sizes, and difficulty knobs that
all other surfaces (web, gomocup brain) inherit.

## Users and use cases

- **Developers** running the engine locally without installing Python,
  Node, or a browser.
- **Tournament-style AI-vs-AI runs** (`-x ai -o ai -q`) producing JSON
  game records for the eval harness.
- **Replay viewers** that step through a saved JSON game move-by-move.

## Functional requirements

- Runs on any platform with a C99 compiler (macOS, Linux, BSD, WSL, slim
  containers).
- Boards: 15×15 (default) and 19×19.
- Player types per side: `human` or `ai`. Default `human` vs `ai`.
- Arrow-key navigation; `Space`/`Enter` to place; `u` to undo (capped);
  `q` to quit.
- Difficulty knobs the user can tune:
  - `--depth N` (1–10) — alpha-beta look-ahead in plies, or `N:M` for
    asymmetric per-player depths.
  - `--level easy|medium|hard` — friendly aliases (2/4/6).
  - `--radius 1–5` — candidate-move generator distance from existing
    stones.
  - `--timeout SECS` — wall-clock cap per move; AI returns its best so
    far, human forfeits.
- Recording / replay:
  - `--json FILE` writes every move to a JSON file in the format the web
    flow and `gomoku-httpd` both speak.
  - `--replay FILE` plays a saved game back.
  - `--wait SECS` auto-advances the replay; default waits for keypress.
- Headless mode (`--quiet`) for tournament pipelines: AI-vs-AI, no UI,
  JSON to stdout.
- Threat-pattern hints with `--hints` (blinking overlay).
- Build: `just build-game` (preferred) or `make -C gomoku-c all install`.

## Quality criteria

- No third-party runtime dependencies — must build and run on a stock
  toolchain.
- Move generation, scoring, and win detection must match the shared
  engine used by `gomoku-httpd` and the web flow (so replays are
  cross-compatible).
- A "first match" experience of `bin/gomoku -d 4 -r 3 -t 30` is
  expected to be competent but playable for a novice human.

## Out of scope

- Network play directly from the TUI (use the HTTP daemon or web flow).
- Themes / colour customisation beyond the default ANSI palette.
- Localisation.

## Cross-references

- Implementation plan and CLI reference: see `plan.md` in this folder.
- Engine internals: `reference/c-engine-ai-algorithm-deep-dive.md`.
- Game rules: `reference/gomoku-and-renju-rules.md`.
