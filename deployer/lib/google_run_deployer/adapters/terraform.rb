# frozen_string_literal: true

module GoogleRunDeployer
  module Adapters
    # Drives `terraform` in the configured stack directory. State is isolated
    # per environment via the GCS backend `prefix` passed at init time, so
    # staging and production never share a state file.
    class Terraform
      def initialize(runner:, dir:, state_bucket:)
        @runner = runner
        @dir = dir
        @state_bucket = state_bucket
      end

      # Re-init with the per-environment backend prefix. `-reconfigure` swaps
      # the backend cleanly when the previous init targeted another env.
      def init(prefix:)
        @runner.run("terraform", "init", "-reconfigure", "-upgrade",
                    "-backend-config=bucket=#{@state_bucket}",
                    "-backend-config=prefix=#{prefix}",
                    chdir: @dir)
      end

      # `terraform apply -auto-approve`.
      #
      # `vars` become non-sensitive -var flags. `secrets` (e.g. jwt_secret,
      # database_url) are passed as TF_VAR_* environment variables instead, so
      # they never appear in the process argument list (`ps`)/shell history.
      # `targets` (optional) scope the apply to specific resources for the
      # registry/API bootstrap pass.
      def apply(vars:, secrets: {}, targets: [])
        argv = ["terraform", "apply", "-auto-approve"]
        targets.each { |target| argv << "-target=#{target}" }
        vars.each { |key, value| argv << "-var=#{key}=#{value}" }
        env = secrets.transform_keys { |key| "TF_VAR_#{key}" }
        @runner.run(*argv, chdir: @dir, env: env)
      end

      # A single `-raw` output value (empty string when undefined).
      def output(name)
        @runner.run!("terraform", "output", "-raw", name, chdir: @dir).out.to_s.strip
      end
    end
  end
end
