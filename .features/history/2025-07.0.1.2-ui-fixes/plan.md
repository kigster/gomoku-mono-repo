# Plan — 0.1.2 UI fixes and release tooling

## Steps

1. **Sweep the terminal UI** for the rough edges noticed after 0.1.1 and fix them
   in one batch.
2. **Fix the tag-publish step** so a release tag pushes reliably.
3. Bump `GAME_VERSION` to `0.1.2`, tag, and merge via PR.

## Testing strategy

- Manual visual pass over the board, cursor, and help screens.
- Confirm the tag lands on the remote.

## Deviations from the code

The "Force tag push" approach is what later produced the duplicate `vv0.1.2`
tag. A cleaner release step would create the tag once, verify it, and push
without `--force`, avoiding duplicate/typo tags on the remote.
