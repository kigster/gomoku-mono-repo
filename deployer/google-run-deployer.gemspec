# frozen_string_literal: true

require_relative "lib/google_run_deployer/version"

Gem::Specification.new do |spec|
  spec.name    = "google-run-deployer"
  spec.version = GoogleRunDeployer::VERSION
  spec.authors = ["Konstantin Gredeskoul"]
  spec.email   = ["kigster@gmail.com"]

  spec.summary     = "Opinionated Cloud Run + Neon deployer with Rails-style encrypted credentials."
  spec.description  = <<~DESC
    google-run-deployer is a small, config-driven CLI for promoting a service
    through ephemeral and production environments on Google Cloud Run. It clones
    a Neon Postgres branch per deploy, decrypts per-environment secrets using the
    same machinery as `rails credentials:edit` (ActiveSupport::EncryptedConfiguration),
    keeps master keys in 1Password, and drives Terraform/Docker builds with a
    multi-spinner TUI.
  DESC
  spec.homepage = "https://github.com/kigster/google-run-deployer"
  spec.license  = "MIT"

  spec.required_ruby_version = ">= 3.3"

  spec.metadata["homepage_uri"]    = spec.homepage
  spec.metadata["source_code_uri"] = spec.homepage
  spec.metadata["rubygems_mfa_required"] = "true"

  spec.files = Dir.glob("{lib,exe,config}/**/*", File::FNM_DOTMATCH).select { |f| File.file?(f) } +
               %w[README.md google-run-deployer.gemspec]
  spec.bindir      = "exe"
  spec.executables = ["cloud"]
  spec.require_paths = ["lib"]

  # CLI + functional core
  spec.add_dependency "dry-cli", "~> 1.0"
  spec.add_dependency "dry-monads", "~> 1.6"
  spec.add_dependency "dry-struct", "~> 1.6"
  spec.add_dependency "dry-types", "~> 1.7"

  # Secrets — the real Rails credentials class.
  spec.add_dependency "activesupport", ">= 7.0"

  # HTTP (Neon API)
  spec.add_dependency "faraday", "~> 2.0"

  # TUI
  spec.add_dependency "pastel", "~> 0.8"
  spec.add_dependency "tty-box", "~> 0.7"
  spec.add_dependency "tty-command", "~> 0.10"
  spec.add_dependency "tty-progressbar", "~> 0.18"
  spec.add_dependency "tty-prompt", "~> 0.23"
  spec.add_dependency "tty-spinner", "~> 0.9"
end
