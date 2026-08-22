import fnmatch
import os
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, File as UploadFiles, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel

from ..config import BASE_ROOT, MAX_EDIT_SIZE
from ..security import guard

router = APIRouter(prefix="/api/fs", dependencies=[Depends(guard)])


def safe_path(p: str) -> Path:
    if not p or not p.strip():
        raise HTTPException(status_code=400, detail="Path is required")
    target = Path(p)
    if not target.is_absolute():
        target = BASE_ROOT / target
    resolved = target.resolve()
    root_str = str(BASE_ROOT)
    res_str = str(resolved)
    if BASE_ROOT != Path("/") and res_str != root_str and not res_str.startswith(root_str + os.sep):
        raise HTTPException(status_code=403, detail="Path is outside the allowed root")
    return resolved


def _fmt_time(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).astimezone().isoformat(timespec="seconds")


def stat_entry(p: Path) -> dict:
    try:
        st = p.stat()
    except (FileNotFoundError, PermissionError):
        st = p.lstat()
    is_link = p.is_symlink()
    is_dir = p.is_dir()
    entry = {
        "name": p.name or str(p),
        "path": str(p),
        "type": "link" if is_link else ("dir" if is_dir else "file"),
        "size": 0 if is_dir else st.st_size,
        "mtime": _fmt_time(st.st_mtime),
        "mode": oct(st.st_mode & 0o777),
        "hidden": p.name.startswith("."),
    }
    if is_link and is_dir:
        entry["type"] = "dir"
    return entry


@router.get("/auth/check")
async def auth_check(x_access_token: Optional[str] = Header(default=None)):
    from ..config import ACCESS_TOKEN
    if not ACCESS_TOKEN:
        return {"token_required": False, "valid": True}
    if x_access_token == ACCESS_TOKEN:
        return {"token_required": True, "valid": True}
    raise HTTPException(status_code=401, detail="Invalid token")


@router.get("/list")
async def list_dir(path: str = Query(default=str(BASE_ROOT)), show_hidden: bool = Query(default=False)):
    target = safe_path(path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="Directory not found")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="Not a directory")
    entries = []
    try:
        for child in target.iterdir():
            if not show_hidden and child.name.startswith("."):
                continue
            try:
                entries.append(stat_entry(child))
            except OSError:
                continue
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")
    dirs = sorted([e for e in entries if e["type"] == "dir"], key=lambda e: e["name"].lower())
    files = sorted([e for e in entries if e["type"] != "dir"], key=lambda e: e["name"].lower())
    parent = str(target.parent) if target != BASE_ROOT else None
    disk = shutil.disk_usage(str(target))
    return {
        "path": str(target),
        "parent": parent,
        "entries": dirs + files,
        "disk": {"total": disk.total, "used": disk.used, "free": disk.free},
    }


@router.get("/search")
async def search(path: str = Query(...), q: str = Query(...), limit: int = Query(default=200)):
    base = safe_path(path)
    pattern = q.lower()
    results = []
    skip_dirs = {"/proc", "/sys", "/dev", "/run", "__pycache__", ".git", "node_modules"}
    count = 0
    for dirpath, dirnames, filenames in os.walk(base, topdown=True, onerror=lambda e: None):
        dirnames[:] = [d for d in dirnames if d not in skip_dirs]
        for name in dirnames + filenames:
            if pattern in name.lower():
                full = Path(dirpath) / name
                try:
                    results.append(stat_entry(full))
                except OSError:
                    continue
                count += 1
                if count >= limit:
                    break
        if count >= limit:
            break
    dirs = [e for e in results if e["type"] == "dir"]
    files = [e for e in results if e["type"] != "dir"]
    return {"results": dirs[:limit] + files[:limit], "truncated": count >= limit}


class MkdirIn(BaseModel):
    path: str


class TouchIn(BaseModel):
    path: str


class RenameIn(BaseModel):
    src: str
    dst: str


class ItemsIn(BaseModel):
    items: List[str]


class ItemsDestIn(BaseModel):
    items: List[str]
    dest: str


class NameIn(BaseModel):
    name: str


class WriteIn(BaseModel):
    path: str
    content: str


class ExtractIn(BaseModel):
    path: str
    dest: Optional[str] = None


