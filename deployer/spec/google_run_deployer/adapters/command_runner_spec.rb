# frozen_string_literal: true

RSpec.describe GoogleRunDeployer::Adapters::CommandRunner do
  let(:command) { instance_double(TTY::Command) }
  subject(:runner) { described_class.new(command: command) }

  describe "#run" do
    it "delegates to TTY::Command and returns the result" do
      expect(command).to receive(:run).with("echo", "hi", chdir: nil, env: {}).and_return(:result)

      expect(runner.run("echo", "hi")).to eq(:result)
    end

    it "forwards chdir and env" do
      expect(command).to receive(:run).with("t", chdir: "/d", env: { "X" => "1" })

      runner.run("t", chdir: "/d", env: { "X" => "1" })
    end

    it "translates a non-zero exit into CommandError" do
      allow(command).to receive(:run).and_raise(TTY::Command::ExitError.allocate)

      expect { runner.run("boom") }.to raise_error(GoogleRunDeployer::CommandError)
    end
  end

  describe "#run!" do
    it "delegates without raising" do
      expect(command).to receive(:run!).with("t", chdir: nil, env: {}).and_return(:soft)

      expect(runner.run!("t")).to eq(:soft)
    end
  end

  describe "default construction" do
    it "builds its own TTY::Command" do
      expect(described_class.new(printer: :null, output: StringIO.new)).to be_a(described_class)
    end
  end
end
