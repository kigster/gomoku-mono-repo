# frozen_string_literal: true

require "tty-command"

module GoogleRunDeployer
  module Adapters
    # Wraps TTY::Command for the streaming build/deploy steps. Two printers are
    # used across the deploy: `:pretty` streams terraform/alembic output as it
    # happens; `:null` stays silent so a TTY::Spinner can own the line during
    # parallel image builds.
    class CommandRunner
      def initialize(printer: :pretty, output: $stdout, command: nil)
        @cmd = command || TTY::Command.new(printer: printer, output: output)
      end

      # Run a command, raising CommandError on a non-zero exit.
      # @return [TTY::Command::Result]
      def run(*argv, chdir: nil, env: {})
        @cmd.run(*argv, chdir: chdir&.to_s, env: env)
      rescue TTY::Command::ExitError => e
        raise CommandError, e.message
      end

      # Run a command without raising; the caller inspects the result.
      # @return [TTY::Command::Result]
      def run!(*argv, chdir: nil, env: {})
        @cmd.run!(*argv, chdir: chdir&.to_s, env: env)
      end
    end
  end
end
