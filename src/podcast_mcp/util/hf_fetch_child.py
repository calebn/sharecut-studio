"""Child process that downloads one pinned Hugging Face snapshot with Xet on (#1998).

``python -m podcast_mcp.util.hf_fetch_child <spec.json>``. The spec is a JSON object with
``repo``, ``revision``, ``allow_patterns``, ``cache_dir`` and ``force_download``.

hf_xet swallows exceptions from the progress callback, so the parent cannot stop a Xet
transfer from inside. It runs the transfer here instead, measures progress from the cache
growing on disk, and kills this process (and its group) on Cancel. The child also exits
when its stdin reaches EOF, so a parent that dies never leaves the transfer running.

stdout carries exactly one final JSON line, ``{"path": ...}`` (exit 0) or
``{"error": <class name>, "status": <http status or null>, "message": ..., "kind": ...,
"errno": ...}`` (exit 1). ``kind`` is ``http``, ``network``, ``disk`` or ``other``. Everything
else the hub prints goes to stderr, which the parent points at a log file.
"""

from __future__ import annotations

import contextlib
import errno
import io
import json
import os
import sys
import threading
from typing import Any, TextIO

_DISK_ERRNOS = frozenset({errno.ENOSPC, errno.EDQUOT, errno.EACCES, errno.EROFS})
_MAX_MESSAGE = 500


def _status(exc: BaseException) -> int | None:
    status = getattr(getattr(exc, "response", None), "status_code", None)
    return status if isinstance(status, int) else None


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


def describe(exc: BaseException) -> dict[str, Any]:
    """The error line for ``exc``: its class name, http status, kind and OS error number."""
    status = _status(exc)
    code = exc.errno if isinstance(exc, OSError) else None
    if status is not None:
        kind = "http"
    elif code in _DISK_ERRNOS:
        kind = "disk"
    elif _is_network(exc):
        kind = "network"
    else:
        kind = "other"
    return {
        "error": type(exc).__name__,
        "status": status,
        "message": str(exc)[:_MAX_MESSAGE],
        "kind": kind,
        "errno": code,
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
