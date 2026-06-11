# Gomoku 0.2.0 — teaching the computer about threats

Up to now the computer evaluated the board with fairly simple instincts. This
release gives it a proper sense of *threats* — the patterns that matter in
five-in-a-row, like "four in a row with an open end" (must block now!) or "an
open three" (getting dangerous). These patterns came from a published reference
(a threat-matrix PDF) and were encoded into how the AI scores positions.

The result is an opponent that defends and attacks much more like a human who
actually knows the game. The release also adds a software LICENSE and tidies up
the project's images and build.
