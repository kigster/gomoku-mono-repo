# frozen_string_literal: true

RSpec.describe GoogleRunDeployer::Operations::Deploy do
  let(:ui) { instance_double(GoogleRunDeployer::UI) }
  let(:config) { instance_double(GoogleRunDeployer::Config) }
  let(:terraform) { instance_double(GoogleRunDeployer::Adapters::Terraform) }
  let(:docker) { instance_double(GoogleRunDeployer::Adapters::Docker) }
  let(:frontend) { instance_double(GoogleRunDeployer::Adapters::Frontend) }
  let(:alembic) { instance_double(GoogleRunDeployer::Adapters::Alembic) }
  let(:credentials) { instance_double(GoogleRunDeployer::Credentials) }
  let(:context) { instance_double(GoogleRunDeployer::Context, ui: ui, config: config) }

  subject(:operation) { described_class.new(context) }

  def service(name, var, needs_frontend: false)
    GoogleRunDeployer::ServiceConfig.new(name: name, context: name, tf_image_var: var, needs_frontend: needs_frontend)
  end

  def env(name, clone:, domain:)
    neon = clone ? GoogleRunDeployer::NeonConfig.new(branch_name: name, parent_branch: "production") : nil
    GoogleRunDeployer::EnvironmentConfig.new(
      name: name, project_id: "p", region: "us-central1", custom_domain: domain,
      clone_database: clone, neon: neon
    )
  end

  before do
    %i[banner step success say].each { |m| allow(ui).to receive(m) }
    allow(ui).to receive(:parallel) { |_title, jobs| jobs.transform_values(&:call) }
    allow(context).to receive(:credentials_for).and_return(credentials)
    allow(context).to receive(:alembic).and_return(alembic)
    allow(context).to receive(:terraform).and_return(terraform)
    allow(context).to receive(:docker_for).and_return(docker)
    allow(config).to receive(:state_prefix_for) { |e| "cr/#{e}" }
    allow(config).to receive(:path) { |p| Pathname.new("/repo/#{p}") }
    allow(alembic).to receive(:upgrade)
    allow(terraform).to receive(:init)
    allow(terraform).to receive(:apply)
    allow(terraform).to receive(:output).with("api_url").and_return("https://api")
    allow(terraform).to receive(:output).with("httpd_url").and_return("https://httpd")
    allow(docker).to receive(:configure_auth)
    allow(docker).to receive(:tag_for) { |name, e| "reg/#{name}:#{e}" }
    allow(docker).to receive(:build_and_push)
    allow(docker).to receive(:resolve_digest) { |tag| "#{tag}@sha256:dig" }
    allow(frontend).to receive(:build)
  end

  context "staging (clones DB, frontend + two-phase build)" do
    before do
      allow(config).to receive(:environment).with("staging").and_return(env("staging", clone: true, domain: "s.g"))
      allow(config).to receive(:services).and_return([service("httpd", "httpd_image"),
                                                       service("api", "api_image", needs_frontend: true)])
      allow(context).to receive(:frontend).and_return(frontend)
      allow(credentials).to receive(:values).and_return(jwt_secret: "j", honeycomb_api_key: "hc")
      clone_op = instance_double(GoogleRunDeployer::Operations::CloneDatabase, call: "postgresql://cloned")
      allow(GoogleRunDeployer::Operations::CloneDatabase).to receive(:new).with(context).and_return(clone_op)
    end

    it "clones, migrates, builds both phases, and applies terraform with digests" do
      operation.call("staging")

      expect(alembic).to have_received(:upgrade).with(database_url: "postgresql://cloned", environment: "staging")
      expect(frontend).to have_received(:build)
      expect(docker).to have_received(:build_and_push).twice
      expect(ui).to have_received(:parallel).twice # frontend-independent, then frontend-dependent

      expect(terraform).to have_received(:apply).with(
        vars: hash_including("httpd_image" => "reg/httpd:staging@sha256:dig",
                             "api_image" => "reg/api:staging@sha256:dig",
                             "environment" => "staging", "custom_domain" => "s.g"),
        secrets: hash_including("jwt_secret" => "j", "database_url" => "postgresql://cloned",
                                "honeycomb_api_key" => "hc", "email_provider" => "stdout")
      )
    end

    it "runs a registry bootstrap apply before pushing images" do
      operation.call("staging")
      expect(terraform).to have_received(:apply).with(
        vars: hash_including("httpd_image" => "placeholder", "api_image" => "placeholder"),
        secrets: anything,
        targets: array_including("google_artifact_registry_repository.repo")
      )
    end

    it "reports the resulting URLs and the custom domain" do
      operation.call("staging")
      expect(ui).to have_received(:say).with("API (public):  https://api")
      expect(ui).to have_received(:say).with(/Custom domain: s\.g/)
    end
  end

  context "production (static DB, no frontend, single build phase)" do
    before do
      allow(config).to receive(:environment).with("production").and_return(env("production", clone: false, domain: ""))
      allow(config).to receive(:services).and_return([service("httpd", "httpd_image")])
      allow(context).to receive(:frontend).and_return(nil)
    end

    it "uses the credentials' database_url and skips the frontend-dependent phase" do
      allow(credentials).to receive(:values).and_return(database_url: "postgresql://prod", jwt_secret: "j")

      operation.call("production")

      expect(alembic).to have_received(:upgrade).with(database_url: "postgresql://prod", environment: "production")
      expect(ui).to have_received(:parallel).once # only the frontend-independent phase ran
      expect(ui).not_to have_received(:say).with(/Custom domain/)
    end

    it "raises when a non-cloning environment has no database_url" do
      allow(credentials).to receive(:values).and_return(jwt_secret: "j")
      expect { operation.call("production") }
        .to raise_error(GoogleRunDeployer::CredentialsError, /no database_url/)
    end

    it "raises when jwt_secret is absent" do
      allow(credentials).to receive(:values).and_return(database_url: "postgresql://prod")
      expect { operation.call("production") }
        .to raise_error(GoogleRunDeployer::CredentialsError, /jwt_secret/)
    end
  end
end
