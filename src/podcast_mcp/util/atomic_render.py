"""Publish rendered cache artifacts without exposing partial output."""

from __future__ import annotations

import os
import uuid
from collections.abc import Callable
from pathlib import Path


def render_atomic(dest: Path, render: Callable[[Path], object]) -> Path:
    """Render to a unique sibling path and atomically replace ``dest`` on success."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f"{dest.stem}.{os.getpid()}.{uuid.uuid4().hex}.partial{dest.suffix}")
    try:
        render(tmp)
        os.replace(tmp, dest)
        return dest
    finally:
        tmp.unlink(missing_ok=True)
