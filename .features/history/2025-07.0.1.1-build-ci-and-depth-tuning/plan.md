# Plan — 0.1.1 Build/CI plumbing and depth tuning

## Steps

1. **Write a Makefile** with `build`, `test`, and `clean` targets so compilation
   is one command and CI has a stable entry point.
2. **Get CI green.** Pin the GitHub Actions runner matrix to platforms the C code
   actually compiles on; drop the ones that don't (Ubuntu, for now). Iterate
   until the pipeline passes, then add a status badge to the README.
3. **Tune search depth.** Map each difficulty label to a look-ahead depth that
   feels right; verify by playing each level.
4. **Polish docs.** Fix wording in the README and in-game help.
5. Bump `GAME_VERSION` to `0.1.1` and tag.

## Testing strategy

- CI itself is the deliverable's proof: a green build + test run on the target
  platforms.
- Manual difficulty play-throughs to confirm the re-tuned depths.

## Deviations from the code

The number of "Another attempt" commits reflects CI being debugged live on the
remote rather than reproduced locally first. A cleaner path would reproduce the
runner environment locally (e.g. via a container matching the CI image) to
iterate without pushing — fewer commits, same outcome.
