# frozen_string_literal: true

RSpec.describe GoogleRunDeployer::Operations::EditCredentials do
  let(:ui) { instance_double(GoogleRunDeployer::UI, step: nil, success: nil) }
  let(:credentials) { instance_double(GoogleRunDeployer::Credentials) }
  let(:editor) { instance_double(GoogleRunDeployer::Adapters::Editor) }
  let(:context) do
    instance_double(GoogleRunDeployer::Context, ui: ui, editor: editor)
  end

  subject(:operation) { described_class.new(context) }

  it "opens the credentials in the editor and confirms the save" do
    allow(context).to receive(:credentials_for).with("staging").and_return(credentials)
    expect(credentials).to receive(:edit).with(editor: instance_of(Method))

    operation.call("staging")

    expect(ui).to have_received(:step).with(/Editing staging/)
    expect(ui).to have_received(:success).with(/Saved staging/)
  end
end
