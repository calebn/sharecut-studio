"""Show a file in the host's own file manager (loopback GUI only, like the OS file dialog)."""

from __future__ import annotations

from pathlib import Path

from podcast_mcp.util import host_platform, process

_REVEAL_TIMEOUT_SEC = 10.0

REVEAL_REFUSED = "Show in folder only works on the computer that runs ShareCut Studio."
REVEAL_UNAVAILABLE = "This computer couldn't open its file manager."


def _argv(path: Path, tool: host_platform.RevealTool | None) -> list[str] | None:
    if tool == "open":
        return ["open", "-R", str(path)]
    if tool == "explorer":
        return ["explorer", f"/select,{path}"]
    if tool == "xdg-open":
        return ["xdg-open", str(path.parent)]
    return None


def reveal_in_file_manager(path: Path) -> bool:
    """Open the file manager on *path*; False when this platform has no way to do it.

    *path* is an episode's project file (the caller has checked it). The argv is never a shell string.
    """
    tool = host_platform.current().reveal_tool
    argv = _argv(path, tool)
    if argv is None:
        return False
    try:
        done = process.run(argv, capture_output=True, timeout=_REVEAL_TIMEOUT_SEC, check=False)
    except (FileNotFoundError, process.TimeoutExpired):
        return False
    # explorer exits 1 even when it opened the window, so its exit code is not checked there.
    return tool == "explorer" or done.returncode == 0
