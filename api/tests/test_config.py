"""Tests for Settings.database_dsn property branches.

Each test constructs Settings with ALL fields it depends on overridden
explicitly. The .env.test file Pydantic loads at construction time would
otherwise leak in (e.g. `DB_NAME=gomoku_test`) and turn a fixture into a
moving target.
"""

from app.config import Settings


class TestDatabaseDsn:
    def test_returns_database_url_when_set(self):
        s = Settings(database_url="postgresql://u@h/db")
        assert s.database_dsn == "postgresql://u@h/db"

    def test_builds_dsn_with_socket(self):
        s = Settings(
            database_url="",
            db_name="gomoku",
            db_socket="/cloudsql/project:region:instance",
        )
        assert s.database_dsn == (
            "postgresql://postgres@/gomoku?host=/cloudsql/project:region:instance"
        )

    def test_builds_dsn_with_socket_and_password(self):
        s = Settings(
            database_url="",
            db_name="gomoku",
            db_socket="/tmp",
            db_password="secret",
        )
        assert s.database_dsn == "postgresql://postgres:secret@/gomoku?host=/tmp"

    def test_builds_dsn_localhost_fallback(self):
        s = Settings(
            database_url="",
            db_user="app",
            db_name="mydb",
            postgresql_port=5432,
        )
        assert s.database_dsn == "postgresql://app@localhost:5432/mydb"

    def test_builds_dsn_localhost_with_password(self):
        s = Settings(
            database_url="",
            db_user="app",
            db_password="pw",
            db_name="mydb",
            postgresql_port=5432,
        )
        assert s.database_dsn == "postgresql://app:pw@localhost:5432/mydb"

    def test_builds_dsn_uses_postgresql_port_override(self):
        """POSTGRESQL_PORT is the single knob for the local Postgres port."""
        s = Settings(
            database_url="",
            db_user="app",
            db_name="mydb",
            postgresql_port=5433,
        )
        assert s.database_dsn == "postgresql://app@localhost:5433/mydb"
