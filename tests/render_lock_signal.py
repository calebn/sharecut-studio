from __future__ import annotations

import logging
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

_RENDER_LOCK_LOGGER = "podcast_mcp.util.project_state"
_RENDER_WAIT_TEMPLATE = "waiting for another render of %s"


class _RenderContentionHandler(logging.Handler):
    def __init__(self, workspace_path: Path, started: threading.Event) -> None:
        super().__init__(logging.INFO)
        self._workspace_path = str(workspace_path)
        self._started = started

    def emit(self, record: logging.LogRecord) -> None:
        if (
            record.name == _RENDER_LOCK_LOGGER
            and record.msg == _RENDER_WAIT_TEMPLATE
            and tuple(map(str, record.args)) == (self._workspace_path,)
        ):
            self._started.set()


@contextmanager
def render_contention_signal(workspace_path: Path) -> Iterator[threading.Event]:
    started = threading.Event()
    logger = logging.getLogger(_RENDER_LOCK_LOGGER)
    previous_level = logger.level
    handler = _RenderContentionHandler(workspace_path, started)
    logger.setLevel(logging.INFO)
    logger.addHandler(handler)
    try:
        yield started
    finally:
        logger.removeHandler(handler)
        logger.setLevel(previous_level)
