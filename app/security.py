from fastapi import Header, HTTPException, Query, WebSocket

from .config import ACCESS_TOKEN


def _check(token: str | None) -> None:
    if not ACCESS_TOKEN:
        return
    if token != ACCESS_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid or missing access token")


async def guard(x_access_token: str | None = Header(default=None, alias="X-Access-Token")) -> None:
    _check(x_access_token)


async def ws_guard(websocket: WebSocket, token: str | None = Query(default=None)) -> None:
    if ACCESS_TOKEN and token != ACCESS_TOKEN:
        await websocket.close(code=4401, reason="Unauthorized")
        raise HTTPException(status_code=401, detail="Unauthorized")
