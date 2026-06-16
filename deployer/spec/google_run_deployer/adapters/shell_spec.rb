# frozen_string_literal: true

RSpec.describe GoogleRunDeployer::Adapters::Shell do
  subject(:shell) { described_class.new }

  def status(code)
    instance_double(Process::Status, exitstatus: code)
  end

  describe "#call" do
    it "returns a successful result with captured output" do
      expect(Open3).to receive(:capture3).with({}, "echo", "hi").and_return(["hi\n", "", status(0)])

      result = shell.call(%w[echo hi])

      expect(result.stdout).to eq("hi\n")
      expect(result.stderr).to eq("")
      expect(result).to be_success
    end

    it "reports failure and passes chdir + env through" do
      expect(Open3).to receive(:capture3)
        .with({ "A" => "b" }, "ls", chdir: "/tmp").and_return(["", "nope", status(2)])

      result = shell.call(%w[ls], chdir: "/tmp", env: { "A" => "b" })

      expect(result).not_to be_success
      expect(result.stderr).to eq("nope")
    end
  end
end
