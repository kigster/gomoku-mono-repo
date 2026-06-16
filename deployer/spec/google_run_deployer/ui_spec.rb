# frozen_string_literal: true

RSpec.describe GoogleRunDeployer::UI do
  let(:output) { StringIO.new }
  let(:prompt) { instance_double(TTY::Prompt) }

  # A spinner that records nothing but answers the lifecycle calls.
  let(:fake_spinner) { Class.new { def auto_spin; end; def success(*); end; def error(*); end }.new }

  # A multi-spinner that runs each registered block synchronously on auto_spin.
  let(:fake_multi) do
    Class.new do
      def initialize(spinner) = (@spinner = spinner; @blocks = [])
      def register(_label, &block) = @blocks << block
      def auto_spin = @blocks.each { |b| b.call(@spinner) }
    end.new(fake_spinner)
  end

  let(:fake_bar) { Class.new { def initialize = (@n = 0); def advance = (@n += 1); attr_reader :n }.new }

  subject(:ui) do
    described_class.new(
      output: output, prompt: prompt, pastel: Pastel.new(enabled: false),
      spinner_multi: ->(_title) { fake_multi },
      spinner: ->(_label) { fake_spinner },
      progress: ->(_label, _total) { fake_bar }
    )
  end

  describe "plain output" do
    it "writes say/step/success/warn/error/banner to output" do
      ui.say("hi"); ui.step("go"); ui.success("ok"); ui.warn("careful"); ui.error("bad"); ui.banner("Title")
      text = output.string
      expect(text).to include("hi", "==> go", "✓ ok", "! careful", "✗ bad", "Title")
    end
  end

  describe "prompts" do
    it "delegates ask/mask/yes? to the prompt" do
      expect(prompt).to receive(:ask).with("q?", default: "d").and_return("a")
      expect(prompt).to receive(:mask).with("secret?").and_return("s")
      expect(prompt).to receive(:yes?).with("ok?").and_return(true)

      expect(ui.ask("q?", default: "d")).to eq("a")
      expect(ui.mask("secret?")).to eq("s")
      expect(ui.yes?("ok?")).to be(true)
    end
  end

  describe "#spin" do
    it "returns the block result on success" do
      expect(ui.spin("work") { 42 }).to eq(42)
    end

    it "re-raises and marks failure on error" do
      expect(fake_spinner).to receive(:error)
      expect { ui.spin("work") { raise "boom" } }.to raise_error("boom")
    end
  end

  describe "#parallel" do
    it "runs every job and returns their values keyed by label" do
      results = ui.parallel("build", { "a" => -> { 1 }, "b" => -> { 2 } })
      expect(results).to eq("a" => 1, "b" => 2)
    end

    it "re-raises the first job error after all jobs run" do
      expect { ui.parallel("build", { "a" => -> { raise "kaboom" } }) }.to raise_error("kaboom")
    end
  end

  describe "#progress" do
    it "advances the bar once per item and returns mapped values" do
      result = ui.progress("steps", [1, 2, 3]) { |i| i * 10 }
      expect(result).to eq([10, 20, 30])
      expect(fake_bar.n).to eq(3)
    end
  end

  describe "default construction" do
    it "builds real TTY collaborators without raising" do
      expect { described_class.new(output: StringIO.new) }.not_to raise_error
    end
  end
end
