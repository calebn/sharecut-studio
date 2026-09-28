"""Pinned per-file sha256 manifests for downloaded model snapshots (#728).

A pinned Hugging Face snapshot (the Whisper catalog in ``whisper_models.py``, the
forced aligner in ``word_aligner_models.py``) lists every file it downloads with the
sha256 of its bytes at the pinned revision. Bootstrap and load verify the whole
manifest uncached. Status checks (Pipeline badges, bootstrap status, doctor) pass
``memoize=True``, which hashes each file once per process per (resolved path, size,
mtime_ns), whether it matches or not.

How pins are obtained: LFS files (weights) use the hub's LFS sha256 from
``HfApi().model_info(repo, revision=<pin>, files_metadata=True)``. Small non-LFS files
are the sha256 of the bytes at the pinned revision, whose git blob id and size matched
that call's ``blob_id`` / ``size``.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from podcast_mcp.util.hashing import sha256_file

FileManifest = tuple[tuple[str, str], ...]
"""(path relative to the snapshot root, sha256 hex) for every pinned file."""


@dataclass(frozen=True)
class PinnedSnapshot:
    """A Hugging Face repo at a commit plus the sha256 of every file taken from it."""

    hf_repo: str
    revision: str
    file_sha256: FileManifest

    @property
    def allow_patterns(self) -> list[str]:
        """Exactly the manifest's files, so a download never fetches an unverified file."""
        return manifest_files(self.file_sha256)


def manifest_files(manifest: FileManifest) -> list[str]:
    return [name for name, _ in manifest]


def missing_files(root: Path, manifest: FileManifest) -> list[str]:
    return [name for name, _ in manifest if not (root / name).is_file()]


def manifest_mismatch(root: Path, manifest: FileManifest, *, memoize: bool = False) -> str | None:
    """Why ``root`` is not the pinned snapshot (first missing or differing file), or None.

    ``memoize`` is for status polls only. Bootstrap and load pass False so a rewrite that
    keeps size and mtime is still caught before the files are used. An ``OSError`` (file
    vanished mid-check) propagates and is never remembered.
    """
    for name, expected in manifest:
        path = root / name
        if not path.is_file():
            return f"{name} is missing"
        digest = _memoized_sha256(path) if memoize else sha256_file(path)
        if digest != expected:
            return f"{name} sha256 {digest[:12]} does not match the pin"
    return None


# Serialises memoised hashing so overlapping status polls hash a file once, not once each.
_MEMO_LOCK = threading.Lock()


@lru_cache(maxsize=64)
def _sha256_for(resolved: str, size: int, mtime_ns: int) -> str:
    return sha256_file(Path(resolved))


def _memoized_sha256(path: Path) -> str:
    resolved = path.resolve()
    st = resolved.stat()
    with _MEMO_LOCK:
        return _sha256_for(str(resolved), st.st_size, st.st_mtime_ns)


def clear_manifest_memo() -> None:
    """Forget remembered digests (tests)."""
    _sha256_for.cache_clear()
