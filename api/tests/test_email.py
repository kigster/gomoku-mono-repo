"""Tests for the transactional email service.

Three layers are exercised:
  * the provider abstraction + registry (``email.py``),
  * each concrete backend (``memory``/``sendgrid``/``localsmtp``) with its
    transport mocked so no network or SMTP server is needed,
  * the password-reset content (``email_password_reset.py``).
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.config import settings
from app.services import email_password_reset as pwreset
from app.services import localsmtp, memory, resend, sendgrid
from app.services.email import (
    EmailDeliveryError,
    EmailMessage,
    get_email_provider,
    send_email,
)

# --- EmailMessage value object ----------------------------------------------


def test_message_sender_falls_back_to_settings(monkeypatch):
    monkeypatch.setattr(settings, "email_from", "gomoku@email.gomoku.games")
    monkeypatch.setattr(settings, "email_from_name", "Gomoku Support")

    msg = EmailMessage(to="a@b.com", subject="Hi", html="<p>hi</p>")
    assert msg.sender_email() == "gomoku@email.gomoku.games"
    assert msg.sender_name() == "Gomoku Support"
    # reply_to defaults to the sender when unset.
    assert msg.reply_to_email() == "gomoku@email.gomoku.games"


def test_message_explicit_overrides_win():
    msg = EmailMessage(
        to="a@b.com",
        subject="Hi",
        html="<p>hi</p>",
        from_email="noreply@x.com",
        from_name="X",
        reply_to="support@x.com",
    )
    assert msg.sender_email() == "noreply@x.com"
    assert msg.sender_name() == "X"
    assert msg.reply_to_email() == "support@x.com"


# --- EmailMessage validation (Pydantic) -------------------------------------


@pytest.mark.parametrize("bad_to", ["not-an-email", "no-domain@", "", "a@@b.com"])
def test_message_rejects_invalid_recipient(bad_to):
    with pytest.raises(ValidationError):
        EmailMessage(to=bad_to, subject="Hi", html="<p>hi</p>")


@pytest.mark.parametrize("field", ["from_email", "reply_to"])
def test_message_rejects_invalid_optional_address(field):
    with pytest.raises(ValidationError):
        EmailMessage(**{"to": "a@b.com", "subject": "Hi", "html": "<p>hi</p>", field: "nope"})


def test_message_rejects_empty_subject():
    with pytest.raises(ValidationError):
        EmailMessage(to="a@b.com", subject="", html="<p>hi</p>")


def test_message_rejects_overlong_subject():
    with pytest.raises(ValidationError):
        EmailMessage(to="a@b.com", subject="x" * 256, html="<p>hi</p>")


def test_message_rejects_empty_html():
    with pytest.raises(ValidationError):
        EmailMessage(to="a@b.com", subject="Hi", html="")


def test_message_rejects_unknown_field():
    with pytest.raises(ValidationError):
        EmailMessage(**{"to": "a@b.com", "subject": "Hi", "html": "<p>hi</p>", "bcc": "x@y.com"})


def test_message_is_frozen():
    msg = EmailMessage(to="a@b.com", subject="Hi", html="<p>hi</p>")
    with pytest.raises(ValidationError):
        msg.subject = "changed"


def test_message_text_is_optional():
    msg = EmailMessage(to="a@b.com", subject="Hi", html="<p>hi</p>")
    assert msg.text is None


# --- provider registry / factory --------------------------------------------


@pytest.mark.parametrize(
    ("name", "cls"),
    [
        ("memory", memory.MemoryProvider),
        ("sendgrid", sendgrid.SendgridProvider),
        ("resend", resend.ResendProvider),
        ("localsmtp", localsmtp.LocalSmtpProvider),
    ],
)
def test_factory_resolves_each_provider(name, cls):
    assert isinstance(get_email_provider(name), cls)


def test_factory_uses_configured_provider(monkeypatch):
    monkeypatch.setattr(settings, "email_provider", "memory")
    assert isinstance(get_email_provider(), memory.MemoryProvider)


def test_factory_unknown_provider_raises():
    with pytest.raises(EmailDeliveryError):
        get_email_provider("smoke-signals")


# --- memory provider --------------------------------------------------------


@pytest.mark.asyncio
async def test_memory_provider_captures_message(monkeypatch):
    monkeypatch.setattr(settings, "email_provider", "memory")
    msg = EmailMessage(to="dest@example.com", subject="Subj", html="<p>x</p>", text="x")

    await send_email(msg)

    assert memory.OUTBOX == [msg]


# --- sendgrid provider (mocked client) --------------------------------------


@pytest.fixture
def sendgrid_env(monkeypatch):
    monkeypatch.setattr(settings, "email_provider", "sendgrid")
    monkeypatch.setattr(settings, "sendgrid_api_key", "SG.test-key")
    monkeypatch.setattr(settings, "email_from", "gomoku@email.gomoku.games")
    monkeypatch.setattr(settings, "email_from_name", "Gomoku Support")


@pytest.fixture
def sendgrid_capture(monkeypatch):
    """Patch SendGridAPIClient; capture the Mail payload, control the response."""

    class _Resp:
        def __init__(self, status_code: int) -> None:
            self.status_code = status_code
            self.body = b""

    state: dict = {"payload": None, "status": 202, "raise": None, "api_key": None}

    class _FakeClient:
        def __init__(self, api_key: str) -> None:
            state["api_key"] = api_key

        def send(self, mail):
            if state["raise"] is not None:
                raise state["raise"]
            state["payload"] = mail.get()
            return _Resp(state["status"])

    monkeypatch.setattr(sendgrid, "SendGridAPIClient", _FakeClient)
    return state


@pytest.mark.asyncio
async def test_sendgrid_builds_expected_payload(sendgrid_env, sendgrid_capture):
    await send_email(
        EmailMessage(
            to="dest@example.com",
            subject="Reset your Gomoku password",
            html="<!doctype html><p>hi</p>",
            text="hi",
        )
    )

    assert sendgrid_capture["api_key"] == "SG.test-key"
    payload = sendgrid_capture["payload"]
    assert payload["from"] == {"email": "gomoku@email.gomoku.games", "name": "Gomoku Support"}
    assert payload["reply_to"] == {"email": "gomoku@email.gomoku.games", "name": "Gomoku Support"}
    assert payload["personalizations"][0]["to"] == [{"email": "dest@example.com"}]
    assert payload["subject"] == "Reset your Gomoku password"
    parts = {p["type"]: p["value"] for p in payload["content"]}
    assert parts["text/plain"] == "hi"
    assert parts["text/html"] == "<!doctype html><p>hi</p>"


@pytest.mark.asyncio
async def test_sendgrid_disables_tracking(sendgrid_env, sendgrid_capture):
    await send_email(EmailMessage(to="d@e.com", subject="s", html="<p>h</p>", text="h"))

    tracking = sendgrid_capture["payload"]["tracking_settings"]
    assert tracking["click_tracking"]["enable"] is False
    assert tracking["open_tracking"]["enable"] is False


@pytest.mark.asyncio
async def test_sendgrid_raises_on_non_2xx(sendgrid_env, sendgrid_capture):
    sendgrid_capture["status"] = 401
    with pytest.raises(EmailDeliveryError):
        await send_email(EmailMessage(to="d@e.com", subject="s", html="<p>h</p>"))


@pytest.mark.asyncio
async def test_sendgrid_raises_on_transport_error(sendgrid_env, sendgrid_capture):
    sendgrid_capture["raise"] = RuntimeError("dns failure")
    with pytest.raises(EmailDeliveryError):
        await send_email(EmailMessage(to="d@e.com", subject="s", html="<p>h</p>"))


@pytest.mark.asyncio
async def test_sendgrid_requires_api_key(monkeypatch):
    monkeypatch.setattr(settings, "email_provider", "sendgrid")
    monkeypatch.setattr(settings, "sendgrid_api_key", "")
    with pytest.raises(EmailDeliveryError):
        await send_email(EmailMessage(to="d@e.com", subject="s", html="<p>h</p>"))


# --- resend provider (mocked SDK) -------------------------------------------


@pytest.fixture
def resend_env(monkeypatch):
    monkeypatch.setattr(settings, "email_provider", "resend")
    monkeypatch.setattr(settings, "resend_api_key", "re_test-key")
    monkeypatch.setattr(settings, "email_from", "gomoku@email.gomoku.games")
    monkeypatch.setattr(settings, "email_from_name", "Gomoku Support")


@pytest.fixture
def resend_capture(monkeypatch):
    """Patch resend.Emails.send; capture the params dict, control the result."""
    state: dict = {"params": None, "raise": None}

    def _fake_send(params):
        if state["raise"] is not None:
            raise state["raise"]
        state["params"] = params
        return {"id": "email-123"}

    monkeypatch.setattr(resend.resend.Emails, "send", _fake_send)
    return state


@pytest.mark.asyncio
async def test_resend_builds_expected_params(resend_env, resend_capture):
    await send_email(
        EmailMessage(
            to="dest@example.com",
            subject="Reset your Gomoku password",
            html="<!doctype html><p>hi</p>",
            text="hi",
        )
    )

    # The SDK reads its key from a module global; the provider sets it per call.
    assert resend.resend.api_key == "re_test-key"
    params = resend_capture["params"]
    assert params["from"] == "Gomoku Support <gomoku@email.gomoku.games>"
    assert params["to"] == ["dest@example.com"]
    assert params["subject"] == "Reset your Gomoku password"
    assert params["html"] == "<!doctype html><p>hi</p>"
    assert params["text"] == "hi"
    assert params["reply_to"] == "Gomoku Support <gomoku@email.gomoku.games>"


@pytest.mark.asyncio
async def test_resend_omits_text_when_absent(resend_env, resend_capture):
    await send_email(EmailMessage(to="d@e.com", subject="s", html="<p>h</p>"))

    assert "text" not in resend_capture["params"]


@pytest.mark.asyncio
async def test_resend_raises_on_sdk_error(resend_env, resend_capture):
    resend_capture["raise"] = RuntimeError("resend 422")
    with pytest.raises(EmailDeliveryError):
        await send_email(EmailMessage(to="d@e.com", subject="s", html="<p>h</p>"))


@pytest.mark.asyncio
async def test_resend_requires_api_key(monkeypatch):
    monkeypatch.setattr(settings, "email_provider", "resend")
    monkeypatch.setattr(settings, "resend_api_key", "")
    with pytest.raises(EmailDeliveryError):
        await send_email(EmailMessage(to="d@e.com", subject="s", html="<p>h</p>"))


# --- localsmtp provider (mocked aiosmtplib) ---------------------------------


@pytest.fixture
def smtp_capture(monkeypatch):
    state: dict = {"message": None, "kwargs": None, "raise": None}

    async def _fake_send(message, **kwargs):
        if state["raise"] is not None:
            raise state["raise"]
        state["message"] = message
        state["kwargs"] = kwargs
        return {}

    monkeypatch.setattr(localsmtp.aiosmtplib, "send", _fake_send)
    return state


@pytest.mark.asyncio
async def test_localsmtp_builds_multipart_message(monkeypatch, smtp_capture):
    monkeypatch.setattr(settings, "email_provider", "localsmtp")
    monkeypatch.setattr(settings, "email_from", "gomoku@email.gomoku.games")
    monkeypatch.setattr(settings, "email_from_name", "Gomoku Support")
    monkeypatch.setattr(settings, "smtp_host", "localhost")
    monkeypatch.setattr(settings, "smtp_port", 1025)

    await send_email(
        EmailMessage(to="dest@example.com", subject="Subj", html="<p>hi</p>", text="hi")
    )

    mime = smtp_capture["message"]
    assert mime["To"] == "dest@example.com"
    assert mime["Subject"] == "Subj"
    assert mime["From"] == "Gomoku Support <gomoku@email.gomoku.games>"
    assert mime["Reply-To"] == "gomoku@email.gomoku.games"
    body = mime.get_body(preferencelist=("html",)).get_content()
    assert "<p>hi</p>" in body
    assert smtp_capture["kwargs"]["hostname"] == "localhost"
    assert smtp_capture["kwargs"]["port"] == 1025


@pytest.mark.asyncio
async def test_localsmtp_raises_on_connection_failure(monkeypatch, smtp_capture):
    monkeypatch.setattr(settings, "email_provider", "localsmtp")
    smtp_capture["raise"] = ConnectionRefusedError("no catcher")
    with pytest.raises(EmailDeliveryError):
        await send_email(EmailMessage(to="d@e.com", subject="s", html="<p>h</p>"))


# --- password reset: content + dispatch -------------------------------------


@pytest.mark.asyncio
async def test_password_reset_dispatches_via_memory(monkeypatch):
    monkeypatch.setattr(settings, "email_provider", "memory")
    monkeypatch.setattr(settings, "public_domain", "app.gomoku.games")

    await pwreset.send_password_reset_email("user@example.com", "tok-abc")

    assert len(memory.OUTBOX) == 1
    msg = memory.OUTBOX[0]
    assert msg.to == "user@example.com"
    assert msg.subject == "Reset your Gomoku password"
    expected = "https://app.gomoku.games/reset-password?token=tok-abc"
    assert msg.text is not None
    assert expected in msg.html
    assert expected in msg.text


@pytest.mark.asyncio
async def test_password_reset_follows_domain_override(monkeypatch):
    monkeypatch.setattr(settings, "email_provider", "memory")
    monkeypatch.setattr(settings, "public_domain", "dev.gomoku.games")

    await pwreset.send_password_reset_email("user@example.com", "tok-1")

    msg = memory.OUTBOX[0]
    expected = "https://dev.gomoku.games/reset-password?token=tok-1"
    assert msg.text is not None
    assert expected in msg.html
    assert expected in msg.text


def test_password_reset_text_is_plain(monkeypatch):
    monkeypatch.setattr(settings, "public_domain", "app.gomoku.games")
    text = pwreset.password_reset_text("https://app.gomoku.games/reset-password?token=t")
    assert text.startswith("Hi,")
    assert "1 hour" in text
    assert "ignore this email" in text
    assert "{" not in text and "}" not in text


def test_password_reset_html_includes_logo_and_link(monkeypatch):
    monkeypatch.setattr(settings, "public_domain", "app.gomoku.games")
    html = pwreset.password_reset_html("https://app.gomoku.games/reset-password?token=t")
    assert "<!doctype html>" in html
    assert "android-chrome-192x192.png" in html
    assert "https://app.gomoku.games/reset-password?token=t" in html
    assert "Reset password" in html
    # No leftover f-string placeholders leaked into the render.
    assert "{reset_url}" not in html and "{logo}" not in html
