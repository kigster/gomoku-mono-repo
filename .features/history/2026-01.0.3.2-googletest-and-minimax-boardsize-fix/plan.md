# Plan — 0.3.2 GoogleTest harness and minimax board-size fix

## Steps

1. **Fix the GoogleTest build.** Make the test dependency configure and compile
   on the first `cmake`/build invocation (vendor pin or fetch ordering), and
   bump GoogleTest to a known-good version.
2. **Fix minimax board-size handling.** Audit the search and move generation for
   hard-coded dimensions; parameterize on the actual board size so off-board
   cells are never evaluated.
3. **Clear compiler warnings.** Add the missing `unistd.h` include; silence the
   UI buffer warnings.
4. **Strengthen tests.** Add timing-reset assertions to the undo test.
5. **Add scaffolding/docs.** `.claude/` folder, `OVERVIEW`, difficulty-label fix.
6. Bump `GAME_VERSION` to `0.3.2`, tag, merge via PR #15.

## Testing strategy

- Clean-checkout `ctest` run as the build-reliability proof.
- A regression test that plays/searches on a non-default board size to lock in
  the minimax fix.

## Deviations from the code

The minimax board-size bug is the kind that a property-style test ("the search
never references a coordinate outside `[0, size)`") would have caught earlier and
prevents from recurring. Adding that invariant test alongside the fix is the
durable version of this change.
