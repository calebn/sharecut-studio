from __future__ import annotations

import re

from podcast_mcp.engines.ffmpeg import runtime

# Match on ``\n`` only, never ``str.splitlines()``, which also breaks on U+2028.
_FILTER_LOG_LINE_RE = re.compile(r"^\[Parsed_(\w+?)_\d+ @ ([^\]\n]*)\] ?([^\n]*)", re.MULTILINE)
_EMPTY_OUTPUT_RE = re.compile(r"^\[out#\d+/null @ [^\]\n]*\] Output file is empty", re.MULTILINE)


def filter_log_text(stderr: str | bytes | None, filter_name: str) -> str:
    """Payloads of the stderr lines ``filter_name`` itself printed, newline-joined.

    Only lines from the instance that printed last (its ``@ <addr>``) count: the real filter logs
    after the metadata dump, and a forged line in a raw-printed tag key cannot know its address.
    """
    lines = [
        m for m in _FILTER_LOG_LINE_RE.finditer(runtime._stderr_text(stderr)) if m[1] == filter_name
    ]
    return "\n".join(m[3] for m in lines if m[2] == lines[-1][2]) if lines else ""


def decoded_no_frames(stderr: str | bytes | None) -> bool:
    return _EMPTY_OUTPUT_RE.search(runtime._stderr_text(stderr)) is not None
