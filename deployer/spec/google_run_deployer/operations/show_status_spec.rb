# frozen_string_literal: true

RSpec.describe GoogleRunDeployer::Operations::ShowStatus do
  let(:ui) { instance_double(GoogleRunDeployer::UI, banner: nil, say: nil) }
  let(:config) { instance_double(GoogleRunDeployer::Config) }
  let(:terraform) { instance_double(GoogleRunDeployer::Adapters::Terraform, init: nil) }
  let(:credentials) do
    instance_double(GoogleRunDeployer::Credentials, config_path: Pathname.new("/c/x.yml.enc"))
  end
  let(:context) { instance_double(GoogleRunDeployer::Context, ui: ui, config: config) }

  subject(:operation) { described_class.new(context) }

  before do
    allow(context).to receive(:terraform).and_return(terraform)
    allow(context).to receive(:credentials_for).and_return(credentials)
    allow(config).to receive(:state_prefix_for) { |e| "cr/#{e}" }
    allow(terraform).to receive(:output).with("api_url").and_return("https://api")
    allow(terraform).to receive(:output).with("httpd_url").and_return("https://httpd")
  end

  def env(name, clone:, domain:)
    neon = clone ? GoogleRunDeployer::NeonConfig.new(branch_name: name, parent_branch: "production") : nil
    GoogleRunDeployer::EnvironmentConfig.new(name: name, project_id: "p", region: "us-central1",
                                             custom_domain: domain, clone_database: clone, neon: neon)
  end

  it "prints a cloning environment with present credentials" do
    allow(config).to receive(:environment).with("staging").and_return(env("staging", clone: true, domain: "s.g"))
    allow(credentials).to receive(:exist?).and_return(true)

    operation.call("staging")

    expect(terraform).to have_received(:init).with(prefix: "cr/staging")
    expect(ui).to have_received(:say).with(/Custom domain: s\.g/)
    expect(ui).to have_received(:say).with(/Clones DB:     yes \(Neon staging\)/)
    expect(ui).to have_received(:say).with(/API URL:       https:\/\/api/)
    expect(ui).to have_received(:say).with(/Credentials:   present/)
  end

  it "prints a non-cloning environment with missing credentials and no domain" do
    allow(config).to receive(:environment).with("production").and_return(env("production", clone: false, domain: ""))
    allow(credentials).to receive(:exist?).and_return(false)

    operation.call("production")

    expect(ui).to have_received(:say).with(/Custom domain: \(none\)/)
    expect(ui).to have_received(:say).with(/Clones DB:     no/)
    expect(ui).to have_received(:say).with(/Credentials:   MISSING/)
  end
end
