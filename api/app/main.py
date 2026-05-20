from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.auth_gcp import GCPIdentityAuth
from app.config import settings
from app.database import close_pool, create_pool
from app.logger import get_logger
from app.middleware.client_ip import ClientIPMiddleware
from app.middleware.http_response_exception import HTTPResponseExceptionMiddleware
from app.middleware.request_logging import RequestLoggingMiddleware
from app.routers import auth, chat, game, leaderboard, multiplayer, social, user
from app.telemetry import instrument_app, setup_telemetry

# Initialize tracing before any instrumentable client (httpx, asyncpg) is built.
setup_telemetry("gomoku-api")

STATIC_DIR = Path(__file__).resolve().parent.parent / "public"


@asynccontextmanager
async def lifespan(fastapi_app: FastAPI):
    fastapi_app.state.db_pool = await create_pool()
    # Engine has INGRESS_TRAFFIC_INTERNAL_ONLY in Cloud Run; an ID token bound
    # to its URL is required. No-op locally (no ADC).
    engine_auth = GCPIdentityAuth(settings.gomoku_httpd_url)
    # Warm the token cache + log a startup line so the audit trail shows
    # whether the metadata server is reachable from this Cloud Run instance.
    engine_auth.warm()
    fastapi_app.state.httpx_client = httpx.AsyncClient(
        base_url=settings.gomoku_httpd_url,
        timeout=httpx.Timeout(connect=5.0, read=600.0, write=5.0, pool=5.0),
        limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
        auth=engine_auth,
    )
    yield
    await fastapi_app.state.httpx_client.aclose()
    await close_pool()


logger = get_logger("gomoku.app")

fastapi_app = FastAPI(title="Gomoku API", version="0.1.0", lifespan=lifespan)

fastapi_app.add_middleware(HTTPResponseExceptionMiddleware)
fastapi_app.add_middleware(RequestLoggingMiddleware)
fastapi_app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@fastapi_app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    # Build JSON-safe error list (exc.errors() can contain non-serializable ValueError)
    safe_errors = []
    for err in exc.errors():
        safe = {k: v for k, v in err.items() if k != "ctx"}
        if "input" in safe and isinstance(safe["input"], bytes):
            safe["input"] = safe["input"].decode("utf-8", errors="replace")
        safe_errors.append(safe)

    logger.warning(
        "Validation error on %s %s: %s | body=%s",
        request.method,
        request.url.path,
        safe_errors,
        exc.body,
    )
    return JSONResponse(status_code=422, content={"detail": safe_errors})


fastapi_app.include_router(auth.router)
fastapi_app.include_router(chat.router)
fastapi_app.include_router(game.router)
fastapi_app.include_router(leaderboard.router)
fastapi_app.include_router(multiplayer.router)
fastapi_app.include_router(social.router)
fastapi_app.include_router(user.router)

instrument_app(fastapi_app)


@fastapi_app.get("/health")
async def health():
    return {"status": "ok"}


# Serve frontend static assets if the public/ directory exists
if STATIC_DIR.is_dir():
    # Mount static assets (JS, CSS, images) under /assets
    assets_dir = STATIC_DIR / "assets"
    if assets_dir.is_dir():
        fastapi_app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    # SPA catch-all: serve index.html for any unmatched route
    @fastapi_app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        file_path = STATIC_DIR / full_path
        if file_path.is_file():
            return FileResponse(str(file_path))
        return FileResponse(str(STATIC_DIR / "index.html"))


# Wrap with pure ASGI middleware (after all routes are registered)
app = ClientIPMiddleware(fastapi_app)