@router.post("/mkdir")
async def mkdir(body: MkdirIn):
    target = safe_path(body.path)
    if target.exists():
        raise HTTPException(status_code=409, detail="Already exists")
    try:
        target.mkdir(parents=True)
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")
    return {"ok": True, "path": str(target)}


@router.post("/touch")
async def touch(body: TouchIn):
    target = safe_path(body.path)
    if target.exists():
        raise HTTPException(status_code=409, detail="Already exists")
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("", encoding="utf-8")
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")
    return {"ok": True, "path": str(target)}


def _validate_dst(dst: str) -> Path:
    d = safe_path(dst)
    if d.exists():
        raise HTTPException(status_code=409, detail=f"'{d.name}' already exists at destination")
    if not d.parent.is_dir():
        raise HTTPException(status_code=400, detail="Destination directory does not exist")
    return d


@router.post("/rename")
async def rename(body: RenameIn):
    src = safe_path(body.src)
    if not src.exists():
        raise HTTPException(status_code=404, detail="Source not found")
    dst = _validate_dst(body.dst)
    try:
        shutil.move(str(src), str(dst))
    except (OSError, shutil.Error) as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "path": str(dst)}


@router.post("/move")
async def move(body: ItemsDestIn):
    dest = safe_path(body.dest)
    if not dest.is_dir():
        raise HTTPException(status_code=400, detail="Destination must be a directory")
    moved = []
    for item in body.items:
        src = safe_path(item)
        if not src.exists():
            continue
        target = dest / src.name
        if target.resolve() == src.resolve():
            continue
        if target.exists():
            raise HTTPException(status_code=409, detail=f"'{src.name}' already exists in destination")
        try:
            shutil.move(str(src), str(target))
            moved.append(src.name)
        except (OSError, shutil.Error) as e:
            raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "moved": moved}


@router.post("/copy")
async def copy(body: ItemsDestIn):
    dest = safe_path(body.dest)
    if not dest.is_dir():
        raise HTTPException(status_code=400, detail="Destination must be a directory")
    copied = []
    for item in body.items:
        src = safe_path(item)
        if not src.exists():
            continue
        target = dest / src.name
        if target.resolve() == src.resolve():
            continue
        if target.exists():
            raise HTTPException(status_code=409, detail=f"'{src.name}' already exists in destination")
        try:
            if src.is_dir():
                shutil.copytree(str(src), str(target), symlinks=True)
            else:
                shutil.copy2(str(src), str(target))
            copied.append(src.name)
        except (OSError, shutil.Error) as e:
            raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "copied": copied}


@router.post("/delete")
async def delete(body: ItemsIn):
    deleted = []
    for item in body.items:
        target = safe_path(item)
        if target == BASE_ROOT or str(target) == "/":
            raise HTTPException(status_code=403, detail="Refusing to delete the root directory")
        if not target.exists() and not target.is_symlink():
            continue
        try:
            if target.is_dir() and not target.is_symlink():
                shutil.rmtree(str(target))
            else:
                target.unlink(missing_ok=True)
            deleted.append(target.name)
        except (OSError, PermissionError) as e:
            raise HTTPException(status_code=500, detail=f"Failed to delete '{target.name}': {str(e)}")
    return {"ok": True, "deleted": deleted}


@router.get("/read")
async def read_file(path: str = Query(...)):
    target = safe_path(path)
    if not target.is_file():
        raise HTTPException(status_code=400, detail="Not a file")
    if target.stat().st_size > MAX_EDIT_SIZE:
        raise HTTPException(status_code=413, detail="File too large to edit (max 2 MB)")
    raw = target.read_bytes()
    if b"\x00" in raw[:8000]:
        raise HTTPException(status_code=415, detail="Binary file cannot be edited")
    return {
        "path": str(target),
        "name": target.name,
        "content": raw.decode("utf-8", errors="replace"),
        "writable": os.access(str(target), os.W_OK),
    }


