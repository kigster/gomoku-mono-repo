# frozen_string_literal: true

require "securerandom"

module GoogleRunDeployer
  module Operations
    # `cloud setup <env>` — one-time provisioning: create the encrypted
    # credentials blob (prompting for the secrets that can't be defaulted),
    # generate + store the master key in 1Password, and initialise the
    # per-environment Terraform state so the first `deploy` has somewhere to go.
    class Setup
      def initialize(context)
        @context = context
        @ui = context.ui
        @config = context.config
      end

      def call(env_name)
        env = @config.environment(env_name)
        @ui.banner("Setup → #{env_name}")
        warn_unless_op_available

        credentials = @context.credentials_for(env_name)
        if credentials.exist?
          @ui.warn("Credentials already exist at #{credentials.config_path}")
          @ui.say("Edit them with: cloud credentials edit #{env_name}")
        else
          bootstrap_credentials(env, credentials)
        end

        prefix = @config.state_prefix_for(env_name)
        @ui.step("Initializing Terraform state (#{prefix})")
        @context.terraform.init(prefix: prefix)

        @ui.success("#{env_name} is ready — next run: cloud deploy #{env_name}")
      end

      private

      def warn_unless_op_available
        return if @context.one_password.available?

        @ui.warn("1Password CLI (op) unavailable — the master key will live only on this machine.")
      end

      def bootstrap_credentials(env, credentials)
        @ui.step("Provisioning encrypted credentials for #{env.name}")
        values = {
          "neon_api_key" => @ui.mask("Neon API key:"),
          "neon_project_id" => @ui.ask("Neon project id:")
        }
        values["database_url"] = @ui.ask("Database URL (Neon pooled DSN):") unless env.clones?
        values["jwt_secret"] = SecureRandom.base64(48)
        @ui.say("Generated a fresh JWT secret.")

        credentials.bootstrap!(template: template(env, values))
        @ui.success("Encrypted #{credentials.config_path}; master key saved to 1Password.")
      end

      def template(env, values)
        body = ["# #{env.name} credentials — edit with: cloud credentials edit #{env.name}"]
        values.each { |key, value| body << "#{key}: #{value}" unless value.to_s.empty? }
        body.concat([
                      "# honeycomb_api_key:",
                      "# honeycomb_dataset:",
                      "# email_provider: stdout",
                      "# email_from:",
                      "# sendgrid_api_key:"
                    ])
        "#{body.join("\n")}\n"
      end
    end
  end
end
