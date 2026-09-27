"""Publish rendered cache artifacts without exposing partial output."""

from __future__ import annotations

import os
import re
import uuid
from collections.abc import Callable
from pathlib import Path


def remove_partials(dest: Path) -> int:
    """Delete ``render_atomic`` temps of ``dest`` (``<stem>.<pid>.<hex>.partial<suffix>``).

    Only safe while holding the lock that serializes every writer of ``dest``
    (``render_lock`` for stems, premix and master): a live writer's temp matches too.
    """
    if not dest.parent.is_dir():
        return 0
    pattern = re.compile(
        rf"{re.escape(dest.stem)}\.\d+\.[0-9a-f]{{32}}\.partial{re.escape(dest.suffix)}"
    )
    removed = 0
    for path in dest.parent.iterdir():
        if pattern.fullmatch(path.name):
            path.unlink(missing_ok=True)
            removed += 1
    return removed


def render_atomic(
    dest: Path,
    render: Callable[[Path], object],
    *,
    before_replace: Callable[[], object] | None = None,
    reap_partials: bool = False,
) -> Path:
    """Render to a unique sibling path and atomically replace ``dest`` on success.

    ``before_replace`` runs after a successful render, right before the swap (a stem
    drops its hash there so no reader pairs the old hash with the new bytes).
    ``reap_partials`` first deletes temps a crashed writer of ``dest`` left (see
    ``remove_partials``; only under the writers' lock).
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    if reap_partials:
        remove_partials(dest)
    tmp = dest.with_name(f"{dest.stem}.{os.getpid()}.{uuid.uuid4().hex}.partial{dest.suffix}")
    try:
        render(tmp)
        if before_replace is not None:
            before_replace()
        os.replace(tmp, dest)
        return dest
    finally:
        tmp.unlink(missing_ok=True)
