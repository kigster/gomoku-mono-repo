"""Application-level exception primitives.

Routes raise these typed exceptions; middleware translates them to FastAPI
HTTPException so response rendering stays centralized.
"""

from __future__ import annotations

from typing import Any


class ApplicationException(Exception):
    """Top-level application exception type."""


class HTTPResponseException(ApplicationException):
    """Application exception carrying HTTP response metadata."""

    def __init__(
        self,
        status_code: int,
        detail: Any,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(str(detail))
        self.status_code = status_code
        self.detail = detail
        self.headers = headers
