"""A process-wide revision of transcript words, for memoizing derived values (#729).

Words are edited in place (``w.suspect_hallucination = True``, ``tr.words[i] = ...``),
so object identity cannot key a memo. ``TranscriptWord.__setattr__`` and every mutator
of ``TranscriptWords`` (``models.episode``) call :func:`bump_words_revision` after the
change; a memo stamped with :func:`words_revision` read *before* computing is valid only
while the revision is unchanged. In-memory only: never persisted, restarts per process.
"""

from __future__ import annotations

import functools
import itertools
from collections.abc import Callable
from typing import Any

_counter = itertools.count(1)
_revision = 0


def words_revision() -> int:
    """The current revision; any in-place transcript words change moves it."""
    return _revision


def bump_words_revision() -> None:
    """Advance the revision. Call after the change, never before it (a reader stamps first).

    Lock-free: ``next`` on an ``itertools.count`` is atomic, so every bump stores a value
    no other bump stores. Two racing bumps may store theirs out of order, but a stamp
    matches only the single interval its value was current, never after a later bump.
    """
    global _revision
    _revision = next(_counter)


def bumps_words_revision(method: Callable[..., Any]) -> Any:
    """Wrap a ``list`` method so it bumps the revision after it runs.

    Typed ``Any`` on purpose: assigning the wrapper as a class attribute keeps ``list``'s own
    signatures for callers (``+=`` still returns the subclass: ``list.__iadd__`` returns self).
    """

    @functools.wraps(method)
    def wrapper(self: list[Any], /, *args: Any, **kwargs: Any) -> Any:
        result = method(self, *args, **kwargs)
        bump_words_revision()
        return result

    return wrapper
