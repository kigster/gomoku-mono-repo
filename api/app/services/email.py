"""Transactional email service.

Currently only the password-reset email is implemented. Two backends are
supported: ``stdout`` (dev: writes the link to logs/console so you can copy it
into a browser) and ``sendgrid`` (production: posts to SendGrid v3).

The HTML and plaintext bodies are built here as plain Python strings — no
template engine. If we add a second email, factor the layout into a shared
``_render_layout(...)`` helper before reaching for Jinja.
"""

from __future__ import annotations

import httpx

from app.config import settings
from app.logger import get_logger

logger = get_logger(__name__)

SENDGRID_ENDPOINT = "https://api.sendgrid.com/v3/mail/send"
RESET_LINK_TTL_HUMAN = "1 hour"


def _reset_url(token: str) -> str:
    return f"https://{settings.public_domain}/reset-password?token={token}"


def _logo_url() -> str:
    return f"https://{settings.public_domain}/assets/android-chrome-192x192.png"


def _password_reset_text(reset_url: str) -> str:
    return (
        "Hi,\n\n"
        "Someone (hopefully you) asked to reset the password on your Gomoku\n"
        "account. To choose a new password, open this link in your browser:\n\n"
        f"{reset_url}\n\n"
        f"The link expires in {RESET_LINK_TTL_HUMAN}. If you didn't request a\n"
        "password reset you can safely ignore this email — your password\n"
        "won't change.\n\n"
        "— The Gomoku team\n"
        f"https://{settings.public_domain}\n"
    )


def _password_reset_html(reset_url: str) -> str:
    """Inline-styled, table-based HTML email.

    Inline styles + tables because Gmail/Outlook strip <style> blocks and
    misrender modern CSS. Width capped at 600px for the standard email viewport.
    """
    logo = _logo_url()
    site = f"https://{settings.public_domain}"
    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Reset your Gomoku password</title>
  </head>
  <body style="margin:0;padding:0;background-color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">
      Reset your Gomoku password. This link expires in {RESET_LINK_TTL_HUMAN}.
    </span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0f172a;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.18);">
            <tr>
              <td align="center" style="padding:32px 24px 16px 24px;background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);">
                <img src="{logo}" alt="Gomoku" width="64" height="64" style="display:block;border:0;outline:none;text-decoration:none;border-radius:14px;">
                <div style="font-size:20px;font-weight:600;color:#f8fafc;letter-spacing:0.02em;margin-top:12px;">Gomoku</div>
              </td>
            </tr>
            <tr>
              <td style="padding:32px 32px 8px 32px;">
                <h1 style="margin:0 0 16px 0;font-size:22px;line-height:1.3;color:#0f172a;font-weight:600;">Reset your password</h1>
                <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#334155;">
                  Someone (hopefully you) asked to reset the password on your Gomoku account.
                  Click the button below to choose a new one.
                </p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:8px 32px 24px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td align="center" bgcolor="#1e293b" style="border-radius:8px;">
                      <a href="{reset_url}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;background-color:#1e293b;">
                        Reset password
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px 32px;">
                <p style="margin:0 0 12px 0;font-size:13px;line-height:1.6;color:#64748b;">
                  Or copy and paste this link into your browser:
                </p>
                <p style="margin:0;font-size:13px;line-height:1.6;color:#1e293b;word-break:break-all;">
                  <a href="{reset_url}" target="_blank" style="color:#1e293b;text-decoration:underline;">{reset_url}</a>
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 32px 32px;">
                <div style="border-top:1px solid #e2e8f0;padding-top:20px;">
                  <p style="margin:0 0 8px 0;font-size:13px;line-height:1.6;color:#64748b;">
                    This link expires in <strong style="color:#334155;">{RESET_LINK_TTL_HUMAN}</strong>.
                  </p>
                  <p style="margin:0;font-size:13px;line-height:1.6;color:#64748b;">
                    If you didn't request a password reset you can safely ignore this email —
                    your password won't change.
                  </p>
                </div>
              </td>
            </tr>
          </table>
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
            <tr>
              <td align="center" style="padding:16px 24px 8px 24px;">
                <p style="margin:0;font-size:12px;line-height:1.6;color:#94a3b8;">
                  Sent by <a href="{site}" target="_blank" style="color:#cbd5e1;text-decoration:none;">Gomoku</a> —
                  the classic 5-in-a-row board game.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
"""


async def send_password_reset_email(to_email: str, token: str) -> None:
    """Send a password-reset email containing a one-time link.

    The provider is selected by ``settings.email_provider``:
      * ``stdout`` — log the URL (dev/test default; no network call).
      * ``sendgrid`` — POST to SendGrid v3 with both text and HTML parts.

    Raises ``RuntimeError`` if the SendGrid call returns a non-2xx response,
    so the caller (and request log) can see that the email didn't go out.
    """
    reset_url = _reset_url(token)

    if settings.email_provider == "stdout":
        logger.info("Password reset email (stdout) to=%s url=%s", to_email, reset_url)
        print(f"\n{'=' * 60}")
        print("PASSWORD RESET EMAIL")
        print(f"To: {to_email}")
        print(f"Reset URL: {reset_url}")
        print(f"{'=' * 60}\n")
        return

    if settings.email_provider == "sendgrid":
        if not settings.sendgrid_api_key:
            raise RuntimeError("email_provider=sendgrid but SENDGRID_API_KEY is unset")

        payload = {
            "personalizations": [{"to": [{"email": to_email}]}],
            "from": {"email": settings.email_from, "name": settings.email_from_name},
            "reply_to": {"email": settings.email_from, "name": settings.email_from_name},
            "subject": "Reset your Gomoku password",
            "content": [
                {"type": "text/plain", "value": _password_reset_text(reset_url)},
                {"type": "text/html", "value": _password_reset_html(reset_url)},
            ],
            "tracking_settings": {
                "click_tracking": {"enable": False, "enable_text": False},
                "open_tracking": {"enable": False},
            },
        }

        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                SENDGRID_ENDPOINT,
                headers={
                    "Authorization": f"Bearer {settings.sendgrid_api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )

        if resp.status_code >= 300:
            logger.error(
                "SendGrid rejected password-reset email: to=%s status=%s body=%s",
                to_email,
                resp.status_code,
                resp.text,
            )
            raise RuntimeError(
                f"SendGrid returned {resp.status_code} sending password reset: {resp.text}"
            )

        logger.info(
            "Password reset email sent via SendGrid: to=%s status=%s",
            to_email,
            resp.status_code,
        )
        return

    raise RuntimeError(f"Unknown email_provider: {settings.email_provider!r}")
