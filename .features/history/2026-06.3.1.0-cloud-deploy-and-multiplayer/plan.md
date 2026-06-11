# Plan — 3.1.0 (proposed) Cloud deploy, multiplayer, chat, presence

## Steps

1. **Productionize deployment** (#80). Cloud Run pipeline, Honeycomb/OTel tracing,
   keep-warm instance, and worker tuning sized to Cloud Run resources.
2. **Design multiplayer** (#90, #94). A `games.game_type` discriminator separating
   AI and human games; invite links, join/cancel, lazy expiry, and tiered polling
   for live updates. Cover it with `test_multiplayer.py`.
3. **Add presence + chat** (#95, #96). Solo/Multi tabs, a chat panel with slash
   commands, and a "who's online" presence list; flip the default modal.
4. **Port the daemon to Rust.** Re-implement the move server in `gomoku-httpd-rust`
   with parity tests against the C engine.
5. **Fix AI correctness** (#83). Broken threat patterns and the overline rule;
   prune dead caches and tune search (#86).
6. **Ship a Gomocup brain** (#89). `pbrain-kig-standard` speaking the Gomocup
   protocol.
7. **Adopt a multi-agent dev workflow** (#81) and supporting skills/CI.
8. **Cut the release.** Bump `GAME_VERSION` (to `3.1.0` or `4.0.0`), tag, deploy.

## Testing strategy

- `test_multiplayer.py` for the two-human flow (invite → join → moves → result).
- Rust unit/doc tests with parity checks against the C engine.
- Tactical regressions for the threat/overline fix.
- End-to-end multiplayer across two browser sessions (later realized as the
  Playwright two-human suite).

## Deviations from the code

The defining deviation is the **missing version bump**: a span this large shipped
without cutting a release, leaving `GAME_VERSION` at `3.0.0` while production
gained multiplayer, cloud deploy, and a Rust engine. The disciplined approach cuts
at least one release here (`3.1.0`), and likely a major (`4.0.0`) for multiplayer,
so the deployed product and its version number agree. This is also the right place
to split the work into separate releases — deploy/telemetry, multiplayer, Rust
port — each independently shippable and versioned, rather than one undifferentiated
37-commit drift.
