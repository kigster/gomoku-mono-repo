"""SendGrid email provider (staging / production).

Wraps SendGrid's official Python library
(https://github.com/sendgrid/sendgrid-python). The library is synchronous, so
``send`` offloads the blocking HTTP call to a worker thread to keep the event
loop free.

The API key comes from configuration (``settings.sendgrid_api_key``, populated
from the ``SENDGRID_API_KEY`` env var) — selection is by ``EMAIL_PROVIDER``,
never by hard-coded environment checks.
"""

from __future__ import annotations

import asyncio

from sendgrid import SendGridAPIClient
from sendgrid.helpers.mail import (
    ClickTracking,
    Mail,
    OpenTracking,
    ReplyTo,
    TrackingSettings,
)

from app.config import settings
from app.logger import get_logger
from app.services.email import (
    EmailDeliveryError,
    EmailMessage,
    EmailProvider,
    register_provider,
)

logger = get_logger(__name__)


@register_provider
class SendgridProvider(EmailProvider):
    """Deliver via the SendGrid v3 Mail Send API."""

    name = "sendgrid"

    async def send(self, message: EmailMessage) -> None:
        if not settings.sendgrid_api_key:
            logger.error("email_provider=sendgrid but SENDGRID_API_KEY is unset")
            raise EmailDeliveryError()

        mail = Mail(
            from_email=(message.sender_email(), message.sender_name()),
            to_emails=message.to,
            subject=message.subject,
            plain_text_content=message.text or None,
            html_content=message.html,
        )
        mail.reply_to = ReplyTo(message.reply_to_email(), message.sender_name())

        # Click/open tracking rewrites URLs and injects pixels — that breaks
        # one-time token links and leaks reads. Off for all transactional mail.
        tracking = TrackingSettings()
        tracking.click_tracking = ClickTracking(False, False)
        tracking.open_tracking = OpenTracking(False)
        mail.tracking_settings = tracking

        client = SendGridAPIClient(settings.sendgrid_api_key)
        try:
            response = await asyncio.to_thread(client.send, mail)
        except Exception:
            logger.exception("SendGrid call failed: to=%s subject=%r", message.to, message.subject)
            raise EmailDeliveryError() from None

        if response.status_code >= 300:
            logger.error(
                "SendGrid rejected email: to=%s subject=%r status=%s body=%s",
                message.to,
                message.subject,
                response.status_code,
                response.body,
            )
            raise EmailDeliveryError()

        logger.info(
            "Email sent via SendGrid: to=%s subject=%r status=%s",
            message.to,
            message.subject,
            response.status_code,
        )
