# Gomoku 0.4.0 — the brain gets a serious upgrade

This is the release where the computer opponent goes from "decent" to "genuinely
sharp." Several things happen at once. The AI's way of generating and ranking
candidate moves is rebuilt and several thinking bugs are fixed. It gains a
"memory" of positions it has already analyzed (a transposition table) so it
doesn't waste time re-evaluating the same situations — made ten times bigger and
properly managed. It also searches a little wider around the action and prunes
its options more carefully.

On top of the smarts, you can now pick who plays whom: three game modes
(human-vs-AI, and the other combinations). There's even a self-play benchmark so
the project can measure whether the AI is actually getting better.
