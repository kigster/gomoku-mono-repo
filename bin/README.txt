pbrain-kig-standard
Author : Konstantin Gredeskoul <kigster@gmail.com>
WWW    : https://kig.re
Version: 1.0.0
Git SHA: fe30f1f
Built  : 2026-05-30T02:41:07Z

Files:
  pbrain-kig-standard-x86-64.exe Win64 brain (filename with "64" per Gomocup rule)
  pbrain-kig-standard-x86-32.exe Win32 brain

═══════════════════════════════════════════════════════════════════════════
 About pbrain-kig-standard
═══════════════════════════════════════════════════════════════════════════

This brain is the Gomocup-compatible Piskvork interface to the gomoku C
engine that lives at https://github.com/kigster/gomoku-mono-repo. The
same engine powers a Cloud-Run-hosted multiplayer service at
https://app.gomoku.games — feel free to try it.

The brain is a straightforward minimax search with alpha-beta pruning,
threat-extension at the leaves, and an iterative-deepening time
controller bounded by Gomocup's time_turn / time_match budgets. No
opening book is bundled with this submission; the engine plays the
opening from scratch every game.

The submission cross-compiles cleanly with mingw-w64 (Win32 + Win64),
links statically, and has been smoke-tested against Piskvork on Windows
under Wine. There are no runtime dependencies beyond the Windows
loader.

═══════════════════════════════════════════════════════════════════════════
 Author
═══════════════════════════════════════════════════════════════════════════

  Konstantin Gredeskoul  <kigster@gmail.com>
  Blog          : https://kig.re
  Online play   : https://app.gomoku.games
  Source code   : https://github.com/kigster/gomoku-mono-repo

Good luck to all participants — and thank you to the Gomocup organizers
for keeping the tournament running.
