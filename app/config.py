import os
from pathlib import Path

BASE_ROOT = Path(os.getenv("FILE_MANAGER_ROOT", "/")).resolve()
ACCESS_TOKEN = os.getenv("ACCESS_TOKEN", "").strip()
MAX_EDIT_SIZE = 2 * 1024 * 1024
MAX_UPLOAD_SIZE = 1024 * 1024 * 1024
