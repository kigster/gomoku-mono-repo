# frozen_string_literal: true

RSpec.describe GoogleRunDeployer::Adapters::Terraform do
  let(:runner) { instance_double(GoogleRunDeployer::Adapters::CommandRunner) }
  subject(:tf) { described_class.new(runner: runner, dir: "/stack", state_bucket: "bkt") }

  describe "#init" do
    it "re-inits with the backend bucket + prefix" do
      expect(runner).to receive(:run).with(
        "terraform", "init", "-reconfigure", "-upgrade",
        "-backend-config=bucket=bkt", "-backend-config=prefix=cloud-run/staging",
        chdir: "/stack"
      )
      tf.init(prefix: "cloud-run/staging")
    end
  end

  describe "#apply" do
    it "passes vars as flags and secrets as TF_VAR_* env, scoped to targets" do
      expect(runner).to receive(:run).with(
        "terraform", "apply", "-auto-approve",
        "-target=a", "-var=region=us", "-var=environment=staging",
        chdir: "/stack", env: { "TF_VAR_jwt_secret" => "s3cret" }
      )
      tf.apply(vars: { "region" => "us", "environment" => "staging" },
               secrets: { "jwt_secret" => "s3cret" }, targets: %w[a])
    end

    it "defaults to no targets and no secrets" do
      expect(runner).to receive(:run).with(
        "terraform", "apply", "-auto-approve", "-var=x=1", chdir: "/stack", env: {}
      )
      tf.apply(vars: { "x" => "1" })
    end
  end

  describe "#output" do
    it "returns the stripped raw output" do
      expect(runner).to receive(:run!)
        .with("terraform", "output", "-raw", "api_url", chdir: "/stack")
        .and_return(instance_double(TTY::Command::Result, out: "https://x\n"))
      expect(tf.output("api_url")).to eq("https://x")
    end
  end
end
