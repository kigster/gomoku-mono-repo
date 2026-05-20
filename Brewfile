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
