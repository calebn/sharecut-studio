"""Show a file in the host's own file manager (loopback GUI only, like the OS file dialog)."""

from __future__ import annotations

import platform
from pathlib import Path

from podcast_mcp.util import process

_REVEAL_TIMEOUT_SEC = 10.0


def _argv(path: Path, system: str) -> list[str] | None:
    if system == "Darwin":
        return ["open", "-R", str(path)]
    if system == "Windows":
        return ["explorer", f"/select,{path}"]
    if system == "Linux":
        return ["xdg-open", str(path.parent)]
    return None


def reveal_in_file_manager(path: Path, *, system: str | None = None) -> bool:
    """Open the file manager on *path*; False when this platform has no way to do it.

    *path* must already be a listed export file. The argv is never a shell string.
    """
    argv = _argv(path, (system or platform.system()).strip())
    if argv is None:
        return False
    try:
        # explorer exits 1 even when it opened the window, so the exit code is not checked.
        process.run(argv, capture_output=True, timeout=_REVEAL_TIMEOUT_SEC, check=False)
    except (FileNotFoundError, process.TimeoutExpired):
        return False
    return True
