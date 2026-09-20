"""Audited subprocess helpers for FFmpeg/CLI wrappers.

Call sites must pass argv as a sequence (never a shell string). `shell=True`
is rejected. This concentrates Bandit B603/B404/B607 review on one module.
"""

from __future__ import annotations

import subprocess  # nosec B404
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

DEVNULL = subprocess.DEVNULL
PIPE = subprocess.PIPE
STDOUT = subprocess.STDOUT
CalledProcessError = subprocess.CalledProcessError
CompletedProcess = subprocess.CompletedProcess
TimeoutExpired = subprocess.TimeoutExpired
Popen = subprocess.Popen


def run(
    argv: Sequence[str | bytes | Path],
    *,
    check: bool = False,
    capture_output: bool = False,
    text: bool | None = None,
    input: str | bytes | None = None,
    cwd: str | Path | None = None,
    env: Mapping[str, str] | None = None,
    timeout: float | None = None,
    stdout: Any = None,
    stderr: Any = None,
    start_new_session: bool = False,
) -> subprocess.CompletedProcess[Any]:
    if not isinstance(argv, (list, tuple)):
        raise TypeError("argv must be a list or tuple (no shell strings)")
    if not argv:
        raise ValueError("argv must not be empty")
    cmd = [str(a) for a in argv]
    return subprocess.run(  # nosec B603
        cmd,
        check=check,
        capture_output=capture_output,
        text=text,
        input=input,
        cwd=cwd,
        env=env,
        timeout=timeout,
        stdout=stdout,
        stderr=stderr,
        start_new_session=start_new_session,
        shell=False,
    )


def popen(
    argv: Sequence[str | bytes | Path],
    *,
    stdout: Any = None,
    stderr: Any = None,
    cwd: str | Path | None = None,
    env: Mapping[str, str] | None = None,
    start_new_session: bool = False,
) -> subprocess.Popen[Any]:
    if not isinstance(argv, (list, tuple)):
        raise TypeError("argv must be a list or tuple (no shell strings)")
    if not argv:
        raise ValueError("argv must not be empty")
    cmd = [str(a) for a in argv]
    return subprocess.Popen(  # nosec B603
        cmd,
        stdout=stdout,
        stderr=stderr,
        cwd=cwd,
        env=env,
        start_new_session=start_new_session,
        shell=False,
    )
