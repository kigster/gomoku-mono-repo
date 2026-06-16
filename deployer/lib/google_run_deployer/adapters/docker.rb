# frozen_string_literal: true

module GoogleRunDeployer
  module Adapters
    # Builds, pushes, and resolves immutable digests for the service images.
    # Pinning the @sha256 digest (not the :tag) is what makes Cloud Run roll
    # to a new revision every deploy instead of re-serving a stale :latest.
    class Docker
      def initialize(runner:, region:, project_id:, repo: "gomoku-repo")
        @runner = runner
        @registry = "#{region}-docker.pkg.dev/#{project_id}/#{repo}"
      end

      def configure_auth(region)
        @runner.run("gcloud", "auth", "configure-docker", "#{region}-docker.pkg.dev", "--quiet")
      end

      def tag_for(image, environment)
        "#{@registry}/#{image}:#{environment}"
      end

      # Build for linux/amd64 and push. Returns the pushed tag.
      def build_and_push(context_dir:, tag:)
        @runner.run("docker", "buildx", "build", "--platform", "linux/amd64",
                    "-t", tag, "--load", context_dir.to_s)
        @runner.run("docker", "push", tag)
        tag
      end

      # Resolve a tag to its immutable repo digest (registry/image@sha256:...).
      def resolve_digest(tag)
        result = @runner.run!("docker", "inspect",
                              "--format", "{{range .RepoDigests}}{{.}}\n{{end}}", tag)
        base = tag.split(":").first
        digest = result.out.to_s.each_line.map(&:strip).find { |line| line.start_with?("#{base}@") }
        return digest if digest

        raise CommandError, "could not resolve digest for #{tag}"
      end
    end
  end
end
