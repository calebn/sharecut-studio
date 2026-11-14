"""Run the release's child processes. ``spawn`` is the only place a ``Secret`` is revealed.

A ``Command`` is data: argv, working directory, the whole child environment (nothing is
inherited) and private files written for the run. ``display`` renders it with secrets as tokens, so
the dry run prints exactly what ``spawn`` would execute. ``capture`` runs a read-only tool with a
plain-string argv and no secrets.
"""

from __future__ import annotations

import codecs
import os
import shlex
import subprocess
from collections import deque
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import TextIO

from scripts.ios.release_secrets import Redactor, Secret

Part = str | Secret
QUIET_ENV = frozenset({"PATH", "HOME", "TMPDIR", "LANG"})
TAIL_LINES = 40
NOT_FOUND = 127
OUTPUT_LIMIT = 1 << 20


@dataclass(frozen=True)
class PrivateFile:
    """A file made just for one command, mode 0600, removed when it ends. Its text may hold
    secrets: ``parts`` are joined, the secrets revealed only inside ``spawn``."""

    path: Path
    parts: tuple[Part, ...]


@dataclass(frozen=True)
class Command:
    argv: tuple[Part, ...]
    cwd: Path
    env: Mapping[str, Part] = field(default_factory=dict)
    files: tuple[PrivateFile, ...] = ()

    def display(self, redactor: Redactor) -> str:
        shown = [
            f"{name}={_shell(value)}" for name, value in self.env.items() if name not in QUIET_ENV
        ]
        line = " ".join([*shown, *(_shell(part) for part in self.argv)])
        return redactor.redact(f"(cd {shlex.quote(str(self.cwd))} && {line})")


def _shell(part: Part) -> str:
    return str(part) if isinstance(part, Secret) else shlex.quote(part)


@dataclass(frozen=True)
class SpawnResult:
    """The exit code, the last lines and the whole output (its last mebibyte), all redacted."""

    exit_code: int
    tail: str
    output: str = ""


def spawn(command: Command, redactor: Redactor, log: Path | None = None) -> SpawnResult:
    """Run *command* with exactly its environment. Output is redacted as it arrives, written to
    *log* (mode 0600) and kept as a redacted tail for the failure classifier."""
    argv = [part if isinstance(part, str) else part.reveal() for part in command.argv]
    env = {k: v if isinstance(v, str) else v.reveal() for k, v in command.env.items()}
    written: list[Path] = []
    sink = _open_log(log)
    lines: deque[str] = deque(maxlen=TAIL_LINES)
    chunks: list[str] = []
    stream = redactor.stream()
    decoder = codecs.getincrementaldecoder("utf-8")("replace")

    def take(text: str) -> None:
        if sink is not None:
            sink.write(text)
        lines.extend(text.splitlines())
        chunks.append(text)

    def result(code: int) -> SpawnResult:
        return SpawnResult(code, "\n".join(lines), "".join(chunks)[-OUTPUT_LIMIT:])

    try:
        for private in command.files:
            _write_private(
                private.path,
                "".join(p if isinstance(p, str) else p.reveal() for p in private.parts),
            )
            written.append(private.path)
        try:
            process = subprocess.Popen(
                argv,
                cwd=command.cwd,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            )
        except OSError as error:
            take(redactor.exception_line(error) + "\n")
            return result(NOT_FOUND)
        assert process.stdout is not None
        while chunk := os.read(process.stdout.fileno(), 65536):
            take(stream.feed(decoder.decode(chunk)))
        take(stream.feed(decoder.decode(b"", final=True)) + stream.finish())
        return result(process.wait())
    finally:
        for path in written:
            path.unlink(missing_ok=True)
        if sink is not None:
            sink.close()


def _write_private(path: Path, text: str) -> None:
    """A fresh mode 0600 file. A stale file or planted link at *path* is removed first, never
    followed, and the create refuses to reuse anything that appears in between."""
    path.unlink(missing_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(text)


def _open_log(log: Path | None) -> TextIO | None:
    """Append to *log*, refusing a planted link and tightening an older file to mode 0600."""
    if log is None:
        return None
    log.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    os.fchmod(descriptor, 0o600)
    return os.fdopen(descriptor, "a", encoding="utf-8")


def capture(argv: Sequence[str], *, cwd: Path | None = None, path: str | None = None) -> str:
    """stdout of a read-only tool (git, codesign, nm, security cms); raises on a non-zero exit."""
    environment = {"PATH": path or os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "en_US.UTF-8"}
    done = subprocess.run(
        list(argv), cwd=cwd, env=environment, capture_output=True, text=True, check=False
    )
    if done.returncode != 0:
        raise ToolFailed(
            f"{Path(argv[0]).name} exited {done.returncode}: {done.stderr.strip()[:300]}"
        )
    return done.stdout


class ToolFailed(RuntimeError):
    pass
