"""Settings for the application.

Environment selection (Vite/Next-style layering):

  ENVIRONMENT=development  →  .env.development  +  .env.development.local
  ENVIRONMENT=test         →  .env.test         +  .env.test.local
  ENVIRONMENT=ci           →  .env.ci           +  .env.ci.local
  ENVIRONMENT=production   →  (no file; Cloud Run env vars are authoritative)

The ``.local`` overlay is optional and gitignored — that's where you put
personal overrides like a Neon DSN to debug a prod issue from a dev shell.
Process-level env vars always win over files.
"""

import os
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

API_DIR = Path(__file__).resolve().parent.parent

ENVIRONMENT = os.getenv("ENVIRONMENT", "development")


def _env_files() -> tuple[Path, ...]:
    """Files to feed into Pydantic, in load-order (later files override earlier)."""
    if ENVIRONMENT == "production":
        return ()
    candidates = (
        API_DIR / f".env.{ENVIRONMENT}",
        API_DIR / f".env.{ENVIRONMENT}.local",
    )
    return tuple(p for p in candidates if p.is_file())


class Settings(BaseSettings):
    """Settings for the application."""

    environment: Literal["development", "production", "test", "ci"] = "development"

    # Public Domain. `custom_domain` (env: CUSTOM_DOMAIN) is an explicit
    # override used when the deployed domain differs from the default —
    # e.g. local dev hosts pointed at dev.gomoku.games via /etc/hosts.
    public_domain: str = "app.gomoku.games"
    custom_domain: str | None = None

    @property
    def effective_domain(self) -> str:
        return self.custom_domain or self.public_domain

    # Database. `postgresql_port` is the single knob the local toolchain
    # turns when the workstation's Postgres listens on a non-standard port
    # (Homebrew's postgresql@18 ships on 5433). Exported by the root
    # .envrc with the same default. Only consulted when `database_url`
    # is empty and we're falling back to building a localhost DSN.
    db_socket: str = ""
    db_name: str = "gomoku"
    db_user: str = "postgres"
    db_password: str = ""
    database_url: str = ""
    postgresql_port: int = 5433

    # Upstream game engine
    gomoku_httpd_url: str = "http://localhost:10000"

    # JWT
    jwt_secret: str = "change-me-in-production"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 7 * 1440  # 1 week

    # CORS
    cors_origins: list[str] = ["*"]

    # Email. `email_provider` is the single switch — no environment branching:
    #   localsmtp → dev (posts to a local mail catcher, see smtp_* below)
    #   sendgrid  → staging/production (needs sendgrid_api_key)
    #   memory    → tests (captured in app.services.memory.OUTBOX)
    # Override EMAIL_PROVIDER in any .env overlay to send via SendGrid from a
    # dev shell (also set SENDGRID_API_KEY).
    email_provider: str = "localsmtp"
    email_from: str = "gomoku@email.gomoku.games"
    email_from_name: str = "Gomoku Support"
    sendgrid_api_key: str = ""
    resend_api_key: str = ""

    # Local SMTP (email_provider=localsmtp). Defaults target the Mailpit/MailHog
    # convention (localhost:1025, no auth, no TLS).
    smtp_host: str = "localhost"
    smtp_port: int = 1025
    # TLS mode is mutually exclusive: `smtp_use_tls` is implicit TLS (the whole
    # connection is wrapped — Proton Mail Bridge in SSL mode, submission/465);
    # `smtp_starttls` upgrades a plaintext connection. Leave both False for a
    # plain catcher like Mailpit/MailHog on 1025.
    smtp_use_tls: bool = False
    smtp_starttls: bool = False
    smtp_username: str = ""
    smtp_password: str = ""
    # Local bridges/catchers (Proton Mail Bridge, Mailpit over TLS) present a
    # self-signed cert; set False to skip verification on the localhost hop.
    smtp_validate_certs: bool = True

    # LogFire
    logfire_token: str | None = None

    # LLMs
    openai_api_token: str | None = None
    anthropic_api_token: str | None = None

    @property
    def database_dsn(self) -> str:
        if self.database_url:
            return self.database_url
        password_part = f":{self.db_password}" if self.db_password else ""
        if self.db_socket:
            return (
                f"postgresql://{self.db_user}{password_part}@/{self.db_name}?host={self.db_socket}"
            )
        return (
            f"postgresql://{self.db_user}{password_part}"
            f"@localhost:{self.postgresql_port}/{self.db_name}"
        )

    model_config = SettingsConfigDict(
        env_prefix="",
        env_file=_env_files() or None,
        extra="ignore",
    )


settings = Settings()
