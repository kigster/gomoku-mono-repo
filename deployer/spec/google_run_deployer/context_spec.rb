# frozen_string_literal: true

RSpec.describe GoogleRunDeployer::Context do
  def config_with(extra = {})
    base = {
      credentials_dir: "creds",
      terraform: { dir: "tf", state_bucket: "bkt" },
      onepassword: { vault: "Private", item_template: "g-%{environment}-key" },
      migrate: { command: %w[migrate now], dir: "api" },
      services: [{ name: "api", context: "api", tf_image_var: "api_image" }],
      environments: { staging: { project_id: "p", region: "us-central1" } }
    }.merge(extra)
    GoogleRunDeployer::Config.from_hash(base, "/repo")
  end

  subject(:context) { described_class.new(config: config_with(frontend: { command: %w[just build], dir: "." })) }

  describe "#now" do
    it "uses the injected clock" do
      frozen = Time.utc(2026, 6, 15)
      ctx = described_class.new(config: config_with, clock: -> { frozen })
      expect(ctx.now).to eq(frozen)
    end

    it "defaults to the wall clock" do
      expect(described_class.new(config: config_with).now).to be_a(Time)
    end
  end

  describe "#credentials_for" do
    it "builds Credentials with env-derived paths and op item title" do
      creds = context.credentials_for("staging")
      expect(creds.config_path.to_s).to eq("/repo/creds/staging.yml.enc")
      expect(creds.key_path.to_s).to eq("/repo/creds/staging.key")
      expect(creds.item_title).to eq("g-staging-key")
    end
  end

  describe "#neon" do
    it "keys the client off the credentials' secrets" do
      creds = instance_double(GoogleRunDeployer::Credentials)
      allow(creds).to receive(:fetch).with(:neon_api_key).and_return("nk")
      allow(creds).to receive(:fetch).with(:neon_project_id).and_return("proj")
      expect(context.neon(creds)).to be_a(GoogleRunDeployer::Adapters::Neon)
    end
  end

  describe "adapter builders" do
    it "builds terraform, docker, frontend and alembic" do
      env = context.config.environment("staging")
      expect(context.terraform).to be_a(GoogleRunDeployer::Adapters::Terraform)
      expect(context.terraform).to equal(context.terraform) # memoized
      expect(context.docker_for(env)).to be_a(GoogleRunDeployer::Adapters::Docker)
      expect(context.frontend).to be_a(GoogleRunDeployer::Adapters::Frontend)
      expect(context.alembic).to be_a(GoogleRunDeployer::Adapters::Alembic)
      expect(context.editor).to be_a(GoogleRunDeployer::Adapters::Editor)
    end

    it "returns nil frontend when none is configured" do
      ctx = described_class.new(config: config_with)
      expect(ctx.frontend).to be_nil
    end
  end

  describe "injected collaborators" do
    it "uses provided ui and one_password" do
      ui = double("ui")
      op = double("op")
      ctx = described_class.new(config: config_with, ui: ui, one_password: op)
      expect(ctx.ui).to equal(ui)
      expect(ctx.one_password).to equal(op)
    end
  end
end
