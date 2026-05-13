from datetime import UTC, datetime, timedelta

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBearer

from app.config import settings
from app.database import get_pool
from app.session import get_session

bearer_scheme = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


def create_token(user_id: str, username: str) -> str:
    payload = {
        "sub": user_id,
        "username": username,
        "exp": datetime.now(UTC) + timedelta(minutes=settings.jwt_expire_minutes),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token expired")
    except jwt.InvalidTokenError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"Invalid token: {e}")


async def get_current_user(
    request: Request,
    pool=Depends(get_pool),
) -> dict:
    """Resolve the authenticated user. Uses the JWT already decoded by middleware."""
    session = get_session(request)
    if session.jwt_payload:
        payload = session.jwt_payload
    else:
        # Middleware didn't decode (no token or invalid) — try with proper error messages
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer "):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
        payload = decode_token(auth[7:])

    user_id = payload.get("sub")
    if user_id is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token payload")
    # NOTE: get_current_user used to bump users.last_seen_at on every
    # authenticated call. Presence is now driven entirely by the
    # client via POST /users/me/seen (see UserActivityTracker on the
    # frontend), so the auth dependency is read-only — the row it
    # returns reflects the last value the client itself posted.
    row = await pool.fetchrow(
        """SELECT id, username, email, first_name, last_name,
                  created_at, last_logged_in_at, logins_count,
                  last_seen_at
           FROM users WHERE id = $1::uuid""",
        user_id,
    )
    if row is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User not found")
    return dict(row)


async def get_optional_user(
    request: Request,
    pool=Depends(get_pool),
) -> dict | None:
    session = get_session(request)
    if not session.jwt_payload:
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer "):
            return None
    try:
        return await get_current_user(request, pool)
    except HTTPException:
        return None
