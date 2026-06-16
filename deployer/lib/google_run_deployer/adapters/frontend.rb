# frozen_string_literal: true

module GoogleRunDeployer
  module Adapters
    # Runs the optional pre-build step (e.g. bundling the SPA into an image's
    # build context). A no-op when deployer.yml declares no `frontend` block.
    class Frontend
      def initialize(runner:, command:, dir:)
        @runner = runner
        @command = command
        @dir = dir
      end

      def build
        @runner.run(*@command, chdir: @dir)
      end
    end
  end
end
