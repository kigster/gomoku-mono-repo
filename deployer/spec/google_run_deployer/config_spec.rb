# frozen_string_literal: true

require "tmpdir"

RSpec.describe GoogleRunDeployer::Config do
  let(:raw) do
    {
      credentials_dir: "creds",
      artifact_repo: "repo",
      terraform: { dir: "tf", state_bucket: "bkt", state_prefix: "cr/%{environment}/g" },
      onepassword: { vault: "Private", item_template: "g-%{environment}-key" },
      migrate: { command: %w[uv run alembic upgrade head], dir: "api" },
      frontend: { command: %w[just build], dir: "." },
      services: [
        { name: "httpd", context: "c", tf_image_var: "httpd_image" },
        { name: "api", context: "api", tf_image_var: "api_image", needs_frontend: true }
      ],
      environments: {
        production: { project_id: "p", custom_domain: "g.us" },
        staging: {
          project_id: "p", custom_domain: "s.g", clone_database: true,
          neon: { branch_name: "staging", parent_branch: "production", expires_in_hours: 12, database: "g", role: "owner" }
        }
      }
    }
  end

  subject(:config) { described_class.from_hash(raw, "/repo") }

  describe ".from_hash" do
    its(:credentials_dir) { is_expected.to eq("creds") }
    its(:artifact_repo) { is_expected.to eq("repo") }
    its(:terraform_dir) { is_expected.to eq("tf") }
    its(:tf_state_bucket) { is_expected.to eq("bkt") }
    its(:migrate_command) { is_expected.to eq(%w[uv run alembic upgrade head]) }

    it "parses services and the frontend block" do
      expect(config.services.map(&:name)).to eq(%w[httpd api])
      expect(config.services.last.needs_frontend).to be(true)
      expect(config.frontend.command).to eq(%w[just build])
    end

    it "applies defaults when optional sections are omitted" do
      minimal = {
        terraform: { state_bucket: "b" },
        services: [{ name: "x", context: ".", tf_image_var: "x_image" }],
        environments: { staging: { project_id: "p" } }
      }
      cfg = described_class.from_hash(minimal, "/r")
      expect(cfg.terraform_dir).to eq("iac/cloud_run")
      expect(cfg.tf_state_prefix).to eq("cloud-run/%{environment}")
      expect(cfg.op_vault).to eq("Private")
      expect(cfg.migrate_command).to eq(%w[true])
      expect(cfg.frontend).to be_nil
    end

    it "raises when there are no environments" do
      expect { described_class.from_hash({ terraform: { state_bucket: "b" }, services: [] }, "/r") }
        .to raise_error(GoogleRunDeployer::ConfigError, /no environments/)
    end

    it "raises when state_bucket is missing" do
      expect { described_class.from_hash({ environments: { s: { project_id: "p" } }, services: [] }, "/r") }
        .to raise_error(GoogleRunDeployer::ConfigError, /state_bucket/)
    end

    it "raises when an environment lacks project_id" do
      expect { described_class.from_hash({ terraform: { state_bucket: "b" }, services: [], environments: { s: {} } }, "/r") }
        .to raise_error(GoogleRunDeployer::ConfigError, /project_id/)
    end

    it "wraps dry-struct validation errors" do
      bad = raw.merge(services: [{ name: "x", context: ".", tf_image_var: 123 }])
      expect { described_class.from_hash(bad, "/r") }.to raise_error(GoogleRunDeployer::ConfigError, /invalid/)
    end
  end

  describe "#environment" do
    it "returns a known environment" do
      expect(config.environment("staging").custom_domain).to eq("s.g")
    end

    it "raises listing valid names for an unknown one" do
      expect { config.environment("nope") }
        .to raise_error(GoogleRunDeployer::ConfigError, /known: production, staging/)
    end
  end

  describe "helpers" do
    it "computes paths, state prefix, and op item" do
      expect(config.path("a/b").to_s).to eq("/repo/a/b")
      expect(config.state_prefix_for("staging")).to eq("cr/staging/g")
      expect(config.op_item_for("staging")).to eq("g-staging-key")
    end
  end

  describe "EnvironmentConfig#clones?" do
    it "is true only when clone_database and a neon block are present" do
      expect(config.environment("staging").clones?).to be(true)
      expect(config.environment("production").clones?).to be(false)
    end
  end

  describe ".from_file" do
    it "loads YAML from an explicit path" do
      Dir.mktmpdir do |dir|
        file = File.join(dir, "deployer.yml")
        File.write(file, YAML.dump(JSON.parse(JSON.generate(raw))))
        cfg = described_class.from_file(path: file, repo_root: dir)
        expect(cfg.environments.keys).to contain_exactly("production", "staging")
      end
    end

    it "resolves via $DEPLOYER_CONFIG" do
      Dir.mktmpdir do |dir|
        file = File.join(dir, "custom.yml")
        File.write(file, YAML.dump(JSON.parse(JSON.generate(raw))))
        expect(ENV).to receive(:[]).with("DEPLOYER_CONFIG").at_least(:once).and_return(file)
        allow(ENV).to receive(:[]).and_call_original
        cfg = described_class.from_file(repo_root: dir)
        expect(cfg.tf_state_bucket).to eq("bkt")
      end
    end

    it "raises when the file is absent" do
      expect { described_class.from_file(path: "/no/such.yml", repo_root: "/r") }
        .to raise_error(GoogleRunDeployer::ConfigError, /not found/)
    end

    it "raises on invalid YAML" do
      Dir.mktmpdir do |dir|
        file = File.join(dir, "deployer.yml")
        File.write(file, "key: : :\n  - bad")
        expect { described_class.from_file(path: file, repo_root: dir) }
          .to raise_error(GoogleRunDeployer::ConfigError, /not valid YAML/)
      end
    end

    it "raises when the file is empty" do
      Dir.mktmpdir do |dir|
        file = File.join(dir, "deployer.yml")
        File.write(file, "")
        expect { described_class.from_file(path: file, repo_root: dir) }
          .to raise_error(GoogleRunDeployer::ConfigError, /empty/)
      end
    end

    it "defaults to <repo_root>/deployer/config/deployer.yml" do
      Dir.mktmpdir do |dir|
        FileUtils.mkdir_p(File.join(dir, "deployer/config"))
        file = File.join(dir, "deployer/config/deployer.yml")
        File.write(file, YAML.dump(JSON.parse(JSON.generate(raw))))
        cfg = described_class.from_file(repo_root: dir)
        expect(cfg.artifact_repo).to eq("repo")
      end
    end
  end
end
