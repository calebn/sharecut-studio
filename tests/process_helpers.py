"""Shared cleanup for tests that spawn child processes."""

from __future__ import annotations

from multiprocessing.process import BaseProcess


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
