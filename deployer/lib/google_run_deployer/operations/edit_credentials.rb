# frozen_string_literal: true

module GoogleRunDeployer
  module Operations
    # `cloud credentials edit <env>` — the literal Rails credentials:edit flow:
    # pull the master key (from 1Password if needed), decrypt to a tempfile,
    # open $EDITOR, re-encrypt on save.
    class EditCredentials
      def initialize(context)
        @context = context
      end

      def call(env_name)
        credentials = @context.credentials_for(env_name)
        @context.ui.step("Editing #{env_name} credentials")
        credentials.edit(editor: @context.editor.method(:open))
        @context.ui.success("Saved #{env_name} credentials")
      end
    end
  end
end
