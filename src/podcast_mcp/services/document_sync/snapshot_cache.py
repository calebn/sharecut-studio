from __future__ import annotations

import hashlib
import json
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from threading import RLock
from typing import Any

FileCertificate = tuple[int, int, int, int, int]


def file_certificate(path: Path) -> FileCertificate | None:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


@dataclass(frozen=True)
class SnapshotKey:
    path: str
    revision: FileCertificate | None
    head: int
    projection: str
    dependencies: tuple[tuple[str, FileCertificate | str | None], ...]


def state_token(key: SnapshotKey) -> str:
    data = (key.revision, key.head, key.dependencies)
    return hashlib.sha256(json.dumps(data, separators=(",", ":")).encode()).hexdigest()


class SnapshotCache:
    def __init__(self, *, entries: int = 4, bytes_limit: int = 16 * 1024 * 1024) -> None:
        self._entries = entries
        self._bytes_limit = bytes_limit
        self._data: OrderedDict[SnapshotKey, bytes] = OrderedDict()
        self._bytes = 0
        self._lock = RLock()

    def get(self, key: SnapshotKey) -> dict[str, Any] | None:
        with self._lock:
            encoded = self._data.get(key)
            if encoded is None:
                return None
            self._data.move_to_end(key)
        value: dict[str, Any] = json.loads(encoded)
        return value

    def put(self, key: SnapshotKey, snapshot: dict[str, Any]) -> bool:
        encoded = json.dumps(snapshot, separators=(",", ":")).encode()
        if key.revision is None or len(encoded) > self._bytes_limit:
            return False
        with self._lock:
            for old in list(self._data):
                if (old.path, old.projection) == (key.path, key.projection):
                    self._bytes -= len(self._data.pop(old))
            self._data[key] = encoded
            self._bytes += len(encoded)
            while len(self._data) > self._entries or self._bytes > self._bytes_limit:
                _, removed = self._data.popitem(last=False)
                self._bytes -= len(removed)
        return True


snapshot_cache = SnapshotCache()
