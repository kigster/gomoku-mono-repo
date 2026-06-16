# frozen_string_literal: true

require "faraday"

module GoogleRunDeployer
  module Adapters
    # Minimal Neon REST client (https://api-docs.neon.tech). Only the handful
    # of endpoints the deployer needs: list/create/delete branches and resolve
    # a pooled connection string.
    #
    # The connection is injectable so specs can pass a stubbed Faraday (or rely
    # on WebMock against the real default connection).
    class Neon
      BASE_URL = "https://console.neon.tech/api/v2/"

      def initialize(api_key:, project_id:, connection: nil)
        @project_id = project_id
        @conn = connection || self.class.build_connection(api_key)
      end

      def self.build_connection(api_key)
        Faraday.new(url: BASE_URL) do |f|
          f.request :json
          f.response :json
          f.headers["Authorization"] = "Bearer #{api_key}"
          f.headers["Accept"] = "application/json"
        end
      end

      # The branch hash for `name`, or nil if absent.
      def find_branch(name)
        body = get("projects/#{@project_id}/branches")
        Array(body["branches"]).find { |branch| branch["name"] == name }
      end

      # Create a branch off `parent_id` with a read-write endpoint. `expires_at`
      # (RFC3339) tells Neon to auto-delete the branch — our 24h cost backstop.
      def create_branch(name:, parent_id:, expires_at: nil)
        branch = { name: name, parent_id: parent_id }
        branch[:expires_at] = expires_at if expires_at
        post("projects/#{@project_id}/branches",
             branch: branch, endpoints: [{ type: "read_write" }])
      end

      def delete_branch(branch_id)
        delete("projects/#{@project_id}/branches/#{branch_id}")
      end

      # Pooled (PgBouncer) DSN for a branch's database+role.
      def connection_uri(branch_id:, database:, role:, pooled: true)
        body = get("projects/#{@project_id}/connection_uri",
                   branch_id: branch_id, database_name: database,
                   role_name: role, pooled: pooled)
        body.fetch("uri") { raise NeonError, "connection_uri response missing 'uri': #{body.inspect}" }
      end

      # Re-clone `name` from `parent_branch`: delete any stale branch of that
      # name, create a fresh copy-on-write clone, and return its pooled DSN.
      def reclone(name:, parent_branch:, database:, role:, expires_at: nil, pooled: true)
        parent = find_branch(parent_branch)
        raise NeonError, "parent branch #{parent_branch.inspect} not found in project #{@project_id}" unless parent

        existing = find_branch(name)
        delete_branch(existing["id"]) if existing

        created = create_branch(name: name, parent_id: parent["id"], expires_at: expires_at)
        branch_id = created.dig("branch", "id")
        raise NeonError, "create-branch response missing branch id: #{created.inspect}" unless branch_id

        connection_uri(branch_id: branch_id, database: database, role: role, pooled: pooled)
      end

      private

      def get(path, params = {})
        handle(@conn.get(path, params))
      end

      def post(path, body)
        handle(@conn.post(path, body))
      end

      def delete(path)
        handle(@conn.delete(path))
      end

      def handle(response)
        return response.body || {} if response.success?

        raise NeonError, "Neon API returned #{response.status}: #{response.body.inspect}"
      end
    end
  end
end
