"""Pinned per-file sha256 manifests for downloaded model snapshots (#728).

A pinned Hugging Face snapshot (the Whisper catalog in ``engines/models/whisper.py``, the
forced aligner in ``engines/models/word_aligner.py``) lists every file it downloads with the
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

import logging
import threading
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from podcast_mcp.util.asset_sources import DownloadProgress, OnProgress
from podcast_mcp.util.fingerprint import file_stamp
from podcast_mcp.util.hashing import sha256_file
from podcast_mcp.util.keyed_lock import KeyedLocks

logger = logging.getLogger(__name__)

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


def _dry_run_total(pin: PinnedSnapshot, cache_dir: Path, force: bool) -> int | None:
    """Bytes the next download will fetch, or None when the hub does not say."""
    from huggingface_hub import snapshot_download
    from huggingface_hub.errors import DryRunError

    try:
        infos = snapshot_download(
            pin.hf_repo,
            revision=pin.revision,
            allow_patterns=pin.allow_patterns,
            cache_dir=str(cache_dir),
            force_download=force,
            dry_run=True,
        )
    except DryRunError:
        raise
    except OSError as exc:
        logger.info("download size unavailable for %s: %s", pin.hf_repo, exc)
        return None
    total = 0
    for info in infos:
        if info.will_download:
            if info.file_size is None:
                return None
            total += info.file_size
    return total


def _byte_bar(on_progress: OnProgress, total: int | None) -> type:
    """A ``tqdm_class`` that reports the snapshot's disk-write bytes to ``on_progress``.

    huggingface_hub builds one bar for the files (updated on the calling thread) and two
    byte bars, and feeds the "Reconstructing" one from HTTP and xet worker threads, so the
    counts are summed under a lock. If that bar never appears the library changed: progress
    then reports no total rather than a wrong one.
    """
    lock = threading.Lock()
    done = 0
    counting = False
    warned = False

    def report() -> None:
        nonlocal warned
        if counting:
            on_progress(DownloadProgress(done, total))
            return
        if not warned:
            warned = True
            logger.warning("huggingface_hub reported no byte progress; showing no total")
        on_progress(DownloadProgress(done, None))

    class ByteBar:
        def __init__(self, *_args: Any, **kwargs: Any) -> None:
            nonlocal done, counting
            self.total = kwargs.get("total")
            self.n = kwargs.get("initial") or 0
            self.counts = kwargs.get("unit") == "B" and str(kwargs.get("desc", "")).startswith(
                "Reconstructing"
            )
            if self.counts:
                with lock:
                    counting = True
                    done += self.n

        def __enter__(self) -> ByteBar:
            return self

        def __exit__(self, *_exc: object) -> None:
            return None

        def update(self, n: float | None = 1) -> None:
            nonlocal done
            with lock:
                if self.counts:
                    done += int(n or 0)
                    if total is not None:
                        done = min(done, total)
                report()

        @property
        def format_dict(self) -> dict[str, Any]:
            return {}

        def close(self) -> None:
            return None

        def refresh(self) -> None:
            return None

        def set_description(self, *_args: Any, **_kwargs: Any) -> None:
            return None

        set_description_str = set_postfix_str = set_description

    return ByteBar


def download_pinned_snapshot(
    pin: PinnedSnapshot,
    cache_dir: Path,
    *,
    force: bool = False,
    on_progress: OnProgress | None = None,
) -> tuple[Path, str | None]:
    """Download ``pin`` into ``cache_dir`` and verify every file uncached.

    The only pinned-snapshot network path. Returns the snapshot dir and its
    ``manifest_mismatch`` (None when every file matches); the caller raises its own
    pin-mismatch error. huggingface_hub returns already-cached files without fetching
    them, so a cached snapshot that fails its pin is fetched once more with
    ``force_download=True``: a plain download (Studio's Download buttons, bootstrap
    without ``--upgrade``) repairs a corrupt or swapped snapshot, not only ``force``.

    ``on_progress`` gets absolute byte counts against a total from a dry run first; the
    refetch starts again at zero. It may raise to stop the download.
    """
    from huggingface_hub import snapshot_download

    def fetch(force_download: bool) -> Path:
        extra: dict[str, Any] = {}
        if on_progress is not None:
            total = _dry_run_total(pin, cache_dir, force_download)
            on_progress(DownloadProgress(0, total))
            extra["tqdm_class"] = _byte_bar(on_progress, total)
        return Path(
            snapshot_download(
                pin.hf_repo,
                revision=pin.revision,
                allow_patterns=pin.allow_patterns,
                cache_dir=str(cache_dir),
                force_download=force_download,
                **extra,
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
    size, mtime_ns = file_stamp(resolved).content
    key = str(resolved)
    try:
        with _MEMO_LOCKS.get(key):
            return _sha256_for(key, size, mtime_ns)
    finally:
        # The digest is cached now (or the hash failed and is retried next poll), so the
        # lock has done its job; a waiter still holding it reads the cached digest.
        _MEMO_LOCKS.discard_idle(key)


def clear_manifest_memo() -> None:
    """Forget remembered digests (tests)."""
    _sha256_for.cache_clear()
