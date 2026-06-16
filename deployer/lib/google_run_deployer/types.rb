# frozen_string_literal: true

require "dry-types"
require "dry-struct"

module GoogleRunDeployer
  # Shared dry-types module. `Types::Strict::String` etc. are available to
  # every dry-struct in the gem.
  module Types
    include Dry.Types()
  end
end
