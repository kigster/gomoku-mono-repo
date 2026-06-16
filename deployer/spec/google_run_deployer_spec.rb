# frozen_string_literal: true

RSpec.describe GoogleRunDeployer do
  after { described_class.context_builder = nil }

  describe ".repo_root" do
    it "uses DEPLOYER_REPO_ROOT when set" do
      allow(ENV).to receive(:[]).and_call_original
      allow(ENV).to receive(:[]).with("DEPLOYER_REPO_ROOT").and_return("/somewhere")
      expect(described_class.repo_root).to eq("/somewhere")
    end

    it "falls back to the current directory" do
      allow(ENV).to receive(:[]).and_call_original
      allow(ENV).to receive(:[]).with("DEPLOYER_REPO_ROOT").and_return(nil)
      expect(described_class.repo_root).to eq(Dir.pwd)
    end
  end

  describe ".build_context" do
    it "builds a real Context from deployer.yml by default" do
      expect(described_class.build_context).to be_a(GoogleRunDeployer::Context)
    end

    it "honours an injected context builder" do
      described_class.context_builder = -> { :injected }
      expect(described_class.build_context).to eq(:injected)
    end
  end

  it "exposes a version" do
    expect(GoogleRunDeployer::VERSION).to match(/\A\d+\.\d+\.\d+\z/)
  end
end
