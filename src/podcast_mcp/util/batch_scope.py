"""Work shared by every step of one batch of edits, freed when the batch ends."""

from __future__ import annotations

import threading
from collections.abc import Callable, Hashable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Any, TypeVar

from podcast_mcp.util.fingerprint import file_stamp

T = TypeVar("T")
# A batch scope and a frozen block, either of which may be absent.
BatchState = tuple[dict[Hashable, Any] | None, dict[Hashable, Any] | None]
_scope: ContextVar[dict[Hashable, Any] | None] = ContextVar("batch_scope", default=None)
# Values that batches running at the same time share; the last batch to end frees them.
_shared: dict[Hashable, Any] = {}
_shared_lock = threading.Lock()
_open_batches = 0


@contextmanager
def batch_scope() -> Iterator[None]:
    """Compute each unchanging input once while a batch of edits runs.

    A batch such as Approve all proves every cut against the same stems and the same
    workspace. Inside the scope a repeat decode of an unchanged file, the level caches built
    from it, a repeat path resolution, and each recording's identity stat are the first
    one's, so the batch pays one pass per file, not one per edit. A nested scope shares the
    outer one. Everything is freed on exit, except what :func:`shared_while_batching` holds
    for a batch still running.
    """
    if _scope.get() is not None:
        yield
        return
    global _open_batches
    token = _scope.set({})
    with _shared_lock:
        _open_batches += 1
    try:
        yield
    finally:
        _scope.reset(token)
        with _shared_lock:
            _open_batches -= 1
            if not _open_batches:
                _shared.clear()


@contextmanager
def unscoped() -> Iterator[None]:
    """Run without the batch scope, so the scope keeps nothing created inside the block.

    Use this for work on a temporary file, because a cache entry keyed by the file's path
    would outlive the file.
    """
    token = _scope.set(None)
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


def shared_while_batching(key: Hashable, make: Callable[[], T]) -> T:
    """:func:`scoped`, but shared by batches running at once; the last to end frees it.

    For content-keyed work that an approval and its background warm would both build.
    """
    if _scope.get() is None:
        return make()
    with _shared_lock:
        if key not in _shared:
            _shared[key] = make()
        return _shared[key]


def scoped_by_file(kind: str, path: Path, extra: Hashable, make: Callable[[], T]) -> T:
    """:func:`scoped` keyed by the file's path, mtime and size, so a rewritten file misses."""
    if _scope.get() is None:
        return make()
    stamp = file_stamp(path)
    return scoped((kind, str(path), stamp.mtime_ns, stamp.size, extra), make)


def scoped_by_file_if_held(kind: str, path: Path, extra: Hashable) -> Any | None:
    """The scope's value that :func:`scoped_by_file` holds for these arguments, else ``None``.

    Never computes: a caller that can do without the value (it has a streaming path) takes
    what the batch already decoded and otherwise does its own work.
    """
    scope = _scope.get()
    if scope is None:
        return None
    try:
        stamp = file_stamp(path)
    except OSError:
        return None
    return scope.get((kind, str(path), stamp.mtime_ns, stamp.size, extra))


_frozen: ContextVar[dict[Hashable, Any] | None] = ContextVar("frozen_state", default=None)


@contextmanager
def frozen_state() -> Iterator[None]:
    """Reads of project state inside this block may be shared; the caller promises not to mutate it.

    Proving one cut reads the same stems dozens of times before anything changes, and
    each read fingerprints a track whose clips have not moved. A block that only reads the
    project lets those repeats share the first result; leaving the block drops them, so the
    next mutation is never read through a stale entry. A nested block shares the outer one.
    """
    if _frozen.get() is not None:
        yield
        return
    token = _frozen.set({})
    try:
        yield
    finally:
        _frozen.reset(token)


def frozen(key: Hashable, make: Callable[[], T], *, keep: object = None) -> T:
    """``make()``, or this read-only block's earlier result for ``key``. Outside a block, ``make()``.

    ``keep`` is held with the result so an object whose ``id`` is in ``key`` cannot be freed
    and have its id reused while the entry lives.
    """
    block = _frozen.get()
    if block is None:
        return make()
    if key not in block:
        block[key] = (keep, make())
    return block[key][1]


@contextmanager
def carried(state: BatchState) -> Iterator[None]:
    """Run a worker thread inside the caller's batch scope and frozen block.

    A thread pool starts its threads in an empty context, so without this the pool's work
    would pay for every decode and path resolution the caller's scope already shares.
    """
    scope, block = state
    scope_token = _scope.set(scope) if scope is not None else None
    frozen_token = _frozen.set(block) if block is not None else None
    try:
        yield
    finally:
        if frozen_token is not None:
            _frozen.reset(frozen_token)
        if scope_token is not None:
            _scope.reset(scope_token)


def snapshot() -> BatchState:
    """The caller's current batch scope and frozen block, for :func:`carried`."""
    return _scope.get(), _frozen.get()
