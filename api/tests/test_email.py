"""Tests for the transactional email service.

The SendGrid path is exercised with a mocked httpx transport so we can assert
the payload shape without making a network call. The stdout path is verified
not to crash and to log/print the URL so it remains usable in development.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx
import pytest

from app.config import settings
from app.services import email as email_service

# --- fixtures ---------------------------------------------------------------


@pytest.fixture
def sendgrid_env(monkeypatch):
    """Common SendGrid-mode settings with a known domain and From identity."""
    monkeypatch.setattr(settings, "email_provider", "sendgrid")
    monkeypatch.setattr(settings, "sendgrid_api_key", "SG.test-key")
    monkeypatch.setattr(settings, "email_from", "gomoku@email.gomoku.games")
    monkeypatch.setattr(settings, "email_from_name", "Gomoku Support")
    monkeypatch.setattr(settings, "public_domain", "app.gomoku.games")


@pytest.fixture
def sendgrid_mock(monkeypatch):
    """Install a MockTransport into httpx.AsyncClient and return a capture dict.

    The handler can be overridden per-test by reassigning ``state['handler']``.
    By default, returns ``202 Accepted`` (SendGrid's success status) and records
    the request URL, Authorization header, and parsed JSON body.
    """
    state: dict[str, Any] = {"requests": []}

    def default_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(202, json={})

    state["handler"] = default_handler

    def dispatch(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        state["requests"].append(
            {
                "url": str(request.url),
                "auth": request.headers.get("authorization"),
                "body": body,
            }
        )
        return state["handler"](request)

    transport = httpx.MockTransport(dispatch)
    real_async_client = httpx.AsyncClient

    def _client_with_mock(*args, **kwargs):
        kwargs["transport"] = transport
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr(email_service.httpx, "AsyncClient", _client_with_mock)
    return state


# --- stdout provider --------------------------------------------------------


@pytest.mark.asyncio
async def test_stdout_provider_prints_and_logs_url(monkeypatch, capsys, caplog):
    monkeypatch.setattr(settings, "email_provider", "stdout")
    monkeypatch.setattr(settings, "public_domain", "app.gomoku.games")

    with caplog.at_level(logging.INFO, logger="app.services.email"):
        await email_service.send_password_reset_email("user@example.com", "tok-abc")

    out = capsys.readouterr().out
    assert "PASSWORD RESET EMAIL" in out
    assert "To: user@example.com" in out
    assert "https://app.gomoku.games/reset-password?token=tok-abc" in out
    assert any("tok-abc" in r.getMessage() for r in caplog.records)


@pytest.mark.asyncio
async def test_stdout_provider_makes_no_http_call(monkeypatch, sendgrid_mock):
    """Even with the mock transport installed, stdout mode must not hit HTTP."""
    monkeypatch.setattr(settings, "email_provider", "stdout")

    await email_service.send_password_reset_email("user@example.com", "tok")

    assert sendgrid_mock["requests"] == []


# --- SendGrid: happy path ---------------------------------------------------


@pytest.mark.asyncio
async def test_sendgrid_calls_correct_endpoint_with_auth(sendgrid_env, sendgrid_mock):
    await email_service.send_password_reset_email("dest@example.com", "tok-xyz")

    assert len(sendgrid_mock["requests"]) == 1
    req = sendgrid_mock["requests"][0]
    assert req["url"] == "https://api.sendgrid.com/v3/mail/send"
    assert req["auth"] == "Bearer SG.test-key"


@pytest.mark.asyncio
async def test_sendgrid_from_identity_is_gomoku_support(sendgrid_env, sendgrid_mock):
    await email_service.send_password_reset_email("dest@example.com", "tok")

    body = sendgrid_mock["requests"][0]["body"]
    assert body["from"] == {
        "email": "gomoku@email.gomoku.games",
        "name": "Gomoku Support",
    }
    assert body["reply_to"] == {
        "email": "gomoku@email.gomoku.games",
        "name": "Gomoku Support",
    }


@pytest.mark.asyncio
async def test_sendgrid_recipient_and_subject(sendgrid_env, sendgrid_mock):
    await email_service.send_password_reset_email("dest@example.com", "tok")

    body = sendgrid_mock["requests"][0]["body"]
    assert body["personalizations"][0]["to"] == [{"email": "dest@example.com"}]
    assert body["subject"] == "Reset your Gomoku password"


@pytest.mark.asyncio
async def test_sendgrid_has_text_and_html_parts(sendgrid_env, sendgrid_mock):
    await email_service.send_password_reset_email("dest@example.com", "tok-xyz")

    body = sendgrid_mock["requests"][0]["body"]
    parts = {part["type"]: part["value"] for part in body["content"]}
    assert set(parts) == {"text/plain", "text/html"}
    assert parts["text/plain"].strip(), "plain-text part is empty"
    assert parts["text/html"].lstrip().startswith("<!doctype html>")


@pytest.mark.asyncio
async def test_sendgrid_link_present_in_both_parts(sendgrid_env, sendgrid_mock):
    await email_service.send_password_reset_email("dest@example.com", "tok-xyz")

    expected = "https://app.gomoku.games/reset-password?token=tok-xyz"
    parts = sendgrid_mock["requests"][0]["body"]["content"]
    for part in parts:
        assert expected in part["value"], f"reset URL missing from {part['type']}"


@pytest.mark.asyncio
async def test_sendgrid_html_includes_branding_and_expiry(sendgrid_env, sendgrid_mock):
    await email_service.send_password_reset_email("dest@example.com", "tok")

    body = sendgrid_mock["requests"][0]["body"]
    html = next(p["value"] for p in body["content"] if p["type"] == "text/html")
    assert "Reset password" in html
    assert "Gomoku" in html
    assert "1 hour" in html
    assert "app.gomoku.games" in html


@pytest.mark.asyncio
async def test_sendgrid_html_has_no_unrendered_placeholders(sendgrid_env, sendgrid_mock):
    """Guard against f-string placeholders leaking into the rendered HTML."""
    await email_service.send_password_reset_email("dest@example.com", "tok")

    html = next(
        p["value"]
        for p in sendgrid_mock["requests"][0]["body"]["content"]
        if p["type"] == "text/html"
    )
    # Curly braces appear only as escaped {{ }} sequences or not at all.
    assert "{reset_url}" not in html
    assert "{logo}" not in html
    assert "{site}" not in html


@pytest.mark.asyncio
async def test_sendgrid_disables_click_and_open_tracking(sendgrid_env, sendgrid_mock):
    """Tracking pixels and URL rewriting break the one-time token semantics."""
    await email_service.send_password_reset_email("dest@example.com", "tok")

    body = sendgrid_mock["requests"][0]["body"]
    tracking = body["tracking_settings"]
    assert tracking["click_tracking"]["enable"] is False
    assert tracking["open_tracking"]["enable"] is False


@pytest.mark.asyncio
async def test_sendgrid_uses_custom_domain_override(sendgrid_env, sendgrid_mock, monkeypatch):
    """If public_domain is overridden, the reset link follows."""
    monkeypatch.setattr(settings, "public_domain", "dev.gomoku.games")

    await email_service.send_password_reset_email("dest@example.com", "tok-1")

    parts = sendgrid_mock["requests"][0]["body"]["content"]
    expected = "https://dev.gomoku.games/reset-password?token=tok-1"
    for part in parts:
        assert expected in part["value"]


# --- SendGrid: error paths --------------------------------------------------


@pytest.mark.asyncio
async def test_sendgrid_raises_on_unauthorized(sendgrid_env, sendgrid_mock):
    sendgrid_mock["handler"] = lambda req: httpx.Response(
        401, text='{"errors":[{"message":"bad key"}]}'
    )

    with pytest.raises(RuntimeError, match="401"):
        await email_service.send_password_reset_email("dest@example.com", "tok")


@pytest.mark.asyncio
async def test_sendgrid_raises_on_server_error(sendgrid_env, sendgrid_mock):
    sendgrid_mock["handler"] = lambda req: httpx.Response(503, text="upstream down")

    with pytest.raises(RuntimeError, match="503"):
        await email_service.send_password_reset_email("dest@example.com", "tok")


@pytest.mark.asyncio
async def test_sendgrid_accepts_200_as_success(sendgrid_env, sendgrid_mock):
    """SendGrid normally returns 202, but 200 is also valid — both are <300."""
    sendgrid_mock["handler"] = lambda req: httpx.Response(200, json={})

    await email_service.send_password_reset_email("dest@example.com", "tok")


@pytest.mark.asyncio
async def test_sendgrid_propagates_network_error(sendgrid_env, monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("dns failure", request=request)

    transport = httpx.MockTransport(handler)
    real_async_client = httpx.AsyncClient

    def _client_with_mock(*args, **kwargs):
        kwargs["transport"] = transport
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr(email_service.httpx, "AsyncClient", _client_with_mock)

    with pytest.raises(httpx.ConnectError):
        await email_service.send_password_reset_email("dest@example.com", "tok")


# --- configuration guards ---------------------------------------------------


@pytest.mark.asyncio
async def test_sendgrid_requires_api_key(monkeypatch):
    monkeypatch.setattr(settings, "email_provider", "sendgrid")
    monkeypatch.setattr(settings, "sendgrid_api_key", "")

    with pytest.raises(RuntimeError, match="SENDGRID_API_KEY"):
        await email_service.send_password_reset_email("dest@example.com", "tok")


@pytest.mark.asyncio
async def test_unknown_provider_raises(monkeypatch):
    monkeypatch.setattr(settings, "email_provider", "smoke-signals")

    with pytest.raises(RuntimeError, match="Unknown email_provider"):
        await email_service.send_password_reset_email("dest@example.com", "tok")


# --- direct template renderers ----------------------------------------------


def test_text_template_is_plain_ascii(monkeypatch):
    """Plain-text bodies should render cleanly in any client."""
    monkeypatch.setattr(settings, "public_domain", "app.gomoku.games")

    text = email_service._password_reset_text("https://app.gomoku.games/reset-password?token=t")
    assert text.startswith("Hi,")
    assert "1 hour" in text
    assert "ignore this email" in text
    # No leftover format placeholders.
    assert "{" not in text and "}" not in text


def test_html_template_includes_logo_and_link(monkeypatch):
    monkeypatch.setattr(settings, "public_domain", "app.gomoku.games")

    html = email_service._password_reset_html("https://app.gomoku.games/reset-password?token=t")
    assert "<!doctype html>" in html
    assert "android-chrome-192x192.png" in html
    assert "https://app.gomoku.games/reset-password?token=t" in html
    assert "Reset password" in html
