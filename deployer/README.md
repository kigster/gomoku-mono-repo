# google-run-deployer

A small, config-driven CLI for promoting a service through **ephemeral** and **production** environments on **Google Cloud Run**, with:

- **Rails-style encrypted credentials** — per-environment `*.yml.enc` blobs committed to the repo, decrypted with the exact machinery behind `rails credentials:edit` (`ActiveSupport::EncryptedConfiguration`).
- **Master keys in 1Password** — the `*.key` files are gitignored and mirrored to a 1Password vault, so a fresh clone can pull the key it needs to decrypt.
- **Per-deploy Neon Postgres clones** — staging re-clones production into a throwaway Neon branch (rolling 24h expiry) on every deploy, so you test against real-shaped data and the clone auto-expires when idle.
- **A multi-spinner TUI** — frontend-independent image builds run in parallel under `TTY::Spinner::Multi`; Terraform/migrations stream their output.

Built with `dry-cli`, `dry-struct`, `dry-monads`, the `tty-toolkit`, `faraday`, and `activesupport`.

## Commands

```
cloud setup <env>              # provision: encrypted credentials + master key in 1Password + Terraform state
cloud credentials edit <env>   # decrypt → $EDITOR → re-encrypt (literally rails credentials:edit)
cloud deploy <env>             # (re)clone DB → migrate → parallel image build → terraform apply
cloud clone <env>              # re-clone the environment's Postgres from its parent Neon branch
cloud status <env>             # live Cloud Run URLs + credential state
cloud key pull <env>           # fetch the master key from 1Password to the local key file
cloud key push <env>           # upload the local master key file to 1Password
cloud version
```

In this repo the binary is invoked through the repo-root shim **`bin/cloud`**, which
points the gem at the repo root and runs it under the gem's pinned Ruby.

## Typical flow

```bash
bin/cloud setup staging          # one-time: seed secrets, push key to 1Password, init state
bin/cloud credentials edit staging
bin/cloud deploy staging         # re-clones DB (24h), migrates, builds, deploys → staging.gomoku.games
# …verify in a browser…
bin/cloud deploy production
```

## Configuration

Everything non-secret lives in [`config/deployer.yml`](config/deployer.yml): the
GCP project/region per environment, custom domains, the service images to build,
the Terraform stack + state layout, the Neon clone policy, and the 1Password vault.
Every secret (`jwt_secret`, `neon_api_key`, `database_url`, Honeycomb/SendGrid keys)
lives only in the encrypted credentials blob.

### Secrets layout

```
config/credentials/
  staging.yml.enc      # committed (ciphertext)
  staging.key          # gitignored, mirrored at op://<vault>/<app>-staging-master-key
  production.yml.enc
  production.key
```

The master key is resolved in order: the local `*.key` file → the
`<ENV>_MASTER_KEY` environment variable → 1Password.

## Development

```bash
bundle install
bundle exec rspec          # 100% line coverage is enforced by SimpleCov
bundle exec rubocop
```

## License

MIT.
