# Plan — 1.4.0 Game-rules docs, AI threat fix, HTTP client

## Steps

1. **Write the rules documentation** (#61): board size(s), win condition,
   overline handling, and any forbidden-move rules — the canonical reference.
2. **Fix threat evaluation.** Identify the misclassified threat pattern(s) and
   correct the scoring so defense/attack respond properly.
3. **Improve the HTTP client** used against the daemon (error handling, protocol
   handling).
4. Bump to `1.4.0`, tag.

## Testing strategy

- Tactical regression positions targeting the previously mis-evaluated threats.
- Rules-doc cross-check against the engine's actual win/overline behavior.

## Deviations from the code

The rules documentation should be the source of truth that the engine's tests
assert against — i.e. encode the documented rules as test cases. That binds the
prose to behavior so the two can never silently diverge.
