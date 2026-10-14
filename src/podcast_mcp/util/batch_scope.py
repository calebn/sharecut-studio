"""Work shared by every step of one batch of edits, freed when the batch ends."""

from __future__ import annotations

from collections.abc import Callable, Hashable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Any, TypeVar

T = TypeVar("T")
_scope: ContextVar[dict[Hashable, Any] | None] = ContextVar("batch_scope", default=None)


@contextmanager
def batch_scope() -> Iterator[None]:
    """Compute each unchanging input once while a batch of edits runs.

    A batch such as Approve all proves every cut against the same stems and the same
    workspace. Inside the scope a repeat decode of an unchanged file, the level caches built
    from it, and a repeat path resolution are the first one's, so the batch pays one pass
    per file, not one per edit. A nested scope shares the outer one. Everything is freed on
    exit.
    """
    if _scope.get() is not None:
        yield
        return
    token = _scope.set({})
    try:
        yield
    finally:
        _scope.reset(token)


def scoped(key: Hashable, make: Callable[[], T]) -> T:
    """``make()``, or the scope's earlier result for ``key``. Outside a scope, ``make()``."""
    scope = _scope.get()
    if scope is None:
        return make()
    if key not in scope:
        scope[key] = make()
    return scope[key]


def scoped_by_file(kind: str, path: Path, extra: Hashable, make: Callable[[], T]) -> T:
    """:func:`scoped` keyed by the file's path, mtime and size, so a rewritten file misses."""
    if _scope.get() is None:
        return make()
    stat = path.stat()
    return scoped((kind, str(path), stat.st_mtime_ns, stat.st_size, extra), make)
