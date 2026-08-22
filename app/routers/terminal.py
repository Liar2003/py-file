import asyncio
import fcntl
import json
import os
import pty
import signal
import struct
import subprocess
import termios
from pathlib import Path

from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect

from ..config import ACCESS_TOKEN
from .files import safe_path

router = APIRouter()

SHELL = os.getenv("SHELL") or "/bin/bash"


@router.websocket("/ws/terminal")
async def terminal_ws(websocket: WebSocket, token: str | None = Query(default=None), cwd: str | None = Query(default=None)):
    if ACCESS_TOKEN and token != ACCESS_TOKEN:
        await websocket.close(code=4401, reason="Unauthorized")
        return
    await websocket.accept()
    start_dir = "/"
    if cwd:
        try:
            p = safe_path(cwd)
            if p.is_dir():
                start_dir = str(p)
        except Exception:
            pass

    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLORTERM"] = "truecolor"
        os.environ["LANG"] = "en_US.UTF-8"
        try:
            os.chdir(start_dir)
        except OSError:
            pass
        try:
            os.execvp(SHELL, [SHELL])
        except FileNotFoundError:
            os.execvp("/bin/sh", ["/bin/sh"])
        os._exit(1)

    running = True

    def set_winsize(rows: int, cols: int):
        try:
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows or 24, cols or 80, 0, 0))
        except OSError:
            pass

    set_winsize(30, 120)

    async def pump_output():
        nonlocal running
        loop = asyncio.get_event_loop()
        try:
            while True:
                data = await loop.run_in_executor(None, os.read, fd, 16384)
                if not data:
                    break
                await websocket.send_bytes(data)
        except (OSError, asyncio.CancelledError):
            pass
        finally:
            running = False
            try:
                await websocket.send_text(json.dumps({"type": "exit"}))
            except Exception:
                pass

    pump_task = asyncio.create_task(pump_output())

    try:
        while True:
            raw = await websocket.receive_text()
            is_resize = False
            if raw.startswith("{"):
                try:
                    msg = json.loads(raw)
                    if isinstance(msg, dict) and msg.get("type") == "resize":
                        set_winsize(int(msg.get("rows", 24)), int(msg.get("cols", 80)))
                        is_resize = True
                except (json.JSONDecodeError, ValueError):
                    pass
            if not is_resize and running:
                loop = asyncio.get_event_loop()
                await loop.run_in_executor(None, os.write, fd, raw.encode("utf-8"))
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        pump_task.cancel()
        try:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            _, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass
