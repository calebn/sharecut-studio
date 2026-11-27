"""Child process that downloads one pinned Hugging Face snapshot with Xet on (#1998).

``python -m podcast_mcp.util.hf_fetch_child <spec.json>``. The spec is a JSON object with
``repo``, ``revision``, ``allow_patterns``, ``cache_dir`` and ``force_download``.

hf_xet swallows exceptions from the progress callback, so the parent cannot stop a Xet
transfer from inside. It runs the transfer here instead, measures progress from the cache
growing on disk, and kills this process (and its group) on Cancel. The child also exits
when its stdin reaches EOF, so a parent that dies never leaves the transfer running.

stdout carries exactly one final JSON line, ``{"path": ...}`` (exit 0) or
``{"error": <class name>, "status": <http status or null>, "message": ..., "kind": ...,
"errno": ..., "xet": <bool>}`` (exit 1). ``kind`` is ``http``, ``network``, ``disk`` or
``other``; ``xet`` is true when the failing exception is an hf_xet failure, the only failure the parent
retries over plain HTTP. Everything else the hub prints goes to stderr, which the parent points
at a log file.
"""

from __future__ import annotations

import contextlib
import errno
import io
import json
import os
import re
import sys
import threading
from typing import Any, TextIO

_DISK_ERRNOS = frozenset({errno.ENOSPC, errno.EDQUOT, errno.EACCES, errno.EROFS})
_MAX_MESSAGE = 500


def _status(exc: BaseException) -> int | None:
    """The http status of ``exc`` or of what it wraps (the hub re-raises a failed listing as a
    ``LocalEntryNotFoundError`` whose ``__cause__`` is the 404/403). Only ``__cause__`` is
    followed: an implicit ``__context__`` says nothing about why ``exc`` was raised."""
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        status = getattr(getattr(current, "response", None), "status_code", None)
        if isinstance(status, int):
            return status
        current = current.__cause__
    return None


def _is_network(exc: BaseException) -> bool:
    import urllib.error

    from huggingface_hub.errors import (
        DryRunError,
        HTTPError,
        LocalEntryNotFoundError,
        OfflineModeIsEnabled,
    )

    kinds: list[type[BaseException]] = [
        OfflineModeIsEnabled,
        DryRunError,
        LocalEntryNotFoundError,
        HTTPError,
        urllib.error.URLError,
        TimeoutError,
        ConnectionError,
    ]
    try:
        import httpx

        kinds.append(httpx.TransportError)
    except ImportError:
        pass
    return isinstance(exc, tuple(kinds))


_XET_MESSAGE_PREFIXES = (
    "Task error",
    "File reconstruction error",
    "CAS Client Error",
    "Data processing error",
)
"""How hf_xet's Rust core words a failure. It surfaces as a plain ``RuntimeError`` raised from
native code with no ``hf_xet`` frame, e.g. ``Task error: File reconstruction error: CAS Client
Error: Request error: HTTP status client error (401 Unauthorized), domain: https://cas-server...``
(seen with huggingface_hub 2.4.0 and hf_xet when the Xet token is refused)."""


_DISK_MESSAGE_MARKERS = ("no space left", "enospc", "disk full")
"""How a full disk reads inside an hf_xet error that carries no ``errno``: its Rust core wraps
the OS error in a plain ``RuntimeError`` (``... File reconstruction error: No space left on
device (os error 28)``), which would otherwise match the Xet prefixes and fall back."""


def _is_xet(exc: BaseException) -> bool:
    """An hf_xet failure (a blocked Xet host, a refused token): a transport problem, not a bug.

    A class defined in ``hf_xet`` (``XetAuthenticationError`` and kin), or the plain
    ``RuntimeError`` its native core raises, recognised by its message prefix. A ``Xet*``-named
    class defined elsewhere is not enough: it may wrap an unrelated error.
    """
    if type(exc).__module__.split(".")[0] == "hf_xet":
        return True
    return isinstance(exc, RuntimeError) and str(exc).startswith(_XET_MESSAGE_PREFIXES)


_OS_ERROR = re.compile(r"\(os error (\d+)\)")
_WINDOWS_DISK_FULL = 112  # ERROR_DISK_FULL, how Rust prints a full disk on Windows


def _xet_disk_errno(exc: BaseException) -> int | None:
    """The OS error behind an hf_xet failure that reports a full or unwritable disk, else None.

    Only an hf_xet-shaped error is read, so a CAS 507 body or a network error that merely says
    "disk full" keeps its own kind. The Rust core words the OS error as ``(os error N)``; a
    marker with no number means a full disk.
    """
    if isinstance(exc, OSError) or not _is_xet(exc):
        return None
    text = str(exc)
    found = _OS_ERROR.search(text)
    if found is not None:
        number = int(found.group(1))
        if number == _WINDOWS_DISK_FULL:
            return errno.ENOSPC
        if number in _DISK_ERRNOS:
            return number
    if any(marker in text.lower() for marker in _DISK_MESSAGE_MARKERS):
        return errno.ENOSPC
    return None


def describe(exc: BaseException) -> dict[str, Any]:
    """The error line for ``exc``: its class name, http status, kind and OS error number."""
    status = _status(exc)
    code = exc.errno if isinstance(exc, OSError) else _xet_disk_errno(exc)
    if status is not None:
        kind = "http"
    elif code in _DISK_ERRNOS:
        kind = "disk"
    elif _is_network(exc) or _is_xet(exc):
        kind = "network"
    else:
        kind = "other"
    xet = kind == "network" and _is_xet(exc)
    return {
        "error": type(exc).__name__,
        "status": status,
        "message": str(exc)[:_MAX_MESSAGE],
        "kind": kind,
        "errno": code,
        "xet": xet,
    }


def _exit_when_stdin_closes() -> None:
    """Die with the parent: its pipe closing is the only signal that works on every OS."""

    def watch() -> None:
        with contextlib.suppress(OSError, ValueError):
            sys.stdin.buffer.read()
        os._exit(1)

    threading.Thread(target=watch, name="parent-watch", daemon=True).start()


def _claim_stdout() -> TextIO:
    """A private handle on the real stdout; fd 1 then points at stderr so nothing else lands there."""
    result = io.TextIOWrapper(io.FileIO(os.dup(1), "w"), encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return result


def run(spec: dict[str, Any]) -> str:
    from huggingface_hub import snapshot_download
    from huggingface_hub.utils import disable_progress_bars

    disable_progress_bars()
    return str(
        snapshot_download(
            spec["repo"],
            revision=spec["revision"],
            allow_patterns=spec["allow_patterns"],
            cache_dir=spec["cache_dir"],
            force_download=bool(spec.get("force_download", False)),
        )
    )


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        sys.stderr.write("usage: python -m podcast_mcp.util.hf_fetch_child <spec.json>\n")
        return 2
    out = _claim_stdout()
    _exit_when_stdin_closes()
    try:
        with open(argv[1], encoding="utf-8") as handle:
            spec = json.load(handle)
        result: dict[str, Any] = {"path": run(spec)}
        code = 0
    except Exception as exc:  # the parent maps every failure from this one line
        result = describe(exc)
        code = 1
    out.write(json.dumps(result) + "\n")
    out.flush()
    return code


if __name__ == "__main__":
    status = main(sys.argv)
    sys.stderr.flush()
    os._exit(status)
