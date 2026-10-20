"""Repo-relative path globs shared by the docs-sync gate and the CI planner.

Stdlib only, so CI runs both before installing anything.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


class GlobError(ValueError):
    """A glob is not a repo-relative POSIX pattern."""


@dataclass(frozen=True)
class Glob:
    """Repo-relative POSIX glob. ``**`` spans directories, ``*`` and ``?`` stay in one
    segment, a trailing ``/`` means everything below that directory. Full-match only."""

    text: str
    pattern: re.Pattern[str]

    @classmethod
    def parse(cls, text: str) -> Glob:
        if not text or text.startswith("/") or text.startswith("./") or "\\" in text:
            raise GlobError(
                f"invalid glob {text!r}: must be repo-relative, no leading /, ./ or backslash"
            )
        body = text + "**" if text.endswith("/") else text
        out: list[str] = []
        i, n = 0, len(body)
        while i < n:
            if body[i : i + 3] == "**/":
                out.append("(?:.*/)?")
                i += 3
            elif body[i : i + 2] == "**":
                out.append(".*")
                i += 2
            elif body[i] == "*":
                out.append("[^/]*")
                i += 1
            elif body[i] == "?":
                out.append("[^/]")
                i += 1
            else:
                out.append(re.escape(body[i]))
                i += 1
        return cls(text=text, pattern=re.compile("^" + "".join(out) + "$"))

    def matches(self, path: str) -> bool:
        return self.pattern.match(path) is not None
