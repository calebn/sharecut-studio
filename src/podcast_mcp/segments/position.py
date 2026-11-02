"""Where on the timeline a segment goes: ``start``, ``end`` or a number of seconds.

The one parser for the CLI ``--at``, the MCP ``at`` and the ``InsertSegment`` payload, so
all three accept and refuse the same text.
"""

from __future__ import annotations

import math
from typing import Literal

from podcast_mcp.util.coded_error import CodedValueError

Position = float | Literal["start", "end"]


def _refuse(at: object) -> CodedValueError:
    return CodedValueError(
        f"{at!r} is not a position. Use start, end or a number of seconds.",
        code="segment_position_out_of_range",
    )


def parse_position(at: object) -> Position:
    """``at`` as ``"start"``, ``"end"`` or finite seconds (not checked against a timeline).

    Words are matched ignoring case and surrounding space. Text that is not a plain decimal
    number (``1_0``, ``0x10``), a bool, a non-finite number or any other type raises
    ``segment_position_out_of_range``.
    """
    if isinstance(at, bool) or not isinstance(at, str | int | float):
        raise _refuse(at)
    if isinstance(at, str):
        word = at.strip().casefold()
        if word in ("start", "end"):
            return "start" if word == "start" else "end"
        if "_" in word:
            raise _refuse(at)
        try:
            seconds = float(word)
        except ValueError:
            raise _refuse(at) from None
    else:
        try:
            seconds = float(at)
        except OverflowError:
            raise _refuse(at) from None
    if not math.isfinite(seconds):
        raise _refuse(at)
    return seconds
