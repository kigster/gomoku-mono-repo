# frozen_string_literal: true

module GoogleRunDeployer
  module Operations
    # `cloud status <env>` — read the live Cloud Run URLs from Terraform state
    # plus whether the encrypted credentials are present locally.
    class ShowStatus
      def initialize(context)
        @context = context
      end

      def call(env_name)
        env = @context.config.environment(env_name)
        terraform = @context.terraform
        terraform.init(prefix: @context.config.state_prefix_for(env_name))

        ui = @context.ui
        credentials = @context.credentials_for(env_name)
        ui.banner("Status → #{env_name}")
        ui.say("Project:       #{env.project_id}")
        ui.say("Region:        #{env.region}")
        ui.say("Custom domain: #{env.custom_domain.empty? ? '(none)' : env.custom_domain}")
        ui.say("Clones DB:     #{env.clones? ? "yes (Neon #{env.neon.branch_name})" : 'no'}")
        ui.say("API URL:       #{terraform.output('api_url')}")
        ui.say("Engine URL:    #{terraform.output('httpd_url')}")
        ui.say("Credentials:   #{credentials.exist? ? 'present' : 'MISSING'} (#{credentials.config_path})")
      end
    end
  end
end
