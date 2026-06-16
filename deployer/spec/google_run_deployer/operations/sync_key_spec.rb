# frozen_string_literal: true

RSpec.describe GoogleRunDeployer::Operations::SyncKey do
  let(:ui) { instance_double(GoogleRunDeployer::UI, success: nil) }
  let(:one_password) { instance_double(GoogleRunDeployer::Adapters::OnePassword) }
  let(:credentials) { instance_double(GoogleRunDeployer::Credentials, item_title: "g-staging-key") }
  let(:context) { instance_double(GoogleRunDeployer::Context, ui: ui, one_password: one_password) }

  subject(:operation) { described_class.new(context) }

  before { allow(context).to receive(:credentials_for).with("staging").and_return(credentials) }

  describe "#pull" do
    it "reports the key path when materialized locally" do
      allow(credentials).to receive(:ensure_key!).and_return(Pathname.new("/k/staging.key"))
      operation.pull("staging")
      expect(ui).to have_received(:success).with(%r{/k/staging.key})
    end

    it "reports an env-var key when ensure_key! returns nil" do
      allow(credentials).to receive(:ensure_key!).and_return(nil)
      operation.pull("staging")
      expect(ui).to have_received(:success).with(/environment variable/)
    end
  end

  describe "#push" do
    let(:key_path) { instance_double(Pathname) }

    before { allow(credentials).to receive(:key_path).and_return(key_path) }

    it "uploads the local key file to 1Password" do
      allow(key_path).to receive(:file?).and_return(true)
      allow(key_path).to receive(:read).and_return("the-key\n")
      expect(one_password).to receive(:write).with("g-staging-key", "the-key")

      operation.push("staging")
      expect(ui).to have_received(:success).with(/Pushed staging master key/)
    end

    it "raises when there is no local key file" do
      allow(key_path).to receive(:file?).and_return(false)
      expect { operation.push("staging") }.to raise_error(GoogleRunDeployer::CredentialsError, /no local key/)
    end
  end
end
