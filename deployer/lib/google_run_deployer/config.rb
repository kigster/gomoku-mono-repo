# frozen_string_literal: true

require "yaml"
require "pathname"

module GoogleRunDeployer
  # Per-environment Neon branch policy. Only the non-secret knobs live here;
  # the API key and project id come from the encrypted credentials.
  class NeonConfig < Dry::Struct
    attribute :branch_name,      Types::Strict::String
    attribute :parent_branch,    Types::Strict::String
    attribute :expires_in_hours, Types::Coercible::Integer.default(24)
    attribute :database,         Types::Strict::String.default("postgres".freeze)
    attribute :role,             Types::Strict::String.default("postgres".freeze)
    attribute :pooled,           Types::Strict::Bool.default(true)
  end

  # One deploy target (e.g. "staging" or "production"). Non-secret only.
  class EnvironmentConfig < Dry::Struct
    attribute :name,           Types::Strict::String
    attribute :project_id,     Types::Strict::String
    attribute :region,         Types::Strict::String.default("us-central1".freeze)
    attribute :custom_domain,  Types::Strict::String.default("".freeze)
    attribute :clone_database, Types::Strict::Bool.default(false)
    attribute? :neon,          NeonConfig.optional.default(nil)

    # True when this environment re-clones its Postgres from a parent Neon
    # branch on every deploy.
    def clones?
      clone_database && !neon.nil?
    end
  end

  # An optional pre-build step (e.g. bundling the SPA into the API image's
  # build context) that must finish before frontend-dependent images build.
  class FrontendConfig < Dry::Struct
    attribute :command, Types::Array.of(Types::Strict::String)
    attribute :dir,     Types::Strict::String.default(".".freeze)
  end

  # One container image to build + push. `tf_image_var` names the Terraform
  # variable that receives this image's immutable digest (e.g. "api_image").
  class ServiceConfig < Dry::Struct
    attribute :name,           Types::Strict::String
    attribute :context,        Types::Strict::String
    attribute :tf_image_var,   Types::Strict::String
    attribute :needs_frontend, Types::Strict::Bool.default(false)
  end

  # Top-level deployer.yml model: shared (non per-env) wiring plus a map of
  # environment name => EnvironmentConfig.
  class Config < Dry::Struct
    attribute :repo_root,        Types::Any
    attribute :credentials_dir,  Types::Strict::String
    attribute :terraform_dir,    Types::Strict::String
    attribute :tf_state_bucket,  Types::Strict::String
    attribute :tf_state_prefix,  Types::Strict::String
    attribute :artifact_repo,    Types::Strict::String
    attribute :migrate_command,  Types::Array.of(Types::Strict::String)
    attribute :migrate_dir,      Types::Strict::String
    attribute :op_vault,         Types::Strict::String
    attribute :op_item_template, Types::Strict::String
    attribute? :frontend,        FrontendConfig.optional.default(nil)
    attribute :services,         Types::Array.of(ServiceConfig)
    attribute :environments,     Types::Hash.map(Types::Strict::String, EnvironmentConfig)

    # Locate, parse and validate deployer.yml.
    def self.from_file(path: nil, repo_root: Dir.pwd)
      root = Pathname.new(repo_root).expand_path
      file = resolve_path(path, root)
      raise ConfigError, "deployer config not found at #{file}" unless file.file?

      raw =
        begin
          YAML.safe_load_file(file, symbolize_names: true)
        rescue Psych::SyntaxError => e
          raise ConfigError, "deployer config #{file} is not valid YAML: #{e.message}"
        end
      raise ConfigError, "deployer config #{file} is empty" unless raw.is_a?(Hash)

      from_hash(raw, root)
    end

    # Build a Config from an already-parsed hash (symbol keys).
    def self.from_hash(raw, repo_root)
      envs = (raw[:environments] || {}).each_with_object({}) do |(name, body), acc|
        acc[name.to_s] = build_environment(name.to_s, body || {})
      end
      raise ConfigError, "deployer config defines no environments" if envs.empty?

      new(
        repo_root: Pathname.new(repo_root),
        credentials_dir: raw.fetch(:credentials_dir, "deployer/config/credentials"),
        terraform_dir: raw.dig(:terraform, :dir) || "iac/cloud_run",
        tf_state_bucket: raw.dig(:terraform, :state_bucket) || raise_missing("terraform.state_bucket"),
        tf_state_prefix: raw.dig(:terraform, :state_prefix) || "cloud-run/%{environment}",
        artifact_repo: raw.fetch(:artifact_repo, "gomoku-repo"),
        migrate_command: Array(raw.dig(:migrate, :command) || %w[true]).map(&:to_s),
        migrate_dir: raw.dig(:migrate, :dir) || ".",
        op_vault: raw.dig(:onepassword, :vault) || "Private",
        op_item_template: raw.dig(:onepassword, :item_template) || "%{environment}-master-key",
        frontend: build_frontend(raw[:frontend]),
        services: Array(raw[:services]).map { |s| ServiceConfig.new(s) },
        environments: envs
      )
    rescue Dry::Struct::Error => e
      raise ConfigError, "deployer config is invalid: #{e.message}"
    end

    # Fetch one environment, raising a friendly error listing the valid names.
    def environment(name)
      environments.fetch(name.to_s) do
        raise ConfigError,
              "unknown environment #{name.inspect}; known: #{environments.keys.sort.join(', ')}"
      end
    end

    # Absolute path to <repo_root>/<relative>.
    def path(relative)
      repo_root.join(relative)
    end

    # The GCS state prefix for one environment (template fills %{environment}).
    def state_prefix_for(environment)
      format(tf_state_prefix, environment: environment)
    end

    # The 1Password item title holding an environment's master key.
    def op_item_for(environment)
      format(op_item_template, environment: environment)
    end

    def self.build_environment(name, body)
      neon = body[:neon] && NeonConfig.new(body[:neon])
      EnvironmentConfig.new(
        name: name,
        project_id: body.fetch(:project_id) { raise ConfigError, "environment #{name} is missing project_id" },
        region: body.fetch(:region, "us-central1"),
        custom_domain: body.fetch(:custom_domain, ""),
        clone_database: body.fetch(:clone_database, false),
        neon: neon
      )
    end
    private_class_method :build_environment

    def self.build_frontend(body)
      return nil unless body

      FrontendConfig.new(command: Array(body[:command]).map(&:to_s), dir: body[:dir] || ".")
    end
    private_class_method :build_frontend

    def self.raise_missing(key)
      raise ConfigError, "deployer config is missing required key #{key.inspect}"
    end
    private_class_method :raise_missing

    def self.resolve_path(path, repo_root)
      return Pathname.new(path).expand_path if path
      return Pathname.new(ENV["DEPLOYER_CONFIG"]).expand_path if ENV["DEPLOYER_CONFIG"]

      repo_root.join("deployer", "config", "deployer.yml")
    end
    private_class_method :resolve_path
  end
end
