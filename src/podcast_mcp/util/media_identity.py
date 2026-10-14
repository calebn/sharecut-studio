from __future__ import annotations

import os
from pathlib import Path

from podcast_mcp.util.batch_scope import scoped


def _resolved(path: Path) -> Path:
    return scoped(("resolve", str(path)), path.resolve)


def same_recording(first: Path, second: Path) -> bool:
    a = _resolved(first)
    b = _resolved(second)
    if a == b:
        return True
    try:
        first_stat = a.stat()
        second_stat = b.stat()
    except FileNotFoundError:
        return False
    if first_stat.st_ino == 0 or second_stat.st_ino == 0:
        raise ValueError("Distinct media paths have no usable physical file identity")
    return os.path.samestat(first_stat, second_stat)
