# frozen_string_literal: true

module GoogleRunDeployer
  module Operations
    # The full Cloud Run deploy for one environment:
    #   1. decrypt credentials
    #   2. (staging) re-clone Neon → fresh DSN; else use credentials' database_url
    #   3. run migrations against that DSN
    #   4. terraform init + bootstrap (APIs + Artifact Registry must exist
    #      before we can push images)
    #   5. build + push every service image — frontend-independent images run
    #      in parallel with the frontend bundle, then frontend-dependent images
    #   6. terraform apply with the immutable image digests
    #   7. print the resulting service/domain URLs
    class Deploy
      # Terraform resources to create in the bootstrap pass, before image push.
      BOOTSTRAP_TARGETS = %w[
        google_project_service.run_api
        google_project_service.artifact_registry_api
        google_project_service.cloudbuild_api
        google_artifact_registry_repository.repo
      ].freeze

      def initialize(context)
        @context = context
        @ui = context.ui
        @config = context.config
      end

      def call(env_name)
        env = @config.environment(env_name)
        @ui.banner("Deploy → #{env_name}")

        credentials = @context.credentials_for(env_name)
        values = credentials.values
        database_url = resolve_database_url(env, values, credentials)

        @ui.step("Running database migrations")
        @context.alembic.upgrade(database_url: database_url, environment: env_name)

        terraform = @context.terraform
        @ui.step("Terraform init + registry bootstrap")
        terraform.init(prefix: @config.state_prefix_for(env_name))
        secrets = secret_vars(env, values, database_url)
        terraform.apply(vars: base_vars(env).merge("httpd_image" => "placeholder", "api_image" => "placeholder"),
                        secrets: secrets, targets: BOOTSTRAP_TARGETS)

        digests = build_and_push(env)

        @ui.step("Terraform apply")
        terraform.apply(vars: base_vars(env).merge(digests), secrets: secrets)

        @ui.success("Deployed #{env_name}")
        report(terraform, env)
      end

      private

      def resolve_database_url(env, values, credentials)
        return CloneDatabase.new(@context).call(env, credentials: credentials) if env.clones?

        values.fetch(:database_url) do
          raise CredentialsError, "#{env.name} does not clone and has no database_url credential"
        end
      end

      # Build + push images, returning { "<tf_image_var>" => "<digest>" }.
      def build_and_push(env)
        docker = @context.docker_for(env)
        docker.configure_auth(env.region)
        frontend = @context.frontend
        services = @config.services

        phase1 = {}
        phase1["frontend"] = -> { frontend.build } if frontend
        services.reject(&:needs_frontend).each { |svc| phase1[svc.name] = build_job(docker, env, svc) }
        @ui.parallel("build", phase1) unless phase1.empty?

        phase2 = services.select(&:needs_frontend).each_with_object({}) do |svc, jobs|
          jobs[svc.name] = build_job(docker, env, svc)
        end
        @ui.parallel("build (frontend-dependent)", phase2) unless phase2.empty?

        services.each_with_object({}) do |svc, digests|
          digests[svc.tf_image_var] = docker.resolve_digest(docker.tag_for(svc.name, env.name))
        end
      end

      def build_job(docker, env, svc)
        tag = docker.tag_for(svc.name, env.name)
        -> { docker.build_and_push(context_dir: @config.path(svc.context), tag: tag) }
      end

      # Non-sensitive Terraform variables (safe on the command line).
      def base_vars(env)
        {
          "project_id" => env.project_id,
          "region" => env.region,
          "environment" => env.name,
          "custom_domain" => env.custom_domain
        }
      end

      # Sensitive Terraform variables, passed via TF_VAR_* env, not argv.
      def secret_vars(env, values, database_url)
        {
          "jwt_secret" => values.fetch(:jwt_secret) { raise CredentialsError, "missing jwt_secret for #{env.name}" },
          "database_url" => database_url,
          "honeycomb_api_key" => values[:honeycomb_api_key].to_s,
          "honeycomb_dataset" => values[:honeycomb_dataset].to_s,
          "email_provider" => values.fetch(:email_provider, "stdout"),
          "email_from" => values[:email_from].to_s,
          "email_from_name" => values[:email_from_name].to_s,
          "sendgrid_api_key" => values[:sendgrid_api_key].to_s
        }
      end

      def report(terraform, env)
        @ui.say("API (public):  #{terraform.output('api_url')}")
        @ui.say("Engine:        #{terraform.output('httpd_url')}")
        @ui.say("Custom domain: #{env.custom_domain}") unless env.custom_domain.empty?
      end
    end
  end
end
