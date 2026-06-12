"""In-memory email provider (tests).

Captures every message into the module-level :data:`OUTBOX` instead of sending
it — the equivalent of Rails' ``delivery_method = :test`` and
``ActionMailer::Base.deliveries``. Hermetic: no network, no SMTP server, safe
under pytest-xdist.

Tests assert against :data:`OUTBOX`; the ``clear_outbox`` autouse fixture in
``conftest.py`` resets it between tests.
"""

from __future__ import annotations

from app.logger import get_logger
from app.services.email import EmailMessage, EmailProvider, register_provider

logger = get_logger(__name__)

# Captured messages, newest last. Imported by tests for assertions.
OUTBOX: list[EmailMessage] = []


@register_provider
class MemoryProvider(EmailProvider):
    """Append delivered messages to :data:`OUTBOX`."""

    name = "memory"

    async def send(self, message: EmailMessage) -> None:
        OUTBOX.append(message)
        logger.info(
            "Email captured (memory provider): to=%s subject=%r",
            message.to,
            message.subject,
        )
