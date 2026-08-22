import platform
import shutil
import time
from datetime import datetime, timezone

import psutil
from fastapi import APIRouter, Depends

from ..config import BASE_ROOT
from ..security import guard

router = APIRouter(prefix="/api/sys", dependencies=[Depends(guard)])

_prev_cpu = psutil.cpu_times()
_prev_t = time.time()


def _cpu_percent() -> float:
    global _prev_cpu, _prev_t
    now = psutil.cpu_times()
    t = time.time()
    dt = t - _prev_t
    if dt <= 0:
        return 0.0
    deltas = [b - a for a, b in zip(_prev_cpu, now)]
    idle = float(deltas[3]) + (float(deltas[4]) if len(deltas) > 4 else 0.0)
    total = float(sum(deltas))
    pct = max(0.0, min(100.0, (1 - idle / total) * 100)) if total > 0 else 0.0
    _prev_cpu = now
    _prev_t = t
    return round(pct, 1)


def _boot_time() -> float:
    try:
        return psutil.boot_time()
    except Exception:
        with open("/proc/uptime") as f:
            return time.time() - float(f.read().split()[0])


@router.get("/info")
async def info():
    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()
    disk_root = shutil.disk_usage(str(BASE_ROOT))
    disk_cwd = shutil.disk_usage("/")
    net = psutil.net_io_counters()
    procs = len(psutil.pids())
    boot = _boot_time()
    up_s = int(time.time() - boot)
    days, rem = divmod(up_s, 86400)
    hours, rem = divmod(rem, 3600)
    mins = rem // 60
    cpu_freq = None
    try:
        f = psutil.cpu_freq()
        if f:
            cpu_freq = {"current": round(f.current), "max": round(f.max or 0)}
    except Exception:
        pass
    return {
        "hostname": platform.node(),
        "platform": platform.system(),
        "release": platform.release(),
        "arch": platform.machine(),
        "python": platform.python_version(),
        "cpu": {
            "percent": _cpu_percent(),
            "cores_physical": psutil.cpu_count(logical=False),
            "cores_logical": psutil.cpu_count(logical=True),
            "freq": cpu_freq,
            "loadavg": [round(x, 2) for x in __import__("os").getloadavg()] if hasattr(__import__("os"), "getloadavg") else [],
        },
        "memory": {
            "total": mem.total,
            "used": mem.total - mem.available,
            "available": mem.available,
            "percent": mem.percent,
            "swap_total": swap.total,
            "swap_used": swap.used,
            "swap_percent": swap.percent,
        },
        "disk": {
            "root_path": str(BASE_ROOT),
            "total": disk_root.total,
            "used": disk_root.used,
            "free": disk_root.free,
            "percent": round(disk_root.used / disk_root.total * 100, 1) if disk_root.total else 0,
            "system_total": disk_cwd.total,
            "system_used": disk_cwd.used,
            "system_percent": round(disk_cwd.used / disk_cwd.total * 100, 1) if disk_cwd.total else 0,
        },
        "network": {"sent": net.bytes_sent, "recv": net.bytes_recv},
        "processes": procs,
        "uptime_seconds": up_s,
        "uptime": f"{days}d {hours}h {mins}m" if days else f"{hours}h {mins}m",
        "time": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
    }
