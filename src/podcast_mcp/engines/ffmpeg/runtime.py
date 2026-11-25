from __future__ import annotations

import re
import tempfile
from collections.abc import Callable
from typing import IO

from podcast_mcp.engines.render_clock import spawn_or_too_long
from podcast_mcp.util.binaries import resolve_ffmpeg as resolve_ffmpeg
from podcast_mcp.util.binaries import resolve_ffmpeg_pair as resolve_ffmpeg_pair
from podcast_mcp.util.process import (
    DEVNULL,
    CalledProcessError,
    TimeoutExpired,
    popen,
)
from podcast_mcp.util.process import run as run
from podcast_mcp.util.progress import raise_if_cancel_requested

# Bytes of ffmpeg stderr kept for a failed decode's error message.
PCM_STDERR_TAIL_BYTES = 2048
CANCEL_POLL_SEC = 0.1
ENCODE_CANCELLED = "Encoding cancelled"

_PROGRESS_TIME_RE = re.compile(r"^out_time_(?:us|ms)=(\d+)$")  # both are microseconds


def _progress_seconds(line: str) -> float | None:
    m = _PROGRESS_TIME_RE.match(line.strip())
    return int(m.group(1)) / 1_000_000 if m else None


_ANSI_SGR_RE = re.compile(r"\x1b\[[0-9;]*m")


def _stderr_text(stderr: str | bytes | None) -> str:
    """ffmpeg stderr as text with ``\n`` line ends; undecodable tag bytes become U+FFFD."""
    if isinstance(stderr, bytes):
        stderr = stderr.decode("utf-8", "replace")
    return _ANSI_SGR_RE.sub("", stderr or "").replace("\r\n", "\n").replace("\r", "\n")


def _run_cancellable(cmd: list[str], cancel_check: Callable[[], bool]) -> None:
    """Run ``cmd``; kill it and raise ``CancelledProgress`` once ``cancel_check()`` is true.

    A nonzero exit after a cancel was requested is the cancel too, not a failure: the
    child may have been stopped by the same interrupt (#1164).
    """
    with (
        tempfile.TemporaryFile() as err,
        spawn_or_too_long(popen, cmd, stdout=DEVNULL, stderr=err) as proc,
    ):
        try:
            while True:
                try:
                    rc = proc.wait(timeout=CANCEL_POLL_SEC)
                    break
                except TimeoutExpired:
                    raise_if_cancel_requested(cancel_check, ENCODE_CANCELLED)
        except BaseException:
            proc.kill()
            proc.wait()
            raise
        if rc != 0:
            raise_if_cancel_requested(cancel_check, ENCODE_CANCELLED)
            err.seek(0)
            raise CalledProcessError(rc, cmd, stderr=err.read())


def _pcm_decode_error(code: int, timed_out: bool, timeout_sec: float, err: IO[bytes]) -> str:
    """``RuntimeError`` text for a failed PCM decode: exit code, watchdog, stderr tail."""
    msg = f"ffmpeg PCM decode failed (exit {code})"
    if timed_out:
        msg += f"; killed by the {timeout_sec:g} s watchdog"
    err.seek(0, 2)
    err.seek(max(0, err.tell() - PCM_STDERR_TAIL_BYTES))
    tail = err.read().decode("utf-8", "replace").strip()
    return f"{msg}: {tail}" if tail else msg
