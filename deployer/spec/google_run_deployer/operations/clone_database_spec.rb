# frozen_string_literal: true

RSpec.describe GoogleRunDeployer::Operations::CloneDatabase do
  let(:ui) { instance_double(GoogleRunDeployer::UI) }
  let(:neon) { instance_double(GoogleRunDeployer::Adapters::Neon) }
  let(:credentials) { instance_double(GoogleRunDeployer::Credentials) }
  let(:context) { instance_double(GoogleRunDeployer::Context, ui: ui) }
  let(:frozen) { Time.utc(2026, 6, 15) }

  def env(clone: true)
    neon_cfg = GoogleRunDeployer::NeonConfig.new(
      branch_name: "staging", parent_branch: "production",
      expires_in_hours: 24, database: "g", role: "owner", pooled: true
    )
    GoogleRunDeployer::EnvironmentConfig.new(
      name: "staging", project_id: "p", clone_database: clone, neon: (clone ? neon_cfg : nil)
    )
  end

  subject(:operation) { described_class.new(context) }

  before do
    allow(ui).to receive(:spin) { |_label, &block| block.call }
    allow(context).to receive(:now).and_return(frozen)
    allow(context).to receive(:neon).with(credentials).and_return(neon)
  end

  it "reclones from the parent and returns the fresh DSN" do
    expected_expiry = (frozen + (24 * 3600)).utc.iso8601
    expect(neon).to receive(:reclone).with(
      name: "staging", parent_branch: "production", database: "g", role: "owner",
      expires_at: expected_expiry, pooled: true
    ).and_return("postgresql://fresh")

    expect(operation.call(env, credentials: credentials)).to eq("postgresql://fresh")
  end

  it "builds credentials when the caller doesn't supply them" do
    allow(context).to receive(:credentials_for).with("staging").and_return(credentials)
    allow(neon).to receive(:reclone).and_return("postgresql://x")

    expect(operation.call(env)).to eq("postgresql://x")
  end

  it "refuses to clone an environment not configured for it" do
    expect { operation.call(env(clone: false)) }
      .to raise_error(GoogleRunDeployer::ConfigError, /not configured to clone/)
  end
end
