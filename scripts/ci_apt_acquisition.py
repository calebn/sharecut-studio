"""Bounded Ubuntu transport. Apt owns metadata authentication and object identity."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit


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
    http_status: int | None = None
    remote_ip: str | None = None

    def collect_network_fields(self) -> None:
        output, _ = self.process.communicate()
        fields = (output or b"").decode("ascii", errors="replace").split("\t")
        if len(fields) != 2:
            return
        if len(fields[0]) == 3 and fields[0].isdigit():
            self.http_status = int(fields[0])
        with suppress(ValueError):
            self.remote_ip = str(ipaddress.ip_address(fields[1].strip()))


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


def report(
    plan: FetchPlan,
    source: int,
    outcome: str,
    size: int,
    elapsed: float,
    budget: float,
    exit_code: int | None,
    attempt: Attempt,
) -> None:
    uri = urlsplit(plan.urls[source])
    print(
        json.dumps(
            {
                "host": uri.hostname,
                "path": uri.path,
                "source": source,
                "outcome": outcome,
                "bytes": size,
                "elapsed": round(elapsed, 3),
                "budget": budget,
                "curl_exit": exit_code,
                "http_status": attempt.http_status,
                "remote_ip": attempt.remote_ip,
                "kind": type(plan.identity).__name__,
            }
        ),
        file=sys.stderr,
        flush=True,
    )


@contextmanager
def defer_cancellation() -> Iterator[list[int]]:
    previous = {number: signal.getsignal(number) for number in (signal.SIGTERM, signal.SIGINT)}
    pending: list[int] = []

    def defer(number: int, _frame: object) -> None:
        if not pending:
            pending.append(number)

    try:
        for number in previous:
            signal.signal(number, defer)
        yield pending
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)
        if pending:
            signal.raise_signal(pending[0])


def acquire(plan: FetchPlan, destination: Path) -> Receipt:
    metadata = isinstance(plan.identity, AptSignedMetadata)
    maximum = (
        plan.identity.maximum_size
        if isinstance(plan.identity, AptSignedMetadata)
        else plan.identity.size
    )
    budget = plan.budgets.metadata_total if metadata else plan.budgets.object_total
    started = time.monotonic()
    attempts: list[Attempt] = []
    with (
        defer_cancellation() as pending,
        tempfile.TemporaryDirectory(prefix=".sharecut-apt-", dir=destination.parent) as directory,
    ):
        try:
            while (elapsed := time.monotonic() - started) < budget:
                if pending:
                    raise InterruptedError("Ubuntu acquisition cancelled")
                ready = (
                    not attempts or attempts[-1].examined
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
                            "--write-out",
                            "%{http_code}\t%{remote_ip}",
                            plan.urls[index],
                        ],
                        stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL,
                    )
                    attempts.append(Attempt(process, path))
                for index, attempt in enumerate(attempts):
                    if attempt.examined or attempt.process.poll() is None:
                        continue
                    attempt.examined = True
                    attempt.collect_network_fields()
                    if attempt.process.returncode != 0 or not attempt.path.is_file():
                        outcome = {
                            6: "dns-failure",
                            7: "connection-failure",
                            22: "http-failure",
                            28: "timeout-or-low-throughput",
                            60: "tls-failure",
                            63: "oversize",
                        }.get(attempt.process.returncode, "transport-failure")
                        size = attempt.path.stat().st_size if attempt.path.exists() else 0
                        report(
                            plan,
                            index,
                            outcome,
                            size,
                            time.monotonic() - started,
                            budget,
                            attempt.process.returncode,
                            attempt,
                        )
                        continue
                    size, sha256, sha512 = digests(attempt.path)
                    if isinstance(plan.identity, HashedObject):
                        valid = size == plan.identity.size and sha256 == plan.identity.sha256
                    else:
                        valid = 0 < size <= plan.identity.maximum_size
                    if valid:
                        if pending:
                            raise InterruptedError("Ubuntu acquisition cancelled")
                        report(
                            plan,
                            index,
                            "accepted",
                            size,
                            time.monotonic() - started,
                            budget,
                            attempt.process.returncode,
                            attempt,
                        )
                        os.replace(attempt.path, destination)
                        return Receipt(index, size, sha256, sha512, time.monotonic() - started)
                    report(
                        plan,
                        index,
                        "size-mismatch" if size != maximum else "hash-mismatch",
                        size,
                        time.monotonic() - started,
                        budget,
                        attempt.process.returncode,
                        attempt,
                    )
                if len(attempts) == 2 and all(a.process.poll() is not None for a in attempts):
                    break
                time.sleep(0.01)
            raise RuntimeError("Ubuntu acquisition failed or exceeded its operation deadline")
        finally:
            for attempt in attempts:
                if attempt.process.poll() is None:
                    attempt.process.terminate()
            for index, attempt in enumerate(attempts):
                try:
                    attempt.process.wait(timeout=0.25)
                except subprocess.TimeoutExpired:
                    attempt.process.kill()
                    attempt.process.wait()
                if not attempt.examined:
                    attempt.collect_network_fields()
                    size = attempt.path.stat().st_size if attempt.path.exists() else 0
                    report(
                        plan,
                        index,
                        "cancelled",
                        size,
                        time.monotonic() - started,
                        budget,
                        attempt.process.returncode,
                        attempt,
                    )
