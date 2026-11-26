"""Where an uploaded ``.sharecutseg`` waits, checked, until the person adds or cancels it.

``<library>/.staging/<token>.sharecutseg`` is the zip itself; a clip played in the preview is
copied beside it on first request. A token is 32 lowercase hex characters and is checked
before any path is built from it. Nothing here touches the library proper.
"""

from __future__ import annotations

import os
import re
import secrets
import tempfile
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from podcast_mcp.segments import bundle
from podcast_mcp.segments.bundle import MAX_BUNDLE_BYTES, staged_clip
from podcast_mcp.segments.store import SegmentStore
from podcast_mcp.util.coded_error import CodedValueError

STAGING_DIRNAME = ".staging"
SUFFIX = ".sharecutseg"
PARTIAL_SUFFIX = ".partial"
MAX_STAGED = 4
STAGED_TTL_SEC = 3600.0
# The zip, its checked unpack and the copy the library keeps.
_ROOM_FACTOR = 3
_TOKEN = re.compile(r"[0-9a-f]{32}")
_CLAIM_PREFIX = ".claim-"


_BEGIN = threading.Lock()


@dataclass(frozen=True)
class Upload:
    token: str
    partial: Path


def bundle_no_room() -> CodedValueError:
    return CodedValueError(
        "There is not enough free disk space to check this file.", code="segment_no_room"
    )


def _unknown() -> CodedValueError:
    return CodedValueError(
        "This import is no longer waiting. Choose the file again.", code="segment_import_unknown"
    )


class ImportStaging:
    def __init__(self, store: SegmentStore) -> None:
        self.directory = store.directory / STAGING_DIRNAME

    def _ensure(self) -> None:
        try:
            self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(self.directory, 0o700)
        except OSError as exc:
            raise CodedValueError(
                f"The import folder {self.directory} cannot be opened: {exc.strerror or exc}.",
                code="segment_write_failed",
            ) from exc

    def sweep(self, now: float | None = None) -> None:
        """Remove everything older than the expiry (abandoned tabs, crashed uploads)."""
        cutoff = (time.time() if now is None else now) - STAGED_TTL_SEC
        if not self.directory.is_dir():
            return
        for entry in self.directory.iterdir():
            try:
                if entry.stat().st_mtime < cutoff:
                    entry.unlink()
            except OSError:
                continue

    def _waiting(self) -> list[Path]:
        """Staged files and uploads in progress, oldest first."""
        aged: list[tuple[float, Path]] = []
        for entry in self.directory.iterdir():
            if not entry.name.endswith((SUFFIX, PARTIAL_SUFFIX)):
                continue
            try:
                aged.append((entry.stat().st_mtime, entry))
            except FileNotFoundError:
                continue
        return [entry for _, entry in sorted(aged, key=lambda pair: pair[0])]

    def begin(self, declared_bytes: int | None) -> Upload:
        """Make room for one upload and create its partial file, under one lock.

        When every slot is taken the oldest staged file goes, so abandoned previews never
        lock the person out. Raises ``segment_staging_full`` only when every slot is an
        upload still in progress, and ``segment_no_room`` for a file the disk cannot take.
        """
        self._ensure()
        needed = _ROOM_FACTOR * min(declared_bytes or 0, MAX_BUNDLE_BYTES)
        if needed and bundle.free_bytes(self.directory) < needed:
            raise bundle_no_room()
        with _BEGIN:
            self.sweep()
            waiting = self._waiting()
            while len(waiting) >= MAX_STAGED:
                oldest = next((entry for entry in waiting if entry.name.endswith(SUFFIX)), None)
                if oldest is None:
                    raise CodedValueError(
                        "Other files are still uploading. Try again in a moment.",
                        code="segment_staging_full",
                    )
                self.discard(oldest.name.removesuffix(SUFFIX))
                waiting = self._waiting()
            token = secrets.token_hex(16)
            partial = self.directory / f"{token}{PARTIAL_SUFFIX}"
            os.close(os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
        return Upload(token, partial)

    def ensure_room(self, received: int) -> None:
        """Raise ``segment_no_room`` once the bytes received so far leave too little for the unpack and the add."""
        if bundle.free_bytes(self.directory) < (_ROOM_FACTOR - 1) * received:
            raise bundle_no_room()

    def open_partial(self, upload: Upload) -> BinaryIO:
        return os.fdopen(os.open(upload.partial, os.O_WRONLY | os.O_TRUNC), "wb")

    def finish(self, upload: Upload) -> None:
        os.replace(upload.partial, self._path(upload.token))

    def drop_partial(self, upload: Upload) -> None:
        upload.partial.unlink(missing_ok=True)

    def _path(self, token: str) -> Path:
        if not _TOKEN.fullmatch(token):
            raise _unknown()
        return self.directory / f"{token}{SUFFIX}"

    def path(self, token: str) -> Path:
        """The staged file for ``token``. Raises ``segment_import_unknown``."""
        path = self._path(token)
        if not path.is_file() or path.is_symlink():
            raise _unknown()
        return path

    def clip(self, token: str, index: int) -> Path:
        """Clip ``index`` of the staged bundle as its own file (copied once)."""
        source = self.path(token)
        dest = self.directory / f"{token}.clip-{index}.flac"
        if dest.is_file():
            return dest
        handle, name = tempfile.mkstemp(prefix=".clip-", dir=self.directory)
        os.close(handle)
        temp = Path(name)
        try:
            staged_clip(source, index, temp)
            os.replace(temp, dest)
        finally:
            temp.unlink(missing_ok=True)
        return dest

    def committing(self, token: str) -> bool:
        return (
            bool(_TOKEN.fullmatch(token)) and (self.directory / f"{_CLAIM_PREFIX}{token}").exists()
        )

    @contextmanager
    def claim(self, token: str) -> Iterator[Path]:
        """Take the staged file for one commit. A second commit finds it gone.

        The file is removed when the block ends. When the library is busy it is put back so
        the person can try again without uploading twice; any other failure (a file that does
        not verify) removes it, so a bad file does not keep its slot.
        """
        source = self.path(token)
        claimed = self.directory / f"{_CLAIM_PREFIX}{token}"
        try:
            os.rename(source, claimed)
            os.utime(claimed)
        except OSError:
            raise _unknown() from None
        try:
            yield claimed
        except CodedValueError as exc:
            if exc.code == "segment_busy":
                os.replace(claimed, source)
            else:
                claimed.unlink(missing_ok=True)
                self.discard(token)
            raise
        except BaseException:
            claimed.unlink(missing_ok=True)
            self.discard(token)
            raise
        claimed.unlink(missing_ok=True)
        self.discard(token)

    def discard(self, token: str) -> None:
        """Remove a staged file and its clip copies. An unknown token is not an error."""
        if not _TOKEN.fullmatch(token) or not self.directory.is_dir():
            return
        for entry in self.directory.glob(f"{token}*"):
            entry.unlink(missing_ok=True)
