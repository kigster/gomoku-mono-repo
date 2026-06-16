# frozen_string_literal: true

require "dry/cli"
require "pastel"

module GoogleRunDeployer
  # The command registry + a top-level runner that turns an operational Error
  # into a clean red message and a non-zero exit code (instead of a backtrace).
  module CLI
    extend Dry::CLI::Registry

    register "setup",  Commands::Setup
    register "deploy", Commands::Deploy
    register "clone",  Commands::Clone
    register "status", Commands::Status
    register "credentials edit", Commands::CredentialsEdit
    register "key pull", Commands::KeyPull
    register "key push", Commands::KeyPush
    register "version", Commands::Version, aliases: %w[-v --version]

    # @return [Integer] process exit status.
    def self.run(argv = ARGV, err: $stderr, pastel: Pastel.new)
      Dry::CLI.new(self).call(arguments: argv)
      0
    rescue GoogleRunDeployer::Error => e
      err.puts(pastel.decorate("✗ #{e.message}", :red, :bold))
      1
    end
  end
end
