# Gomoku 1.0.1 — the game becomes a service

Until now Gomoku was a program you ran on your own computer. This release turns
the game engine into a *server*: a long-running daemon that answers questions
over the web ("here's a board — what's the AI's move?") via a simple REST API.
Because it holds no state between calls, you can run many copies behind a load
balancer and serve lots of players at once.

It also ships the whole deployment kit — Docker containers, Kubernetes configs,
infrastructure-as-code, and a working cluster of ten engine servers behind
HAProxy. Despite the modest "1.0.1" label, this is the foundation that makes a
web version possible.
