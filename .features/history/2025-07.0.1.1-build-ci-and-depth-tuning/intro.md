# Gomoku 0.1.1 — making it build anywhere, and play a touch smarter

The first release worked on the author's laptop. This update is mostly about
making it work on *other* machines too — adding a proper "build recipe"
(a Makefile) so anyone can compile it with one command, and wrestling the
automated test robot until it ran green on the project's chosen setups.

There's also a small gameplay tweak: the difficulty levels were re-tuned so the
computer's "how many moves ahead do I think" setting feels right at each level.
