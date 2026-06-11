# Spec — 0.5.0 AI randomness and `make format`

**Span:** `622ba10` → `d4788cd` (2 commits, 2026-01-28)
**Version:** `0.4.1` → `0.5.0`

## Theme

Add controlled AI move randomness and optimize move generation; introduce
automated code formatting.

## What was built

- **AI randomness + move-gen optimization** (#32). The engine breaks ties / picks
  among near-equal moves with controlled randomness so repeated games from the
  same position vary, and move generation is optimized for speed.
- **`make format`.** A formatting target that normalizes the C source style.
  (Note: a later commit, `7b28869`, reverts a formatting change — the formatting
  pass interacted awkwardly with other work and was partially rolled back, a
  thread picked up again around 1.0.0.)

## Oracle: version-bump assessment

A **minor** bump (`0.4.x` → `0.5.0`). The AI randomness is a real, player-visible
behavior change (added variety) and move-gen is faster — additive and
backwards-compatible, so minor is appropriate.
