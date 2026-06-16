# frozen_string_literal: true

RSpec.describe GoogleRunDeployer::Adapters::OnePassword do
  let(:shell) { instance_double(GoogleRunDeployer::Adapters::Shell) }
  subject(:op) { described_class.new(vault: "Private", shell: shell) }

  def result(ok, stdout: "", stderr: "")
    GoogleRunDeployer::Adapters::Shell::Result.new(status: ok ? 0 : 1, stdout: stdout, stderr: stderr)
  end

  describe "#available?" do
    it "is true when `op --version` succeeds" do
      allow(shell).to receive(:call).with(%w[op --version]).and_return(result(true))
      expect(op).to be_available
    end

    it "is false otherwise" do
      allow(shell).to receive(:call).with(%w[op --version]).and_return(result(false))
      expect(op).not_to be_available
    end
  end

  describe "#reference" do
    it "builds an op:// reference" do
      expect(op.reference("k")).to eq("op://Private/k/password")
    end
  end

  describe "#read" do
    it "returns the chomped value on success" do
      allow(shell).to receive(:call)
        .with(["op", "read", "op://Private/k/password"]).and_return(result(true, stdout: "secret\n"))
      expect(op.read("k")).to eq("secret")
    end

    it "returns nil when the item is missing" do
      allow(shell).to receive(:call).and_return(result(false))
      expect(op.read("k")).to be_nil
    end
  end

  describe "#exists?" do
    it "checks via `op item get`" do
      expect(shell).to receive(:call)
        .with(["op", "item", "get", "k", "--vault", "Private"]).and_return(result(true))
      expect(op.exists?("k")).to be(true)
    end
  end

  describe "#write" do
    it "edits an existing item" do
      allow(shell).to receive(:call)
        .with(["op", "item", "get", "k", "--vault", "Private"]).and_return(result(true))
      expect(shell).to receive(:call)
        .with(["op", "item", "edit", "k", "password=v", "--vault", "Private"]).and_return(result(true))
      expect(op.write("k", "v")).to be(true)
    end

    it "creates a new item when absent" do
      allow(shell).to receive(:call)
        .with(["op", "item", "get", "k", "--vault", "Private"]).and_return(result(false))
      expect(shell).to receive(:call)
        .with(["op", "item", "create", "--category", "password", "--title", "k",
               "--vault", "Private", "password=v"]).and_return(result(true))
      expect(op.write("k", "v")).to be(true)
    end

    it "raises OnePasswordError on failure" do
      allow(shell).to receive(:call)
        .with(["op", "item", "get", "k", "--vault", "Private"]).and_return(result(false))
      allow(shell).to receive(:call)
        .with(array_including("create")).and_return(result(false, stderr: "denied"))
      expect { op.write("k", "v") }.to raise_error(GoogleRunDeployer::OnePasswordError, /denied/)
    end
  end
end
