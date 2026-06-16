# frozen_string_literal: true

module GoogleRunDeployer
  # Base class for every error this gem raises on purpose. Commands rescue
  # this at the top level and render it as a clean message instead of a Ruby
  # backtrace, so anything inheriting from Error is "expected/operational".
  class Error < StandardError; end

  # Raised when deployer.yml is missing, unparseable, or references an unknown
  # environment.
  class ConfigError < Error; end

  # Raised when an encrypted credentials file or its master key cannot be
  # found, decrypted, or written.
  class CredentialsError < Error; end

  # Raised when the `op` (1Password) CLI is missing, signed out, or returns a
  # non-zero status.
  class OnePasswordError < Error; end

  # Raised when the Neon API returns a non-2xx response or an unexpected body.
  class NeonError < Error; end

  # Raised when a shelled-out command (terraform, docker, gcloud, alembic)
  # exits non-zero.
  class CommandError < Error; end
end
