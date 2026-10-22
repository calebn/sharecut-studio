"""Bounded Ubuntu transport. Apt owns metadata authentication and object identity."""

from __future__ import annotations

import hashlib
import os
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class HashedObject:
    size: int
    sha256: str


@dataclass(frozen=True)
class AptSignedMetadata:
    maximum_size: int


@dataclass(frozen=True)
class Budgets:
    connect: float = 5
    low_speed: int = 16384
    low_speed_seconds: int = 5
    hedge: float = 2
    object_total: float = 90
    metadata_attempt: float = 15
    metadata_total: float = 30


@dataclass(frozen=True)
class FetchPlan:
    identity: HashedObject | AptSignedMetadata
    urls: tuple[str, str]
    budgets: Budgets = Budgets()


@dataclass
class Attempt:
    process: subprocess.Popen[bytes]
    path: Path
    examined: bool = False


@dataclass(frozen=True)
class Receipt:
    source: int
    size: int
    sha256: str
    sha512: str
    elapsed: float


def digests(path: Path) -> tuple[int, str, str]:
    sha256, sha512 = hashlib.sha256(), hashlib.sha512()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            size += len(chunk)
            sha256.update(chunk)
            sha512.update(chunk)
    return size, sha256.hexdigest(), sha512.hexdigest()


def acquire(plan: FetchPlan, destination: Path) -> Receipt:
    metadata = isinstance(plan.identity, AptSignedMetadata)
    maximum = plan.identity.maximum_size if metadata else plan.identity.size
    budget = plan.budgets.metadata_total if metadata else plan.budgets.object_total
    started = time.monotonic()
    attempts: list[Attempt] = []
    with tempfile.TemporaryDirectory(prefix=".sharecut-apt-", dir=destination.parent) as directory:
        try:
            while (elapsed := time.monotonic() - started) < budget:
                ready = (
                    not attempts or attempts[-1].process.poll() is not None
                    if metadata
                    else elapsed >= len(attempts) * plan.budgets.hedge
                )
                if len(attempts) < 2 and ready:
                    index = len(attempts)
                    path = Path(directory) / str(index)
                    timeout = min(
                        budget - elapsed,
                        plan.budgets.metadata_attempt if metadata else budget,
                    )
                    process = subprocess.Popen(
                        [
                            "curl",
                            "--disable",
                            "--silent",
                            "--show-error",
                            "--fail",
                            "--proto",
                            "=https",
                            "--connect-timeout",
                            str(plan.budgets.connect),
                            "--max-time",
                            str(max(0.001, timeout)),
                            "--max-filesize",
                            str(max(1, maximum)),
                            "--speed-limit",
                            str(plan.budgets.low_speed),
                            "--speed-time",
                            str(plan.budgets.low_speed_seconds),
                            "--output",
                            str(path),
                            plan.urls[index],
                        ],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                    attempts.append(Attempt(process, path))
                for index, attempt in enumerate(attempts):
                    if attempt.examined or attempt.process.poll() is None:
                        continue
                    attempt.examined = True
                    if attempt.process.returncode != 0 or not attempt.path.is_file():
                        continue
                    size, sha256, sha512 = digests(attempt.path)
                    if isinstance(plan.identity, HashedObject):
                        valid = size == plan.identity.size and sha256 == plan.identity.sha256
                    else:
                        valid = 0 < size <= plan.identity.maximum_size
                    if valid:
                        os.replace(attempt.path, destination)
                        return Receipt(index, size, sha256, sha512, time.monotonic() - started)
                if len(attempts) == 2 and all(a.process.poll() is not None for a in attempts):
                    break
                time.sleep(0.01)
            raise RuntimeError("Ubuntu acquisition failed or exceeded its operation deadline")
        finally:
            for attempt in attempts:
                if attempt.process.poll() is None:
                    attempt.process.terminate()
            for attempt in attempts:
                try:
                    attempt.process.wait(timeout=0.25)
                except subprocess.TimeoutExpired:
                    attempt.process.kill()
                    attempt.process.wait()
