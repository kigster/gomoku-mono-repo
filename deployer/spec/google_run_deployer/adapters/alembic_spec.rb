# frozen_string_literal: true

RSpec.describe GoogleRunDeployer::Adapters::Alembic do
  let(:runner) { instance_double(GoogleRunDeployer::Adapters::CommandRunner) }
  subject(:alembic) do
    described_class.new(runner: runner, command: ["uv", "run", "alembic", "upgrade", "head"], dir: "/api")
  end

  describe "#upgrade" do
    it "runs the migrator with DATABASE_URL and ENVIRONMENT in the env" do
      expect(runner).to receive(:run).with(
        "uv", "run", "alembic", "upgrade", "head",
        chdir: "/api", env: { "DATABASE_URL" => "postgres://x", "ENVIRONMENT" => "staging" }
      )
      alembic.upgrade(database_url: "postgres://x", environment: "staging")
    end
  end
end
