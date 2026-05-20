import secrets
from datetime import UTC, datetime, timedelta

from asyncpg import UniqueViolationError
from fastapi import APIRouter, Depends, HTTPException, status

from app.database import get_pool
from app.logger import get_logger
from app.models.user import (
    PasswordResetConfirm,
    PasswordResetRequest,
    TokenResponse,
    UserCreate,
    UserLogin,
)
from app.security import create_token, hash_password, verify_password
from app.services.email import send_password_reset_email

logger = get_logger("gomoku.auth")

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/signup", response_model=TokenResponse)
async def signup(body: UserCreate, pool=Depends(get_pool)):
    logger.info("Signup attempt: username=%s email=%s", body.username, body.email)
    hashed = hash_password(body.password)
    try:
        row = await pool.fetchrow(
            """INSERT INTO users (username, email, password_hash, first_name, last_name)
               VALUES ($1, $2, $3, $4, $5)
               RETURNING id, username""",
            body.username,
            body.email,
            hashed,
            body.first_name,
            body.last_name,
        )
    except UniqueViolationError:
        logger.warning("Signup conflict: username=%s email=%s", body.username, body.email)
        raise HTTPException(status.HTTP_409_CONFLICT, "Username or email already taken")

    logger.info("Signup success: user_id=%s username=%s", row["id"], row["username"])
    token = create_token(str(row["id"]), row["username"])
    return TokenResponse(access_token=token, username=row["username"])


@router.post("/login", response_model=TokenResponse)
async def login(body: UserLogin, pool=Depends(get_pool)):
    logger.info("Login attempt: username=%s", body.username)
    row = await pool.fetchrow(
        "SELECT id, username, password_hash FROM users WHERE lower(username) = lower($1)",
        body.username,
    )
    if row is None or not verify_password(body.password, row["password_hash"]):
        logger.warning("Login failed: username=%s", body.username)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid username or password")

    # Track login activity — fire and forget, must not fail the login.
    # Bumping last_seen_at here is the only place outside POST
    # /users/me/seen (and signup's DEFAULT now()) that writes the field;
    # everywhere else is read-only now that presence is client-driven.
    try:
        await pool.execute(
            """UPDATE users
               SET last_logged_in_at = now(),
                   last_seen_at      = now(),
                   logins_count      = logins_count + 1,
                   updated_at        = now()
               WHERE id = $1::uuid""",
            str(row["id"]),
        )
    except Exception:
        logger.warning("Failed to update login stats: user_id=%s", row["id"])

    logger.info("Login success: user_id=%s username=%s", row["id"], row["username"])
    token = create_token(str(row["id"]), row["username"])
    return TokenResponse(access_token=token, username=row["username"])


@router.post("/password-reset")
async def request_password_reset(body: PasswordResetRequest, pool=Depends(get_pool)):
    # Always return 200 to prevent email enumeration
    row = await pool.fetchrow("SELECT id FROM users WHERE lower(email) = lower($1)", body.email)
    if row:
        token = secrets.token_urlsafe(32)
        expires = datetime.now(UTC) + timedelta(hours=1)
        await pool.execute(
            """INSERT INTO password_reset_tokens (user_id, token, expires_at)
               VALUES ($1, $2, $3)""",
            row["id"],
            token,
            expires,
        )
        await send_password_reset_email(body.email, token)

    return {"message": "If an account with that email exists, a reset link has been sent."}


@router.post("/password-reset/confirm")
async def confirm_password_reset(body: PasswordResetConfirm, pool=Depends(get_pool)):
    row = await pool.fetchrow(
        """SELECT id, user_id FROM password_reset_tokens
           WHERE token = $1 AND NOT used AND expires_at > now()""",
        body.token,
    )
    if row is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid or expired reset token")

    hashed = hash_password(body.new_password)
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2::uuid",
                hashed,
                str(row["user_id"]),
            )
            await conn.execute(
                "UPDATE password_reset_tokens SET used = true WHERE id = $1::uuid",
                str(row["id"]),
            )

    return {"message": "Password updated successfully."}
