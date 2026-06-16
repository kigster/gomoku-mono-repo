# frozen_string_literal: true

module GoogleRunDeployer
  module Adapters
    # Runs database migrations against a target DSN. The command and working
    # directory are configurable (deployer.yml `migrate:`), so this is not
    # Alembic-specific despite the name — any `DATABASE_URL`-driven migrator
    # works (the Gomoku project uses `uv run alembic upgrade head`).
    class Alembic
      def initialize(runner:, command:, dir:)
        @runner = runner
        @command = command
        @dir = dir
      end

      # @param database_url [String] DSN exposed to the migrator as DATABASE_URL.
      # @param environment [String] exposed as ENVIRONMENT for app config.
      def upgrade(database_url:, environment:)
        @runner.run(*@command, chdir: @dir,
                    env: { "DATABASE_URL" => database_url, "ENVIRONMENT" => environment })
      end
    end
  end
end
