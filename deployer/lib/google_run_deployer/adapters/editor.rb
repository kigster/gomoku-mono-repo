# frozen_string_literal: true

module GoogleRunDeployer
  module Adapters
    # Opens a file in the user's $EDITOR (the decrypted tempfile, during
    # `credentials:edit`). `system` is injected so specs never spawn vi.
    class Editor
      def initialize(env: ENV, system: Kernel.method(:system))
        @env = env
        @system = system
      end

      def open(path)
        editor = @env["EDITOR"] || @env["VISUAL"] || "vi"
        ok = @system.call(*editor.split, path.to_s)
        raise CredentialsError, "editor #{editor.inspect} exited non-zero" unless ok
      end
    end
  end
end
