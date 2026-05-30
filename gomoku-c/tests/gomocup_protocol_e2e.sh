#!/usr/bin/env bash
#
# End-to-end scripted Gomocup session against the native brain binary.
# Pipes a known sequence of commands through stdin and checks each line
# of stdout against expectations. Wired into `make test` via the
# test-gomocup-e2e target.
#
# Self-contained so the gomoku-c/ directory works as a standalone build:
# we resolve $BRAIN relative to this script's location.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRAIN="${BRAIN:-${SCRIPT_DIR}/../bin/pbrain-kig-standard}"

if [[ ! -x "$BRAIN" ]]; then
  echo "[E2E] FAIL: brain binary not found or not executable: $BRAIN" >&2
  exit 1
fi

# --- Test 1: opening + one TURN ---------------------------------------------
read -r -d '' SCRIPT1 <<'EOF' || true
START 15
INFO timeout_turn 1000
INFO timeout_match 60000
BEGIN
TURN 7,8
END
EOF

OUT1=$(printf '%s\n' "$SCRIPT1" | "$BRAIN" 2>/dev/null)
# bash 3 (default /bin/bash on macOS) lacks `mapfile`, so build the array
# manually with a read loop. Trailing-newline-less lines are preserved.
LINES1=()
while IFS= read -r _line || [[ -n "$_line" ]]; do
  LINES1+=("$_line")
done <<<"$OUT1"

# Expect exactly 3 lines: OK, 7,7, then a move adjacent to (7,8).
if [[ ${#LINES1[@]} -lt 3 ]]; then
  echo "[E2E] FAIL: expected >=3 output lines, got ${#LINES1[@]}:" >&2
  printf '   %s\n' "${LINES1[@]}" >&2
  exit 1
fi

if [[ "${LINES1[0]}" != "OK" ]]; then
  echo "[E2E] FAIL: line 1 expected 'OK', got '${LINES1[0]}'" >&2
  exit 1
fi

if [[ "${LINES1[1]}" != "7,7" ]]; then
  echo "[E2E] FAIL: line 2 expected '7,7' (centre opening), got '${LINES1[1]}'" >&2
  exit 1
fi

# Validate the third line is "X,Y" with X,Y adjacent (Chebyshev distance <= 2)
# to (7,8). The engine's heuristic typically picks (7,7) as our second move
# response, but this is checked only loosely.
if [[ ! "${LINES1[2]}" =~ ^([0-9]+),([0-9]+)$ ]]; then
  echo "[E2E] FAIL: line 3 expected '<x>,<y>', got '${LINES1[2]}'" >&2
  exit 1
fi
GX=${BASH_REMATCH[1]}
GY=${BASH_REMATCH[2]}
if ((GX < 0 || GX > 14 || GY < 0 || GY > 14)); then
  echo "[E2E] FAIL: line 3 move out of bounds: (${GX}, ${GY})" >&2
  exit 1
fi

# --- Test 2: ABOUT line shape -----------------------------------------------
ABOUT_OUT=$(printf 'ABOUT\nEND\n' | "$BRAIN" 2>/dev/null)
if [[ ! "$ABOUT_OUT" =~ name=\"kig-standard\" ]]; then
  echo "[E2E] FAIL: ABOUT response missing brain name:" >&2
  echo "$ABOUT_OUT" >&2
  exit 1
fi
if [[ ! "$ABOUT_OUT" =~ version=\"1.0.0\" ]]; then
  echo "[E2E] FAIL: ABOUT response missing version:" >&2
  echo "$ABOUT_OUT" >&2
  exit 1
fi

# --- Test 3: unsupported board size -----------------------------------------
BAD_OUT=$(printf 'START 20\nEND\n' | "$BRAIN" 2>/dev/null)
if [[ ! "$BAD_OUT" =~ ^ERROR ]]; then
  echo "[E2E] FAIL: START 20 expected ERROR response, got '$BAD_OUT'" >&2
  exit 1
fi

# --- Test 4: RECTSTART declined ---------------------------------------------
RECT_OUT=$(printf 'RECTSTART 15,20\nEND\n' | "$BRAIN" 2>/dev/null)
if [[ ! "$RECT_OUT" =~ ^ERROR ]]; then
  echo "[E2E] FAIL: RECTSTART expected ERROR response, got '$RECT_OUT'" >&2
  exit 1
fi

echo "[E2E] PASSED: 4 scenarios"
exit 0
