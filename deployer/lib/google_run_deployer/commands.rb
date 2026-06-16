# frozen_string_literal: true

require "dry/cli"

module GoogleRunDeployer
  # dry-cli command layer. Each command is a thin adapter: parse the argument,
  # build the Context, and hand off to an Operation. All logic — and all the
  # interesting tests — live in the operations.
  module Commands
    class Setup < Dry::CLI::Command
      desc "Provision an environment: encrypted credentials + Terraform state"
      argument :environment, required: true, desc: "Environment name (e.g. staging)"

      def call(environment:, **)
        Operations::Setup.new(GoogleRunDeployer.build_context).call(environment)
      end
    end

    class Deploy < Dry::CLI::Command
      desc "Build images, (re)clone the DB, and apply Terraform to an environment"
      argument :environment, required: true, desc: "Environment name (e.g. staging)"

      def call(environment:, **)
        Operations::Deploy.new(GoogleRunDeployer.build_context).call(environment)
      end
    end

    class Clone < Dry::CLI::Command
      desc "Re-clone an environment's Postgres from its parent Neon branch"
      argument :environment, required: true, desc: "Environment name (e.g. staging)"

      def call(environment:, **)
        context = GoogleRunDeployer.build_context
        env = context.config.environment(environment)
        Operations::CloneDatabase.new(context).call(env)
        context.ui.success("Re-cloned #{environment} database")
      end
    end

    class Status < Dry::CLI::Command
      desc "Show an environment's live Cloud Run URLs and credential state"
      argument :environment, required: true, desc: "Environment name (e.g. staging)"

      def call(environment:, **)
        Operations::ShowStatus.new(GoogleRunDeployer.build_context).call(environment)
      end
    end

    class CredentialsEdit < Dry::CLI::Command
      desc "Edit an environment's encrypted credentials in $EDITOR (Rails-style)"
      argument :environment, required: true, desc: "Environment name (e.g. staging)"

      def call(environment:, **)
        Operations::EditCredentials.new(GoogleRunDeployer.build_context).call(environment)
      end
    end

    class KeyPull < Dry::CLI::Command
      desc "Fetch an environment's master key from 1Password to the local key file"
      argument :environment, required: true, desc: "Environment name (e.g. staging)"

      def call(environment:, **)
        Operations::SyncKey.new(GoogleRunDeployer.build_context).pull(environment)
      end
    end

    class KeyPush < Dry::CLI::Command
      desc "Upload the local master key file to 1Password"
      argument :environment, required: true, desc: "Environment name (e.g. staging)"

      def call(environment:, **)
        Operations::SyncKey.new(GoogleRunDeployer.build_context).push(environment)
      end
    end

    class Version < Dry::CLI::Command
      desc "Print the deployer version"

      def call(**)
        puts GoogleRunDeployer::VERSION
      end
    end
  end
end
