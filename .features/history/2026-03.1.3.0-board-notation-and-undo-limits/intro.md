# Gomoku 1.3.0 — coordinates, take-backs, and a peek under the hood

A batch of player-facing niceties. The board gains proper notation (named
coordinates, like chess's "e4") so moves can be referred to and read back. Undo
gets sensible limits so you can take back a move without rewinding the whole game.
And a JSON debug modal lets curious users (and developers) inspect the raw game
state behind the scenes.

Plus the usual maintenance: AI search optimizations and fixes for newer Apple
compilers so it keeps building on modern Macs.
