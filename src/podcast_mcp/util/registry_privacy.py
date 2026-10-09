from __future__ import annotations

import os
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

from podcast_mcp.util import registry_backup_posix, registry_backup_windows


@contextmanager
def registry_privacy(
    path: Path, names: tuple[str, ...], *, create: bool = False
) -> Iterator[Callable[[], None]]:
    native = registry_backup_windows if os.name == "nt" else registry_backup_posix
    with native.registry_scope(path, names, create=create) as verify:
        yield verify
