# Gomoku 0.3.2 — a real test harness, and a sneaky bug squashed

Two kinds of "make it trustworthy" work here. First, a proper automated test
setup (GoogleTest) that reliably builds and runs, so the project can prove the
game logic is correct on every change. Second, a real bug fix: the computer's
move-planning wasn't respecting the actual board size in all cases, which could
make it reason about squares that don't exist. That's now corrected.

After a long quiet stretch, this is the release where the codebase gets serious
about not regressing.
