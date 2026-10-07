"""Publish rendered cache artifacts without exposing partial output."""

from __future__ import annotations

import os
import re
import uuid
from collections.abc import Callable, Sequence
from pathlib import Path

from podcast_mcp.util.atomic_file import publish_completed_file


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
    tmp = _partial_path(dest)
    try:
        render(tmp)
        return publish_completed_file(tmp, dest, before_replace=before_replace)
    finally:
        tmp.unlink(missing_ok=True)


def render_atomic_all(
    dests: Sequence[Path],
    render: Callable[[list[Path]], object],
    *,
    before_publish: Callable[[], object] | None = None,
    reap_partials: bool = False,
) -> list[Path]:
    """Render every ``dests[i]`` to its own temp; replace them only once all are rendered.

    ``render`` receives the temps in ``dests`` order. If it (or ``before_publish``, run
    once before the first replace) raises, every ``dest`` keeps its previous contents and
    no temp is left behind. ``reap_partials`` as in ``render_atomic``.
    """
    for dest in dests:
        dest.parent.mkdir(parents=True, exist_ok=True)
        if reap_partials:
            remove_partials(dest)
    temps = [_partial_path(dest) for dest in dests]
    try:
        render(temps)
        if before_publish is not None:
            before_publish()
        return [publish_completed_file(tmp, dest) for tmp, dest in zip(temps, dests, strict=True)]
    finally:
        for tmp in temps:
            tmp.unlink(missing_ok=True)


def _partial_path(dest: Path) -> Path:
    return dest.with_name(f"{dest.stem}.{os.getpid()}.{uuid.uuid4().hex}.partial{dest.suffix}")
