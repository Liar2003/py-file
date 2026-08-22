from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.routers import files, system
from app.routers.terminal import router as terminal_router

BASE_DIR = Path(__file__).resolve().parent

app = FastAPI(title="Nexus File Manager", version="1.0.0", docs_url="/docs", redoc_url=None)

app.include_router(files.router)
app.include_router(system.router)
app.include_router(terminal_router)


@app.get("/health")
def health():
    return {"status": "ok"}


app.mount("/", StaticFiles(directory=str(BASE_DIR / "static"), html=True), name="static")
