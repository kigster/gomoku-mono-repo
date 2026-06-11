# Gomoku 1.1.0 — running a fleet, made manageable

Once the game became a service you could run many copies of, the next problem was
herding them. This release adds two things: support for Envoy (a modern load
balancer that spreads players across engine servers) and `gctl` — a single
command-line tool to start, stop, and manage the whole local cluster instead of
juggling processes by hand.

There's also internal cleanup (a confusingly named `board` field is renamed to
`board_size`) and a pile of recorded sample games used to evaluate AI quality.
