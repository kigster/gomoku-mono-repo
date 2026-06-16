# frozen_string_literal: true

RSpec.describe GoogleRunDeployer::Adapters::Docker do
  let(:runner) { instance_double(GoogleRunDeployer::Adapters::CommandRunner) }
  let(:registry) { "us-central1-docker.pkg.dev/proj/repo" }
  subject(:docker) do
    described_class.new(runner: runner, region: "us-central1", project_id: "proj", repo: "repo")
  end

  describe "#tag_for" do
    it "composes registry/image:env" do
      expect(docker.tag_for("gomoku-api", "staging")).to eq("#{registry}/gomoku-api:staging")
    end
  end

  describe "#configure_auth" do
    it "runs gcloud auth configure-docker" do
      expect(runner).to receive(:run)
        .with("gcloud", "auth", "configure-docker", "us-central1-docker.pkg.dev", "--quiet")
      docker.configure_auth("us-central1")
    end
  end

  describe "#build_and_push" do
    it "builds for amd64, pushes, and returns the tag" do
      tag = "#{registry}/gomoku-api:staging"
      expect(runner).to receive(:run)
        .with("docker", "buildx", "build", "--platform", "linux/amd64", "-t", tag, "--load", "/ctx")
      expect(runner).to receive(:run).with("docker", "push", tag)

      expect(docker.build_and_push(context_dir: "/ctx", tag: tag)).to eq(tag)
    end
  end

  describe "#resolve_digest" do
    let(:tag) { "#{registry}/gomoku-api:staging" }

    it "returns the repo digest matching the image" do
      out = "#{registry}/gomoku-api@sha256:abc123\n"
      expect(runner).to receive(:run!).and_return(instance_double(TTY::Command::Result, out: out))

      expect(docker.resolve_digest(tag)).to eq("#{registry}/gomoku-api@sha256:abc123")
    end

    it "raises when no digest is found" do
      expect(runner).to receive(:run!).and_return(instance_double(TTY::Command::Result, out: ""))
      expect { docker.resolve_digest(tag) }.to raise_error(GoogleRunDeployer::CommandError, /digest/)
    end
  end
end
