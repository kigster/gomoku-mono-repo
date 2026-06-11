# Gomoku 1.4.0 — writing down the rules, and a defensive fix

This release documents the actual rules of the game variant being played (there
are several Gomoku rule sets, and ambiguity causes confusion), so players and
contributors share one reference. It also fixes a bug in how the AI assessed
threats — meaning it now defends and attacks more correctly — and improves the
HTTP client used to talk to the engine server.
