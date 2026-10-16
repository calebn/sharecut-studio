"""Shared cleanup for tests that spawn child processes."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from multiprocessing.process import BaseProcess
from multiprocessing.synchronize import Event
from unittest.mock import patch

from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.file_locks import shared_file_lock
from podcast_mcp.util.project_state import project_commit_lock_path


@contextmanager
def observe_failed_commit_lock_attempt(project: EpisodeProject, observed: Event) -> Iterator[None]:
    lock = shared_file_lock(project_commit_lock_path(project))
    original = lock._acquire_with_fork_tracking

    def attempt() -> None:
        original()
        if not lock.is_locked:
            observed.set()

    with patch.object(lock, "_acquire_with_fork_tracking", attempt):
        yield


def reap(proc: BaseProcess, timeout: float) -> bool:
    """Join ``proc``; kill and reap it if it still runs after ``timeout``.

    Returns True when it exited on its own. A child killed here exits with SIGKILL's code
    (TerminateProcess on win32), so a test that expects a killed child asserts this result,
    not only the exit code. A child stuck holding the project lock or a ``document.db``
    handle must not outlive its test.
    """
    proc.join(timeout)
    if not proc.is_alive():
        return True
    proc.kill()
    proc.join()
    return False
