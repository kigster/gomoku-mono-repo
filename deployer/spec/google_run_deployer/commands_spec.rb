# frozen_string_literal: true

RSpec.describe GoogleRunDeployer::Commands do
  let(:context) { instance_double(GoogleRunDeployer::Context) }

  before { allow(GoogleRunDeployer).to receive(:build_context).and_return(context) }

  def expect_delegates(command_class, operation_class, method: :call)
    operation = instance_double(operation_class)
    expect(operation_class).to receive(:new).with(context).and_return(operation)
    expect(operation).to receive(method).with("staging")
    command_class.new.call(environment: "staging")
  end

  it "setup → Operations::Setup#call" do
    expect_delegates(described_class::Setup, GoogleRunDeployer::Operations::Setup)
  end

  it "deploy → Operations::Deploy#call" do
    expect_delegates(described_class::Deploy, GoogleRunDeployer::Operations::Deploy)
  end

  it "status → Operations::ShowStatus#call" do
    expect_delegates(described_class::Status, GoogleRunDeployer::Operations::ShowStatus)
  end

  it "credentials edit → Operations::EditCredentials#call" do
    expect_delegates(described_class::CredentialsEdit, GoogleRunDeployer::Operations::EditCredentials)
  end

  it "key pull → Operations::SyncKey#pull" do
    expect_delegates(described_class::KeyPull, GoogleRunDeployer::Operations::SyncKey, method: :pull)
  end

  it "key push → Operations::SyncKey#push" do
    expect_delegates(described_class::KeyPush, GoogleRunDeployer::Operations::SyncKey, method: :push)
  end

  it "clone → resolves the env then Operations::CloneDatabase#call" do
    env = double("env")
    config = instance_double(GoogleRunDeployer::Config)
    ui = instance_double(GoogleRunDeployer::UI, success: nil)
    allow(config).to receive(:environment).with("staging").and_return(env)
    allow(context).to receive(:config).and_return(config)
    allow(context).to receive(:ui).and_return(ui)
    operation = instance_double(GoogleRunDeployer::Operations::CloneDatabase)
    expect(GoogleRunDeployer::Operations::CloneDatabase).to receive(:new).with(context).and_return(operation)
    expect(operation).to receive(:call).with(env)

    described_class::Clone.new.call(environment: "staging")
    expect(ui).to have_received(:success).with(/Re-cloned staging/)
  end

  it "version → prints the gem version" do
    expect { described_class::Version.new.call }.to output("#{GoogleRunDeployer::VERSION}\n").to_stdout
  end
end
