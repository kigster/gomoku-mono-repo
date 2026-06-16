# frozen_string_literal: true

RSpec.describe GoogleRunDeployer::Adapters::Frontend do
  let(:runner) { instance_double(GoogleRunDeployer::Adapters::CommandRunner) }
  subject(:frontend) { described_class.new(runner: runner, command: %w[just build], dir: "/repo") }

  describe "#build" do
    it "runs the configured command in the configured directory" do
      expect(runner).to receive(:run).with("just", "build", chdir: "/repo")
      frontend.build
    end
  end
end
