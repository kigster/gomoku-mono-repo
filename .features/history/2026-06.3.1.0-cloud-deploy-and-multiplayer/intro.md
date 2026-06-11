# Gomoku 3.1.0 (proposed) — play against real people, live on the internet

This is the stretch where Gomoku becomes a genuine online multiplayer game and a
properly deployed cloud service. Two headline abilities: it now runs on Google
Cloud Run with real monitoring (so the team can see what's happening in
production), and you can play *another human* — create an invite link, send it to
a friend, and play a live game where each move shows up in both browsers, with a
chat panel and a "who's online" presence list.

Under the hood there's also a second engine written in Rust (a faster, safer
re-implementation of the move server) and a tournament "brain" that can compete in
the standardized Gomocup AI competition.

Note: the version number in the code still says 3.0.0 — this body of work was
never formally cut as a release. The Oracle below argues it deserves its own
version.
