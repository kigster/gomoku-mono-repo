# frozen_string_literal: true

RSpec.describe GoogleRunDeployer::Operations::Setup do
  let(:ui) { instance_double(GoogleRunDeployer::UI) }
  let(:config) { instance_double(GoogleRunDeployer::Config) }
  let(:terraform) { instance_double(GoogleRunDeployer::Adapters::Terraform, init: nil) }
  let(:one_password) { instance_double(GoogleRunDeployer::Adapters::OnePassword) }
  let(:credentials) do
    instance_double(GoogleRunDeployer::Credentials, config_path: Pathname.new("/c/x.yml.enc"))
  end
  let(:context) do
    instance_double(GoogleRunDeployer::Context, ui: ui, config: config, one_password: one_password)
  end

  subject(:operation) { described_class.new(context) }

  def env(name, clone:)
    neon = clone ? GoogleRunDeployer::NeonConfig.new(branch_name: name, parent_branch: "production") : nil
    GoogleRunDeployer::EnvironmentConfig.new(name: name, project_id: "p", clone_database: clone, neon: neon)
  end

  before do
    %i[banner step success warn say].each { |m| allow(ui).to receive(m) }
    allow(context).to receive(:credentials_for).and_return(credentials)
    allow(context).to receive(:terraform).and_return(terraform)
    allow(config).to receive(:state_prefix_for) { |e| "cr/#{e}" }
  end

  it "warns and re-inits when credentials already exist" do
    allow(config).to receive(:environment).with("staging").and_return(env("staging", clone: true))
    allow(one_password).to receive(:available?).and_return(true)
    allow(credentials).to receive(:exist?).and_return(true)

    operation.call("staging")

    expect(ui).to have_received(:warn).with(/already exist/)
    expect(terraform).to have_received(:init).with(prefix: "cr/staging")
  end

  it "provisions a cloning environment without prompting for a database_url" do
    allow(config).to receive(:environment).with("staging").and_return(env("staging", clone: true))
    allow(one_password).to receive(:available?).and_return(true)
    allow(credentials).to receive(:exist?).and_return(false)
    allow(ui).to receive(:mask).with("Neon API key:").and_return("nk")
    allow(ui).to receive(:ask).with("Neon project id:").and_return("proj")

    captured = nil
    allow(credentials).to receive(:bootstrap!) { |template:| captured = template }

    operation.call("staging")

    expect(captured).to include("neon_api_key: nk", "neon_project_id: proj", "jwt_secret:")
    expect(captured).not_to include("database_url:")
  end

  it "prompts for a database_url for non-cloning envs and warns when op is unavailable" do
    allow(config).to receive(:environment).with("production").and_return(env("production", clone: false))
    allow(one_password).to receive(:available?).and_return(false)
    allow(credentials).to receive(:exist?).and_return(false)
    allow(ui).to receive(:mask).and_return("nk")
    allow(ui).to receive(:ask).with("Neon project id:").and_return("proj")
    allow(ui).to receive(:ask).with("Database URL (Neon pooled DSN):").and_return("postgresql://prod")

    captured = nil
    allow(credentials).to receive(:bootstrap!) { |template:| captured = template }

    operation.call("production")

    expect(captured).to include("database_url: postgresql://prod")
    expect(ui).to have_received(:warn).with(/unavailable/)
  end
end
