"""Who is writing the history step being recorded.

Every entry carries the writer's name so a guest's Undo can be limited to what they
wrote. The value rides a ContextVar read once where an entry is built, so no mutation
call site passes it down. ``"host"`` is the default (the app's own person and the CLI).
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar

HOST_AUTHOR = "host"
AGENT_AUTHOR = "agent"
SYSTEM_AUTHOR = "system"
SHARE_AUTHOR_PREFIX = "share:"

_author: ContextVar[str] = ContextVar("history_author", default=HOST_AUTHOR)


def is_guest_author(author: str | None) -> bool:
    return author is not None and author.startswith(SHARE_AUTHOR_PREFIX)


def current_history_author() -> str:
    return _author.get()


@contextmanager
def history_author(author: str) -> Iterator[None]:
    token = _author.set(author)
    try:
        yield
    finally:
        _author.reset(token)


@contextmanager
def share_history_author(author: str | None) -> Iterator[None]:
    """Stamp a guest workspace's writes with its share, except a job's own ``system`` steps."""
    if author is None or _author.get() == SYSTEM_AUTHOR:
        yield
        return
    with history_author(author):
        yield
