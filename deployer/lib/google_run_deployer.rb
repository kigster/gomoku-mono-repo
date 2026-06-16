# frozen_string_literal: true

require_relative "google_run_deployer/version"
require_relative "google_run_deployer/errors"
require_relative "google_run_deployer/types"
require_relative "google_run_deployer/config"

require_relative "google_run_deployer/adapters/shell"
require_relative "google_run_deployer/adapters/command_runner"
require_relative "google_run_deployer/adapters/one_password"
require_relative "google_run_deployer/adapters/editor"
require_relative "google_run_deployer/adapters/neon"
require_relative "google_run_deployer/adapters/docker"
require_relative "google_run_deployer/adapters/terraform"
require_relative "google_run_deployer/adapters/frontend"
require_relative "google_run_deployer/adapters/alembic"

require_relative "google_run_deployer/credentials"
require_relative "google_run_deployer/ui"
require_relative "google_run_deployer/context"

require_relative "google_run_deployer/operations/clone_database"
require_relative "google_run_deployer/operations/deploy"
require_relative "google_run_deployer/operations/edit_credentials"
require_relative "google_run_deployer/operations/sync_key"
require_relative "google_run_deployer/operations/show_status"
require_relative "google_run_deployer/operations/setup"

require_relative "google_run_deployer/commands"
require_relative "google_run_deployer/cli"

# A config-driven CLI for promoting a service through ephemeral and production
# environments on Google Cloud Run, with Rails-style encrypted credentials
# (master keys in 1Password) and per-deploy Neon Postgres branch clones.
module GoogleRunDeployer
  class << self
    attr_writer :context_builder

    # The project root the relative paths in deployer.yml resolve against.
    # Set by the `cloud` shim; falls back to the current directory.
    def repo_root
      ENV["DEPLOYER_REPO_ROOT"] || Dir.pwd
    end

    # How commands obtain a Context. Overridable in specs to inject doubles.
    def context_builder
      @context_builder ||= -> { Context.new(config: Config.from_file(repo_root: repo_root)) }
    end

    def build_context
      context_builder.call
    end
  end
end
