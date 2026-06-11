# Plan — 3.0.0 UI refactor, leaderboard polish, deploy options

## Steps

1. **Refactor the frontend.** Restructure `App.tsx` and the modal components
   (rules, settings, JSON debug); add the ambient background; clean up API config
   (#73).
2. **Fix leaderboard uniqueness** (#79). Ensure one ranked row per user (dedupe
   query or schema constraint), preserving each user's best score.
3. **Document deployment.** Write `DEPLOY-OPTIONS.md`, refresh the Cloud Run and
   deployment docs.
4. **Tooling.** Add Claude Code skills/plugins; capture codebase-analysis docs.
5. **Dependency hygiene.** Apply the dependabot bumps.
6. Set `GAME_VERSION` to `3.0.0`, tag.

## Testing strategy

- Frontend tests over the refactored components.
- A leaderboard test asserting one row per user and correct ordering.
- Deploy dry-runs against the documented options.

## Deviations from the code

The leaderboard-uniqueness fix is a correctness/data change worth isolating with
its own migration and test, separate from the cosmetic UI refactor — they have
very different risk profiles. Bundling a data-semantics fix inside a 390-file
polish release makes it easy to overlook in review.
