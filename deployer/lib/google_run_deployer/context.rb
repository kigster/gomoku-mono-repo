# frozen_string_literal: true

module GoogleRunDeployer
  # The single composition root. Builds every collaborator an operation needs
  # from a Config, with all I/O boundaries (runners, 1Password, clock, UI)
  # injectable so specs can swap in doubles without touching the network,
  # filesystem, or a real terminal.
  class Context
    attr_reader :config, :ui, :one_password

    attr_reader :editor

    def initialize(config:, ui: UI.new, one_password: nil, editor: nil,
                   stream_runner: nil, quiet_runner: nil, clock: -> { Time.now })
      @config = config
      @ui = ui
      @one_password = one_password || Adapters::OnePassword.new(vault: config.op_vault)
      @editor = editor || Adapters::Editor.new
      @stream_runner = stream_runner || Adapters::CommandRunner.new(printer: :pretty)
      @quiet_runner = quiet_runner || Adapters::CommandRunner.new(printer: :null)
      @clock = clock
    end

    def now
      @clock.call
    end

    # Encrypted credentials for one environment (Rails-style blob + key).
    def credentials_for(env_name)
      dir = config.path(config.credentials_dir)
      Credentials.new(
        name: env_name,
        config_path: dir.join("#{env_name}.yml.enc"),
        key_path: dir.join("#{env_name}.key"),
        item_title: config.op_item_for(env_name),
        one_password: @one_password
      )
    end

    # Neon client keyed by the secrets in `credentials`.
    def neon(credentials)
      Adapters::Neon.new(
        api_key: credentials.fetch(:neon_api_key),
        project_id: credentials.fetch(:neon_project_id)
      )
    end

    def terraform
      @terraform ||= Adapters::Terraform.new(
        runner: @stream_runner,
        dir: config.path(config.terraform_dir),
        state_bucket: config.tf_state_bucket
      )
    end

    # Docker is per-environment (registry path includes project + region).
    def docker_for(env)
      Adapters::Docker.new(
        runner: @quiet_runner, region: env.region,
        project_id: env.project_id, repo: config.artifact_repo
      )
    end

    # The optional pre-build (frontend bundle), or nil when not configured.
    def frontend
      return nil unless config.frontend

      Adapters::Frontend.new(
        runner: @quiet_runner,
        command: config.frontend.command,
        dir: config.path(config.frontend.dir)
      )
    end

    def alembic
      Adapters::Alembic.new(
        runner: @stream_runner,
        command: config.migrate_command,
        dir: config.path(config.migrate_dir)
      )
    end
  end
end
