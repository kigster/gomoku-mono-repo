# frozen_string_literal: true

require "tmpdir"

RSpec.describe GoogleRunDeployer::Credentials do
  around do |example|
    Dir.mktmpdir { |dir| @dir = dir; example.run }
  end

  let(:dir) { @dir }
  let(:config_path) { File.join(dir, "staging.yml.enc") }
  let(:key_path) { File.join(dir, "staging.key") }
  let(:one_password) { instance_double(GoogleRunDeployer::Adapters::OnePassword) }

  def credentials
    described_class.new(name: "staging", config_path: config_path, key_path: key_path,
                        item_title: "g-staging-key", one_password: one_password)
  end

  describe "#bootstrap!" do
    it "writes a 0600 key, stores it in 1Password, and encrypts the template" do
      expect(one_password).to receive(:write).with("g-staging-key", anything)

      credentials.bootstrap!(template: "jwt_secret: abc\n")

      expect(File).to exist(config_path)
      expect(format("%o", File.stat(key_path).mode)).to end_with("600")
      expect(File.binread(config_path)).not_to include("abc") # ciphertext on disk
      expect(credentials.values).to eq(jwt_secret: "abc")
    end

    it "refuses to clobber existing credentials" do
      allow(one_password).to receive(:write)
      credentials.bootstrap!(template: "x: 1\n")
      expect { credentials.bootstrap!(template: "y: 2\n") }
        .to raise_error(GoogleRunDeployer::CredentialsError, /already exist/)
    end
  end

  describe "#values / #fetch" do
    before do
      allow(one_password).to receive(:write)
      credentials.bootstrap!(template: "jwt_secret: s3cret\nneon_api_key: nk\n")
    end

    it "fetches a present credential" do
      expect(credentials.fetch(:jwt_secret)).to eq("s3cret")
    end

    it "raises for a missing credential" do
      expect { credentials.fetch(:nope) }.to raise_error(GoogleRunDeployer::CredentialsError, /missing credential/)
    end

    it "raises when the blob is missing entirely" do
      File.delete(config_path)
      expect { credentials.values }.to raise_error(GoogleRunDeployer::CredentialsError, /missing/)
    end

    it "raises on a wrong master key" do
      File.write(key_path, ActiveSupport::EncryptedFile.generate_key) # rotate to a bad key
      expect { credentials.values }.to raise_error(GoogleRunDeployer::CredentialsError, /could not decrypt/)
    end
  end

  describe "#ensure_key!" do
    it "returns the path when the key file already exists" do
      File.write(key_path, "k")
      expect(credentials.ensure_key!).to eq(Pathname.new(key_path))
    end

    it "returns nil when the key comes from the env var" do
      allow(ENV).to receive(:[]).and_call_original
      allow(ENV).to receive(:[]).with("STAGING_MASTER_KEY").and_return("envkey")
      expect(credentials.ensure_key!).to be_nil
    end

    it "pulls the key from 1Password and writes it locally" do
      allow(one_password).to receive(:read).with("g-staging-key").and_return("pulled-key")
      path = credentials.ensure_key!
      expect(File.read(path)).to eq("pulled-key")
    end

    it "raises when the key is nowhere to be found" do
      allow(one_password).to receive(:read).and_return(nil)
      expect { credentials.ensure_key! }.to raise_error(GoogleRunDeployer::CredentialsError, /no master key/)
    end
  end

  describe "#edit" do
    before do
      allow(one_password).to receive(:write)
      credentials.bootstrap!(template: "a: 1\n")
    end

    it "decrypts to a tempfile, runs the editor, and re-encrypts" do
      editor = ->(path) { File.write(path, "#{File.read(path)}b: 2\n") }
      credentials.edit(editor: editor)
      expect(credentials.values).to eq(a: 1, b: 2)
    end

    it "raises when the blob does not exist yet" do
      File.delete(config_path)
      expect { credentials.edit(editor: ->(_) {}) }
        .to raise_error(GoogleRunDeployer::CredentialsError, /run `cloud setup/)
    end
  end
end
