"""Resend email provider (staging / production).

Wraps Resend's official Python library
(https://github.com/resend/resend-python). The library is synchronous, so
``send`` offloads the blocking HTTP call to a worker thread to keep the event
loop free — same approach as the SendGrid backend.

The API key comes from configuration (``settings.resend_api_key``, populated
from the ``RESEND_API_KEY`` env var) — selection is by ``EMAIL_PROVIDER``,
never by hard-coded environment checks.

Note on tracking: Resend has no per-message open/click tracking toggle the way
SendGrid does. Tracking is configured per *domain* in the Resend dashboard (or
via the Domains API) and defaults to off. Keep it off for the sending domain so
one-time token links aren't rewritten and reads aren't leaked — there is
nothing to set here at send time.
"""

from __future__ import annotations

import asyncio
from typing import Any, cast

import resend

from app.config import settings
from app.logger import get_logger
from app.services.email import (
    EmailDeliveryError,
    EmailMessage,
    EmailProvider,
    register_provider,
)

logger = get_logger(__name__)


def _format_address(email: str, name: str | None) -> str:
    """Render an address as Resend expects it: ``Name <email>`` or bare email."""
    return f"{name} <{email}>" if name else email


@register_provider
class ResendProvider(EmailProvider):
    """Deliver via the Resend Emails API."""

    name = "resend"

    async def send(self, message: EmailMessage) -> None:
        if not settings.resend_api_key:
            logger.error("email_provider=resend but RESEND_API_KEY is unset")
            raise EmailDeliveryError()

        params: dict[str, Any] = {
            "from": _format_address(message.sender_email(), message.sender_name()),
            "to": [message.to],
            "subject": message.subject,
            "html": message.html,
            "reply_to": _format_address(message.reply_to_email(), message.sender_name()),
        }
        # Omit the plaintext key entirely when there is no text part, rather
        # than sending an empty string (mirrors SendGrid's ``text or None``).
        if message.text:
            params["text"] = message.text

        try:
            response = await asyncio.to_thread(self._send_sync, params)
        except Exception:
            logger.exception("Resend call failed: to=%s subject=%r", message.to, message.subject)
            raise EmailDeliveryError() from None

        # The SDK raises on any non-2xx, so reaching here means the message was
        # accepted. Pull the id defensively — the SDK has returned both plain
        # dicts and typed objects across versions.
        email_id = (
            response.get("id") if isinstance(response, dict) else getattr(response, "id", None)
        )
        logger.info(
            "Email sent via Resend: to=%s subject=%r id=%s",
            message.to,
            message.subject,
            email_id,
        )

    @staticmethod
    def _send_sync(params: dict[str, Any]) -> Any:
        # ``api_key`` is a module-level global in the Resend SDK. It's a
        # constant here, so assigning it per call is idempotent and safe even
        # under concurrent worker threads.
        resend.api_key = settings.resend_api_key
        return resend.Emails.send(cast(resend.Emails.SendParams, params))
