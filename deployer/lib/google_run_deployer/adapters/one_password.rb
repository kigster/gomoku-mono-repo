# frozen_string_literal: true

module GoogleRunDeployer
  module Adapters
    # Reads and writes secrets in 1Password via the `op` CLI. Master keys for
    # the encrypted credentials live here as Password items, so a freshly
    # cloned repo can pull the key it needs to decrypt without a human pasting
    # anything.
    #
    # Every secret is stored as a `password`-category item whose title is the
    # key name (e.g. "gomoku-staging-master-key") inside a single vault.
    class OnePassword
      def initialize(vault:, shell: Shell.new)
        @vault = vault
        @shell = shell
      end

      # Is the op CLI installed and reachable?
      def available?
        @shell.call(%w[op --version]).success?
      end

      # A `op://vault/title/password` reference, handy for `op run` templating.
      def reference(title)
        "op://#{@vault}/#{title}/password"
      end

      # Does an item with this title already exist in the vault?
      def exists?(title)
        @shell.call(["op", "item", "get", title, "--vault", @vault]).success?
      end

      # Return the password field of an item, or nil when it doesn't exist.
      def read(title)
        result = @shell.call(["op", "read", reference(title)])
        return nil unless result.success?

        result.stdout.chomp
      end

      # Create or replace an item's password field. Idempotent.
      def write(title, value)
        result =
          if exists?(title)
            @shell.call(["op", "item", "edit", title, "password=#{value}", "--vault", @vault])
          else
            @shell.call(["op", "item", "create", "--category", "password",
                         "--title", title, "--vault", @vault, "password=#{value}"])
          end

        return true if result.success?

        raise OnePasswordError, "failed to store #{title.inspect} in 1Password: #{result.stderr.strip}"
      end
    end
  end
end
