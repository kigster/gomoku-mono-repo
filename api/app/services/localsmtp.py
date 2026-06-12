"""Local SMTP email provider (development).

Posts to a local SMTP server — typically a dev "mail catcher" such as Mailpit
or MailHog listening on ``localhost:1025`` — so you can see rendered emails in
a web UI without sending anything to the outside world.

Run one before using this provider, e.g.::

    brew install mailpit && mailpit          # web UI on http://localhost:8025

Host/port/TLS/credentials all come from configuration (``settings.smtp_*``).
"""

from __future__ import annotations

from email.message import EmailMessage as MimeMessage

import aiosmtplib

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
class LocalSmtpProvider(EmailProvider):
    """Deliver via SMTP to a local (or configured) mail server."""

    name = "localsmtp"

    async def send(self, message: EmailMessage) -> None:
        mime = MimeMessage()
        mime["From"] = f"{message.sender_name()} <{message.sender_email()}>"
        mime["To"] = message.to
        mime["Subject"] = message.subject
        mime["Reply-To"] = message.reply_to_email()

        # set_content establishes the text/plain part; add_alternative attaches
        # the HTML so clients negotiate to the richer body. A message with no
        # plaintext still needs a base part, so fall back to a stub.
        mime.set_content(message.text or "This email requires an HTML-capable client.")
        mime.add_alternative(message.html, subtype="html")

        try:
            await aiosmtplib.send(
                mime,
                hostname=settings.smtp_host,
                port=settings.smtp_port,
                use_tls=settings.smtp_use_tls,
                start_tls=settings.smtp_starttls or None,
                username=settings.smtp_username or None,
                password=settings.smtp_password or None,
                validate_certs=settings.smtp_validate_certs,
            )
        except Exception:
            logger.exception(
                "Local SMTP delivery failed: to=%s subject=%r host=%s port=%s "
                "(is a mail catcher running?)",
                message.to,
                message.subject,
                settings.smtp_host,
                settings.smtp_port,
            )
            raise EmailDeliveryError() from None

        logger.info(
            "Email sent via local SMTP: to=%s subject=%r host=%s port=%s",
            message.to,
            message.subject,
            settings.smtp_host,
            settings.smtp_port,
        )
