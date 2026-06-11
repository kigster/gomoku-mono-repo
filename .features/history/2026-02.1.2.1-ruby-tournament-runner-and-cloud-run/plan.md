# Plan — 1.2.1 Ruby tournament runner and Cloud Run workflow

## Steps

1. **Build the tournament runner** (Ruby): pair configured engine variants, play
   N games each side, tally W/L/D, and print a verbose report.
2. **Restructure eval scripts** around the runner so they share one harness.
3. **Add the Cloud Run update workflow** (#55) to deploy engine updates.
4. **Expand the local Envoy cluster** for heavier testing.
5. Bump to `1.2.1`, tag.

## Testing strategy

- Run a small round-robin and confirm deterministic, seed-controlled results.
- Dry-run the Cloud Run workflow against a staging target.

## Deviations from the code

A tournament runner is most useful when its results gate merges (a strength
regression fails CI). Wiring the runner into CI as a quality gate — not just a
manual tool — is the higher-value version of this work.
