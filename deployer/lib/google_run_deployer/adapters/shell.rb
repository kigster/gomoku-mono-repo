# frozen_string_literal: true

require "open3"

module GoogleRunDeployer
  module Adapters
    # Thin, synchronous wrapper over Open3.capture3. Used by collaborators that
    # need a command's full output and exit status without any TTY streaming
    # (1Password, digest resolution). Injecting this lets specs stub a single
    # seam instead of poking at Open3 everywhere.
    class Shell
      Result = Struct.new(:status, :stdout, :stderr, keyword_init: true) do
        def success?
          status.zero?
        end
      end

      # @param argv [Array<String>] command + args, never shell-interpolated.
      # @param chdir [String, Pathname, nil] working directory.
      # @param env [Hash] extra environment for the child process.
      def call(argv, chdir: nil, env: {})
        opts = {}
        opts[:chdir] = chdir.to_s if chdir
        stdout, stderr, status = Open3.capture3(env, *argv, **opts)
        Result.new(status: status.exitstatus, stdout: stdout, stderr: stderr)
      end
    end
  end
end
