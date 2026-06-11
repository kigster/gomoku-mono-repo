# Gomoku 2.0.0 — from terminal toy to real web app

This is the leap. Gomoku stops being only a terminal program and becomes a proper
web application: a browser-based game you sign into, with a backend that
remembers who you are, records your games, scores them, and ranks everyone on a
leaderboard.

Three big pieces arrive together — a web frontend you play in, a server with user
accounts and a database, and the scoring/leaderboard system that makes it
competitive. The old C engine is still the brain that picks AI moves; now it sits
behind a web service that handles people, logins, and history. Calling it 2.0 is
no exaggeration — it's a different kind of product.
