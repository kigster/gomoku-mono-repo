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

    # Database
    db_socket: str = ""
    db_name: str = "gomoku"
    db_user: str = "postgres"
    db_password: str = ""
    database_url: str = ""

    # Upstream game engine
    gomoku_httpd_url: str = "http://localhost:10000"

    # JWT
    jwt_secret: str = "change-me-in-production"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 7 * 1440  # 1 week

    # CORS
    cors_origins: list[str] = ["*"]

    # Email
    email_provider: str = "stdout"  # stdout | sendgrid
    email_from: str = "gomoku@email.gomoku.games"
    email_from_name: str = "Gomoku Support"
    sendgrid_api_key: str = ""

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
        return f"postgresql://{self.db_user}{password_part}@localhost/{self.db_name}"

    model_config = SettingsConfigDict(
        env_prefix="",
        env_file=_env_files() or None,
        extra="ignore",
    )


settings = Settings()
