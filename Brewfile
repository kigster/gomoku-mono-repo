# Brewfile — minimal external dependencies for gomoku-rust-httpd.
#
# The Rust toolchain is the one strictly required dependency. The other
# entries are quality-of-life tools wired into the justfile and lefthook.
#
# Usage:
#   brew bundle install
#
# Note: install Rust via rustup (https://rustup.rs/) for the most up-to-date
# toolchain rather than `brew install rust`. We pin only the helpers below.

# Task runner used by ./justfile.
brew "just"

# Pre-commit / pre-push hook driver.
brew "lefthook"

# Required by the integration test for parsing JSON results.
brew "python@3"

# HTTP client used in the smoke-test recipes inside justfile.
brew "curl"

# ─── Format / check tooling ──────────────────────────────────────────────────
# Used by `just/justfile.format` (format-* and check-* recipes).

# C / C++ formatter (used for gomoku-c/src and gomoku-c/tests).
brew "clang-format"

# Shell script formatter (used to format anything with a #!/bin/bash shebang).
brew "shfmt"

# Prettier — TS/JS/JSON/CSS/Markdown formatter (frontend + markdown).
brew "prettier"

# ─── Gomocup submission tooling ──────────────────────────────────────────────

# Cross-compilers for the Gomocup Win32/Win64 brain submission.
# Used by `just gomocup` via `make -C gomoku-c gomocup-win`.
brew "mingw-w64"

# `zip` ships with macOS but we list it for non-Mac runners that install
# via `brew bundle`. Used by `make -C gomoku-c gomocup-zip`.
brew "zip"

