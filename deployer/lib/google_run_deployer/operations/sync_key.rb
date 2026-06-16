# frozen_string_literal: true

module GoogleRunDeployer
  module Operations
    # Moves an environment's master key between the local `*.key` file and
    # 1Password, so a teammate (or a fresh clone) can decrypt the committed
    # credentials blob.
    class SyncKey
      def initialize(context)
        @context = context
      end

      # Pull the key from 1Password to the local key file (no-op if present).
      def pull(env_name)
        credentials = @context.credentials_for(env_name)
        path = credentials.ensure_key!
        if path
          @context.ui.success("Master key for #{env_name} ready at #{path}")
        else
          @context.ui.success("Master key for #{env_name} is supplied via environment variable")
        end
      end

      # Push the local key file up to 1Password.
      def push(env_name)
        credentials = @context.credentials_for(env_name)
        unless credentials.key_path.file?
          raise CredentialsError, "no local key file at #{credentials.key_path} to push"
        end

        @context.one_password.write(credentials.item_title, credentials.key_path.read.strip)
        @context.ui.success("Pushed #{env_name} master key to 1Password (#{credentials.item_title})")
      end
    end
  end
end
