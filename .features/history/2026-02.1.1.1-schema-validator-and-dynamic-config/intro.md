# Gomoku 1.1.1 — making sure saved games are valid

The game saves matches as JSON files, and other tools read them. This release
adds a validator: a script that checks a saved game actually follows the expected
format, so a malformed file gets caught instead of quietly breaking something
downstream.

The cluster manager also gets smarter — it now generates its configuration
dynamically instead of relying on fixed files — and the docs gain nicer images.
