import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from .agent import MAX_BYTES, InvalidImage, inspect_image
from .detector import Detector

DOCS = Path(__file__).resolve().parents[1] / "docs"


def create_app(detector_factory=Detector):
    @asynccontextmanager
    async def lifespan(app):
        app.state.detector = await run_in_threadpool(detector_factory)
        app.state.inference = asyncio.Lock()
        yield

    app = FastAPI(title="DUET Agent Platform", lifespan=lifespan, docs_url="/api/docs")

    @app.middleware("http")
    async def limit_upload(request: Request, call_next):
        if request.method == "POST" and request.url.path == "/api/inspect":
            size = request.headers.get("content-length", "")
            if not size.isascii() or not size.isdecimal():
                return JSONResponse({"detail": "A Content-Length header is required."}, 411)
            if len(size) > 8 or int(size) > MAX_BYTES + 128 * 1024:
                return JSONResponse({"detail": "The image exceeds 8 MiB."}, 413)
        return await call_next(request)

    @app.get("/api/health")
    def health(request: Request):
        return {"status": "ready", "model": request.app.state.detector.model_id}

    @app.post("/api/inspect")
    async def inspect(request: Request, image: UploadFile = File()):
        lock = request.app.state.inference
        if lock.locked():
            raise HTTPException(429, "An inspection is running. Try again shortly.")
        payload = await image.read(MAX_BYTES + 1)
        if len(payload) > MAX_BYTES:
            raise HTTPException(413, "The image exceeds 8 MiB.")
        if lock.locked():
            raise HTTPException(429, "An inspection is running. Try again shortly.")
        async with lock:
            try:
                return await run_in_threadpool(
                    inspect_image, request.app.state.detector, payload, image.filename or "upload"
                )
            except InvalidImage as exc:
                raise HTTPException(422, str(exc)) from exc

    app.mount("/", StaticFiles(directory=DOCS, html=True), name="site")
    return app


app = create_app()
