from __future__ import annotations

import os
from pathlib import Path


def same_recording(first: Path, second: Path) -> bool:
    a = first.resolve()
    b = second.resolve()
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
