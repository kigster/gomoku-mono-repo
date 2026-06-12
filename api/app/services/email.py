"""Transactional email — provider abstraction.

``email.py`` defines the *interface* (``EmailProvider``), the value object
that flows through it (``EmailMessage``), and a string-keyed registry so the
delivery backend is chosen purely by configuration — ``settings.email_provider``
— with no environment branching anywhere in the code path.

Concrete backends live alongside this module and self-register on import:

  * ``localsmtp`` — :class:`app.services.localsmtp.LocalSmtpProvider`
    (development; posts to a local SMTP catcher like Mailpit/MailHog).
  * ``sendgrid``  — :class:`app.services.sendgrid.SendgridProvider`
    (staging/production; SendGrid v3 via the official library).
  * ``resend``    — :class:`app.services.resend.ResendProvider`
    (staging/production; a cheaper drop-in alternative to SendGrid).
  * ``memory``    — :class:`app.services.memory.MemoryProvider`
    (tests; captures into an in-process outbox, à la Rails' ``:test``).

Adding a backend is ~40 lines: a module with an ``EmailProvider`` subclass
decorated with ``@register_provider``, plus one line in the import block at the
bottom of this file. See ``resend.py`` for the worked example.

To swap backends — even to send real mail from a dev shell — set
``EMAIL_PROVIDER`` (and, for SendGrid, ``SENDGRID_API_KEY``) in the
environment or a ``.env.*`` overlay. Nothing else changes.

Message *content* (subjects, HTML/plaintext bodies) does NOT live here — see
``email_password_reset.py`` for the first concrete email and the pattern to
follow for the next one.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import ClassVar

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from app.config import settings
from app.exceptions import HTTPResponseException
from app.logger import get_logger

logger = get_logger(__name__)

EMAIL_DELIVERY_ERROR_MESSAGE = (
    "We are sorry, but our email subsystem is returning an error attempting "
    "to deliver the email. The issue has been propagated to our engineering "
    "team, and should be addressed within 24-48 hours. We apologize for the "
    "inconvenience."
)


class EmailDeliveryError(HTTPResponseException):
    """Email could not be delivered; rendered to the user as a 502.

    The user-facing ``detail`` defaults to a generic apology; the technical
    cause is logged by the provider, never leaked to the response body.
    """

    def __init__(self, detail: str = EMAIL_DELIVERY_ERROR_MESSAGE) -> None:
        super().__init__(status_code=502, detail=detail)


class EmailMessage(BaseModel):
    """A single outbound email, independent of the delivery backend.

    Validated at construction: ``to``/``from_email``/``reply_to`` must be
    syntactically valid addresses (``EmailStr``), and ``subject``/``html`` must
    be non-empty — a provider should never be handed an unaddressed or empty
    message. ``from_email``/``from_name`` fall back to the configured sender
    identity so callers only override them for the rare off-brand email.
    ``text`` is the plaintext alternative — omit it only if there genuinely
    isn't one (every real email should have both parts for deliverability).

    Frozen: a message is an immutable value once built.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    to: EmailStr
    subject: str = Field(min_length=1, max_length=255)
    html: str = Field(min_length=1)
    text: str | None = None
    from_email: EmailStr | None = None
    from_name: str | None = None
    reply_to: EmailStr | None = None

    def sender_email(self) -> str:
        return self.from_email or settings.email_from

    def sender_name(self) -> str:
        return self.from_name or settings.email_from_name

    def reply_to_email(self) -> str:
        return self.reply_to or self.sender_email()


class EmailProvider(ABC):
    """A delivery backend. Subclasses set ``name`` and implement ``send``.

    Implementations raise :class:`EmailDeliveryError` on failure so callers get
    a uniform 502 regardless of which backend is configured.
    """

    name: ClassVar[str]

    @abstractmethod
    async def send(self, message: EmailMessage) -> None:
        """Deliver ``message`` or raise :class:`EmailDeliveryError`."""


_PROVIDERS: dict[str, type[EmailProvider]] = {}


def register_provider(cls: type[EmailProvider]) -> type[EmailProvider]:
    """Class decorator: add a provider to the registry under its ``name``."""
    _PROVIDERS[cls.name] = cls
    return cls


def get_email_provider(name: str | None = None) -> EmailProvider:
    """Resolve the configured provider (or an explicit ``name``).

    Raises :class:`EmailDeliveryError` if the configured name is unknown — a
    misconfiguration surfaces loudly rather than silently dropping mail.
    """
    name = name or settings.email_provider
    try:
        provider_cls = _PROVIDERS[name]
    except KeyError:
        logger.error(
            "Unknown email_provider %r; known providers: %s",
            name,
            sorted(_PROVIDERS),
        )
        raise EmailDeliveryError(
            f"Unknown email_provider {name!r}. Known: {sorted(_PROVIDERS)}"
        ) from None
    return provider_cls()


async def send_email(message: EmailMessage) -> None:
    """Deliver ``message`` via the configured provider."""
    await get_email_provider().send(message)


# Import the concrete backends so their @register_provider decorators run.
# Placed at the bottom (after the registry + base class are defined) to avoid
# a circular import: each provider module imports from this one.
from app.services import localsmtp as _localsmtp  # noqa: E402,F401
from app.services import memory as _memory  # noqa: E402,F401
from app.services import resend as _resend  # noqa: E402,F401
from app.services import sendgrid as _sendgrid  # noqa: E402,F401
