# frozen_string_literal: true

RSpec.describe GoogleRunDeployer::CLI do
  describe ".run" do
    it "dispatches a command and returns 0" do
      expect { expect(described_class.run(["version"])).to eq(0) }
        .to output("#{GoogleRunDeployer::VERSION}\n").to_stdout
    end

    it "renders an operational error in red and returns 1" do
      config = instance_double(GoogleRunDeployer::Config)
      allow(config).to receive(:environment).and_raise(GoogleRunDeployer::ConfigError, "unknown env nope")
      context = instance_double(GoogleRunDeployer::Context, config: config)
      allow(GoogleRunDeployer).to receive(:build_context).and_return(context)

      err = StringIO.new
      code = described_class.run(%w[status nope], err: err, pastel: Pastel.new(enabled: false))

      expect(code).to eq(1)
      expect(err.string).to include("✗ unknown env nope")
    end
  end
end
