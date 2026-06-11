# Gomoku 0.1.0 — the first one that actually works

Imagine the old board game where two people take turns dropping black and white
stones on a grid, and whoever lines up five in a row first wins. This is that —
except it runs in a terminal window, drawn with text characters, and you play
against the computer.

This first release is the whole game in one place: a board you can see, a
keyboard cursor you move around, an opponent that thinks a few moves ahead
before answering you, and the win/lose/draw logic that decides when it's over.
There's no website, no accounts, no network — just `./gomoku` in a terminal and
a game of five-in-a-row against a machine that's already a little bit clever.

It also got a robot janitor (continuous integration) that rebuilds the game and
runs its tests every time the code changes, so a careless edit can't quietly
break it.
