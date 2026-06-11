# Plan — 1.0.0 JSON export, replay mode, documentation

## Steps

1. **Define the game JSON.** A schema capturing board size, the move list, result,
   and a Unicode `board_state` snapshot.
2. **Implement export.** Serialize a finished game to that JSON on demand / at
   game end.
3. **Implement replay.** Load a game JSON and step through its moves with the
   existing UI.
4. **Fix `-o` side selection** and cursor display.
5. **Write the docs** and refresh README/screenshots; reformat the code.
6. Set `GAME_VERSION` to `1.0.0`, tag.

## Testing strategy

- Round-trip tests: export a played game, reload it, assert identical board and
  result.
- Replay over recorded games to confirm deterministic playback.

## Deviations from the code

The JSON shape introduced here becomes a de-facto contract consumed by later
tooling (the schema validator in 1.1.1, the web API in 2.0). Declaring and
versioning that schema explicitly at 1.0 — rather than letting it emerge from the
serializer — would have saved the later validator work.
