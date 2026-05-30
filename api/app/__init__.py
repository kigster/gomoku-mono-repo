import os
from pathlib import Path

from dotenv import load_dotenv

ENVIRONMENT = os.environ.get("ENVIRONMENT", "development")

load_dotenv()

ENVIRONMENT_FILE = f".env.{ENVIRONMENT}"

if Path(ENVIRONMENT_FILE).is_file():
    load_dotenv(ENVIRONMENT_FILE)

from app.logger import setup  # noqa: E402

setup()
