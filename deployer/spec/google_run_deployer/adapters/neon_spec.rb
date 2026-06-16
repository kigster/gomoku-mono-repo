# frozen_string_literal: true

RSpec.describe GoogleRunDeployer::Adapters::Neon do
  let(:base) { "https://console.neon.tech/api/v2" }
  subject(:neon) { described_class.new(api_key: "nk_test", project_id: "proj") }

  def json(body)
    { status: 200, body: body.to_json, headers: { "Content-Type" => "application/json" } }
  end

  def stub_branches(list)
    stub_request(:get, "#{base}/projects/proj/branches").to_return(json(branches: list))
  end

  describe "#find_branch" do
    it "returns the matching branch" do
      stub_branches([{ id: "p1", name: "production" }, { id: "s1", name: "staging" }])
      expect(neon.find_branch("staging")).to include("id" => "s1")
    end

    it "returns nil when absent" do
      stub_branches([])
      expect(neon.find_branch("staging")).to be_nil
    end

    it "raises NeonError on a non-2xx response" do
      stub_request(:get, "#{base}/projects/proj/branches").to_return(status: 500, body: "boom")
      expect { neon.find_branch("x") }.to raise_error(GoogleRunDeployer::NeonError, /500/)
    end
  end

  describe "#reclone" do
    before do
      stub_branches([{ id: "p1", name: "production" }, { id: "s1", name: "staging" }])
    end

    it "deletes the stale branch, creates a fresh one, and returns the DSN" do
      delete = stub_request(:delete, "#{base}/projects/proj/branches/s1").to_return(json({}))
      create = stub_request(:post, "#{base}/projects/proj/branches").to_return(json(branch: { id: "s2" }))
      stub_request(:get, "#{base}/projects/proj/connection_uri")
        .with(query: hash_including("branch_id" => "s2", "pooled" => "true"))
        .to_return(json(uri: "postgresql://fresh/db"))

      dsn = neon.reclone(name: "staging", parent_branch: "production",
                         database: "gomoku", role: "owner", expires_at: "2026-06-16T00:00:00Z")

      expect(dsn).to eq("postgresql://fresh/db")
      expect(delete).to have_been_requested
      expect(create).to have_been_requested
    end

    it "skips deletion when no branch of that name exists" do
      stub_branches([{ id: "p1", name: "production" }])
      stub_request(:post, "#{base}/projects/proj/branches").to_return(json(branch: { id: "s9" }))
      stub_request(:get, "#{base}/projects/proj/connection_uri")
        .with(query: hash_including({})).to_return(json(uri: "postgresql://new"))

      expect(neon.reclone(name: "staging", parent_branch: "production",
                          database: "db", role: "r")).to eq("postgresql://new")
    end

    it "raises when the parent branch is missing" do
      stub_branches([{ id: "s1", name: "staging" }])
      expect do
        neon.reclone(name: "staging", parent_branch: "production", database: "db", role: "r")
      end.to raise_error(GoogleRunDeployer::NeonError, /parent branch/)
    end

    it "raises when the create response has no branch id" do
      stub_request(:delete, "#{base}/projects/proj/branches/s1").to_return(json({}))
      stub_request(:post, "#{base}/projects/proj/branches").to_return(json(branch: {}))
      expect do
        neon.reclone(name: "staging", parent_branch: "production", database: "db", role: "r")
      end.to raise_error(GoogleRunDeployer::NeonError, /branch id/)
    end
  end

  describe "#connection_uri" do
    it "raises when the response lacks a uri" do
      stub_request(:get, "#{base}/projects/proj/connection_uri")
        .with(query: hash_including({})).to_return(json({}))
      expect do
        neon.connection_uri(branch_id: "b", database: "d", role: "r")
      end.to raise_error(GoogleRunDeployer::NeonError, /missing 'uri'/)
    end
  end
end
