"""Pinned per-file sha256 manifests for downloaded model snapshots (#728).

A pinned Hugging Face snapshot (the Whisper catalog in ``whisper_models.py``, the
forced aligner in ``word_aligner_models.py``) lists every file it downloads with the
sha256 of its bytes at the pinned revision. Bootstrap and load verify the whole
manifest uncached. Status checks (Pipeline badges, bootstrap status, the catalog picker,
doctor) pass ``memoize=True``, which hashes each file once per process per (resolved path,
size, mtime_ns), whether it matches or not. The pre-run gate and bootstrap's skip check
hash uncached.

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
from podcast_mcp.util.keyed_lock import KeyedLocks

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


class PinnedSnapshotMissingError(FileNotFoundError):
    """No complete local copy of a pinned snapshot: never downloaded, partial, or unreadable."""

    def __init__(self, detail: str = "") -> None:
        self.detail = detail
        super().__init__(detail or "not downloaded")


def resolve_pinned_snapshot(pin: PinnedSnapshot, cache_dir: Path) -> Path:
    """The complete local snapshot for ``pin`` under ``cache_dir``; never downloads.

    Raises ``PinnedSnapshotMissingError`` when it is not downloaded, lacks a pinned file
    (``detail="partial download"``), or huggingface_hub cannot read the local cache. Every
    hub error here is an ``OSError`` (``LocalEntryNotFoundError``, ``HfHubHTTPError``, a
    broken snapshot symlink), so none escapes as a raw hub error.
    """
    from huggingface_hub import snapshot_download
    from huggingface_hub.errors import LocalEntryNotFoundError

    try:
        path = Path(
            snapshot_download(
                pin.hf_repo,
                revision=pin.revision,
                allow_patterns=pin.allow_patterns,
                cache_dir=str(cache_dir),
                local_files_only=True,
            )
        )
    except LocalEntryNotFoundError as exc:
        raise PinnedSnapshotMissingError() from exc
    except OSError as exc:
        raise PinnedSnapshotMissingError(f"local cache unreadable: {exc}") from exc
    if missing_files(path, pin.file_sha256):
        raise PinnedSnapshotMissingError("partial download")
    return path


def download_pinned_snapshot(
    pin: PinnedSnapshot, cache_dir: Path, *, force: bool = False
) -> tuple[Path, str | None]:
    """Download ``pin`` into ``cache_dir`` and verify every file uncached.

    The only pinned-snapshot network path. Returns the snapshot dir and its
    ``manifest_mismatch`` (None when every file matches); the caller raises its own
    pin-mismatch error. huggingface_hub returns already-cached files without fetching
    them, so a cached snapshot that fails its pin is fetched once more with
    ``force_download=True``: a plain download (Studio's Download buttons, bootstrap
    without ``--upgrade``) repairs a corrupt or swapped snapshot, not only ``force``.
    """
    from huggingface_hub import snapshot_download

    def fetch(force_download: bool) -> Path:
        return Path(
            snapshot_download(
                pin.hf_repo,
                revision=pin.revision,
                allow_patterns=pin.allow_patterns,
                cache_dir=str(cache_dir),
                force_download=force_download,
            )
        )

    path = fetch(force)
    mismatch = manifest_mismatch(path, pin.file_sha256)
    if mismatch is not None and not force:
        path = fetch(True)
        mismatch = manifest_mismatch(path, pin.file_sha256)
    return path, mismatch


# One lock per resolved file: overlapping status polls hash a file once, not once each,
# while polls for different files (a multi-GB model.bin, a small config) hash in parallel.
# A lock is discarded once its hash finishes, so the registry holds only in-flight files.
_MEMO_LOCKS: KeyedLocks[str, threading.Lock] = KeyedLocks(threading.Lock)


@lru_cache(maxsize=64)
def _sha256_for(resolved: str, size: int, mtime_ns: int) -> str:
    return sha256_file(Path(resolved))


def _memoized_sha256(path: Path) -> str:
    resolved = path.resolve()
    st = resolved.stat()
    key = str(resolved)
    try:
        with _MEMO_LOCKS.get(key):
            return _sha256_for(key, st.st_size, st.st_mtime_ns)
    finally:
        # The digest is cached now (or the hash failed and is retried next poll), so the
        # lock has done its job; a waiter still holding it reads the cached digest.
        _MEMO_LOCKS.discard_idle(key)


def clear_manifest_memo() -> None:
    """Forget remembered digests (tests)."""
    _sha256_for.cache_clear()
