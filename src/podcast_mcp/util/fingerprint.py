"""One stat-based file stamp, so each cache key says which part of it it keeps (#1946).

A stamp answers "is this the same file contents-wise?" from ``stat`` alone: cheap, but a
copy that preserves size and mtime is invisible to it. Where that matters the key is a
render's ``.hash`` sidecar or a content hash instead (``docs/pipeline.md``,
"Revision schemes"). Each site that keys on a stamp projects the parts it has always kept,
so adopting the stamp changes no invalidation.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import NamedTuple


class FileStamp(NamedTuple):
    dev: int
    ino: int
    size: int
    mtime_ns: int
    ctime_ns: int

    @property
    def revision(self) -> tuple[int, int, int, int]:
        """Identity of a file that may be atomically replaced: device, inode, size, mtime."""
        return self.dev, self.ino, self.size, self.mtime_ns

    @property
    def content(self) -> tuple[int, int]:
        """Size and mtime: what a path-keyed cache needs to see a rewritten file."""
        return self.size, self.mtime_ns


def file_stamp(source: Path | os.stat_result) -> FileStamp:
    """The stamp of ``source``: a path (stat'd, following symlinks) or a stat result."""
    stat = source if isinstance(source, os.stat_result) else source.stat()
    return FileStamp(stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)


def mtime_ns_if_file(path: Path) -> int:
    """``path``'s mtime in ns, or 0 when it is not a file (a missing input keys as 0)."""
    return file_stamp(path).mtime_ns if path.is_file() else 0
