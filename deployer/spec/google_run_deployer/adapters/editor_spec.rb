# frozen_string_literal: true

RSpec.describe GoogleRunDeployer::Adapters::Editor do
  describe "#open" do
    it "splits $EDITOR and invokes it with the path" do
      sys = ->(*args) { @args = args; true }
      editor = described_class.new(env: { "EDITOR" => "code -w" }, system: sys)

      editor.open("/tmp/x")

      expect(@args).to eq(["code", "-w", "/tmp/x"])
    end

    it "falls back to VISUAL then vi" do
      sys = ->(*args) { @args = args; true }
      described_class.new(env: { "VISUAL" => "nano" }, system: sys).open("/tmp/y")
      expect(@args.first).to eq("nano")

      described_class.new(env: {}, system: sys).open("/tmp/z")
      expect(@args.first).to eq("vi")
    end

    it "raises when the editor exits non-zero" do
      editor = described_class.new(env: { "EDITOR" => "vi" }, system: ->(*) { false })
      expect { editor.open("/tmp/x") }.to raise_error(GoogleRunDeployer::CredentialsError, /non-zero/)
    end
  end
end
