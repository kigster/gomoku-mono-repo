# Plan — 1.1.1 Schema validator and dynamic cluster config

## Steps

1. **Formalize the game JSON schema** and write a validator script that reports
   precise violations (#53).
2. **Make cluster config dynamic.** Refactor `gctl` to generate proxy/cluster
   config from the current topology rather than static files (#51).
3. **Surface timing.** Display wait/server/queue times; simplify the `htop`
   observation helper.
4. **Polish docs/images** (#52); remove editor cruft (`.idea`).
5. Bump to `1.1.1`, tag.

## Testing strategy

- Validator unit tests over known-good and deliberately-broken game files.
- Cluster bring-up using generated config to confirm parity with the static path.

## Deviations from the code

The validator implies a canonical schema that ideally lives in one versioned file
consumed by both the C serializer and the validator, so they can't drift. If the
schema is duplicated (one in code, one in the validator), unifying it is the
durable improvement.
