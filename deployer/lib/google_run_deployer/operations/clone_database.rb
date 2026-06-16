# frozen_string_literal: true

require "time"

module GoogleRunDeployer
  module Operations
    # Re-clones an environment's Postgres from its parent Neon branch and
    # returns a fresh pooled DSN. The branch carries a rolling `expires_at`
    # (default 24h) so an idle staging clone auto-deletes — the next deploy
    # just recreates it, and because the DSN is always fetched live, that churn
    # is invisible to the caller.
    class CloneDatabase
      def initialize(context)
        @context = context
      end

      # @param env [EnvironmentConfig]
      # @param credentials [Credentials] reused from the caller to avoid a
      #   second decrypt; built on demand otherwise.
      # @return [String] pooled DATABASE_URL for the fresh branch.
      def call(env, credentials: nil)
        raise ConfigError, "environment #{env.name} is not configured to clone a database" unless env.clones?

        credentials ||= @context.credentials_for(env.name)
        neon = @context.neon(credentials)
        cfg = env.neon
        expires_at = (@context.now + (cfg.expires_in_hours * 3600)).utc.iso8601

        @context.ui.spin("Cloning Neon #{cfg.branch_name} ⇐ #{cfg.parent_branch} (expires in #{cfg.expires_in_hours}h)") do
          neon.reclone(
            name: cfg.branch_name, parent_branch: cfg.parent_branch,
            database: cfg.database, role: cfg.role,
            expires_at: expires_at, pooled: cfg.pooled
          )
        end
      end
    end
  end
end