@router.put("/write")
async def write_file(body: WriteIn):
    target = safe_path(body.path)
    if not target.parent.is_dir():
        raise HTTPException(status_code=400, detail="Parent directory does not exist")
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(dir=str(target.parent), prefix=".nx_", suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(body.content)
        os.replace(tmp, str(target))
        tmp = None
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")
    finally:
        if tmp and os.path.exists(tmp):
            os.unlink(tmp)
    return {"ok": True, "size": len(body.content.encode("utf-8"))}


@router.get("/download")
async def download(path: str = Query(...)):
    target = safe_path(path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="Not found")
    if target.is_file():
        return FileResponse(str(target), filename=target.name)
    if target.is_dir():
        tmpdir = tempfile.mkdtemp(prefix="nexus_dl_")
        zip_base = str(Path(tmpdir) / target.stem)
        archive = shutil.make_archive(zip_base, "zip", root_dir=str(target.parent), base_dir=target.name)

        def cleanup():
            shutil.rmtree(tmpdir, ignore_errors=True)

        return FileResponse(archive, filename=target.name + ".zip", background=BackgroundTask(cleanup))
    raise HTTPException(status_code=400, detail="Cannot download this item")


@router.get("/raw")
async def raw(path: str = Query(...)):
    target = safe_path(path)
    if not target.is_file():
        raise HTTPException(status_code=400, detail="Not a file")
    media, _ = __import__("mimetypes").guess_type(str(target))
    return FileResponse(str(target), media_type=media or "application/octet-stream")


@router.post("/upload")
async def upload(files: List[UploadFile] = UploadFiles(...), dir: str = Query(default=str(BASE_ROOT))):
    dest = safe_path(dir)
    if not dest.is_dir():
        raise HTTPException(status_code=400, detail="Target directory does not exist")
    saved = []
    for uf in files:
        rel = uf.filename.replace("\\", "/")
        parts = [seg for seg in rel.split("/") if seg and seg not in (".", "..")]
        if not parts:
            continue
        target = dest.joinpath(*parts).resolve()
        res_str = str(target)
        if BASE_ROOT != Path("/") and not res_str.startswith(str(BASE_ROOT) + os.sep) and res_str != str(BASE_ROOT):
            raise HTTPException(status_code=403, detail="Upload path escapes root")
        try:
            with open(target, "wb") as out:
                while chunk := await uf.read(1024 * 1024):
                    out.write(chunk)
            saved.append({"name": uf.filename, "path": str(target), "size": target.stat().st_size})
        except PermissionError:
            raise HTTPException(status_code=403, detail=f"Permission denied writing '{uf.filename}'")
        finally:
            await uf.close()
    return {"ok": True, "saved": saved}


ARCHIVE_EXTS = {".zip", ".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz"}


@router.post("/compress")
async def compress(body: ItemsIn, name: str = Query(default="")):
    if not body.items:
        raise HTTPException(status_code=400, detail="No items selected")
    first = safe_path(body.items[0])
    zip_name = name.strip() or f"{first.stem or 'archive'}.zip"
    if not zip_name.endswith(".zip"):
        zip_name += ".zip"
    dest_dir = first.parent
    dest = dest_dir / zip_name
    i = 1
    while dest.exists():
        dest = dest_dir / f"{Path(zip_name).stem}_{i}.zip"
        i += 1
    try:
        with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
            for item in body.items:
                p = safe_path(item)
                if p.is_dir():
                    for dp, dns, fns in os.walk(p):
                        for fn in fns:
                            fp = Path(dp) / fn
                            zf.write(fp, str(fp.relative_to(p.parent)))
                        dns[:] = [d for d in dns if not d.startswith(".nexus")]
                elif p.is_file():
                    zf.write(p, p.name)
    except (OSError, PermissionError) as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "archive": str(dest)}


@router.post("/extract")
async def extract(body: ExtractIn):
    target = safe_path(body.path)
    if not target.is_file():
        raise HTTPException(status_code=400, detail="Archive not found")
    lower = target.name.lower()
    if not any(lower.endswith(e) for e in [".zip", ".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz", ".gz", ".bz2", ".xz"]):
        raise HTTPException(status_code=400, detail="Unsupported archive format")
    if body.dest:
        dest = safe_path(body.dest)
    else:
        dest = target.parent / (target.name.rsplit(".", 2)[0] or "extracted")
    if dest.exists() and any(dest.iterdir()):
        raise HTTPException(status_code=409, detail="Destination folder already contains files")
    dest.mkdir(parents=True, exist_ok=True)
    try:
        shutil.unpack_archive(str(target), str(dest))
    except (shutil.ReadError, OSError) as e:
        raise HTTPException(status_code=500, detail=f"Extraction failed: {str(e)}")
    return {"ok": True, "dest": str(dest)}
