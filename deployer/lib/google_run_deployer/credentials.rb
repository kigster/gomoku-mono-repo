# frozen_string_literal: true

require "pathname"
require "yaml"
require "active_support/encrypted_configuration"
require "active_support/encrypted_file"

module GoogleRunDeployer
  # A single environment's encrypted secrets, backed by the exact machinery
  # behind `rails credentials:edit` — ActiveSupport::EncryptedConfiguration.
  #
  #   config/credentials/staging.yml.enc   (committed, encrypted)
  #   config/credentials/staging.key       (gitignored, mirrored in 1Password)
  #
  # The master key is resolved in this order: the `*.key` file, then the
  # env var (e.g. STAGING_MASTER_KEY), then 1Password. When only 1Password has
  # it, #ensure_key! writes the local key file so subsequent reads are offline.
  class Credentials
    attr_reader :name, :config_path, :key_path, :item_title

    def initialize(name:, config_path:, key_path:, item_title:, one_password:, env_key: nil)
      @name        = name
      @config_path = Pathname.new(config_path)
      @key_path    = Pathname.new(key_path)
      @item_title  = item_title
      @one_password = one_password
      @env_key     = env_key || "#{name.upcase}_MASTER_KEY"
    end

    def exist?
      @config_path.file?
    end

    # Guarantee a usable master key, pulling from 1Password as a last resort.
    # Returns the key path (or nil when the key only lives in the env var).
    def ensure_key!
      return @key_path if @key_path.file?
      return nil unless ENV[@env_key].to_s.empty? # env var already satisfies it

      key = @one_password.read(@item_title)
      unless key
        raise CredentialsError,
              "no master key for #{@name}: not at #{@key_path}, not in $#{@env_key}, " \
              "not in 1Password item #{@item_title.inspect}"
      end
      write_key_file(key)
      @key_path
    end

    # Decrypted secrets as a symbol-keyed Hash.
    def values
      raise CredentialsError, "credentials file missing: #{@config_path}" unless exist?

      ensure_key!
      YAML.safe_load(encrypted.read, symbolize_names: true) || {}
    rescue ActiveSupport::MessageEncryptor::InvalidMessage
      raise CredentialsError, "could not decrypt #{@config_path} — wrong master key for #{@name}?"
    end

    # Fetch one secret, raising a clear error when it is absent.
    def fetch(key)
      values.fetch(key.to_sym) do
        raise CredentialsError, "missing credential #{key.inspect} in #{@name} credentials"
      end
    end

    # Open the decrypted file in an editor, re-encrypting on save. `editor` is
    # any callable taking the temp file path — injected so specs don't spawn
    # $EDITOR. This is the literal Rails `credentials:edit` flow.
    def edit(editor:)
      raise CredentialsError, "credentials file missing: #{@config_path}; run `cloud setup #{@name}` first" unless exist?

      ensure_key!
      encrypted.change { |tmp_path| editor.call(tmp_path.to_s) }
    end

    # Create the key (locally + in 1Password) and write an initial encrypted
    # template. Refuses to clobber an existing blob.
    def bootstrap!(template: "")
      raise CredentialsError, "credentials already exist: #{@config_path}" if exist?

      @config_path.dirname.mkpath
      key = ActiveSupport::EncryptedFile.generate_key
      write_key_file(key)
      @one_password.write(@item_title, key)
      encrypted.write(template)
      @config_path
    end

    private

    def write_key_file(key)
      @key_path.dirname.mkpath
      @key_path.write(key)
      @key_path.chmod(0o600)
    end

    def encrypted
      @encrypted ||= ActiveSupport::EncryptedConfiguration.new(
        config_path: @config_path.to_s,
        key_path: @key_path.to_s,
        env_key: @env_key,
        raise_if_missing_key: true
      )
    end
  end
end
