"""Translate application HTTPResponseException into FastAPI HTTPException."""

from __future__ import annotations

from fastapi import HTTPException
from fastapi.exception_handlers import http_exception_handler
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

from app.exceptions import HTTPResponseException


class HTTPResponseExceptionMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        try:
            return await call_next(request)
        except HTTPResponseException as exc:
            http_exc = HTTPException(
                status_code=exc.status_code,
                detail=exc.detail,
                headers=exc.headers,
            )
            return await http_exception_handler(request, http_exc)
