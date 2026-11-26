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

import contextlib
import importlib.util
import json
import logging
import os
import sys
import tempfile
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from podcast_mcp import settings
from podcast_mcp.util import process
from podcast_mcp.util.asset_sources import DownloadProgress, OnProgress
from podcast_mcp.util.fingerprint import file_stamp
from podcast_mcp.util.hashing import sha256_file
from podcast_mcp.util.keyed_lock import KeyedLocks

logger = logging.getLogger(__name__)

HUB_CHUNK_BYTES = 1024 * 1024
"""Bytes between Hugging Face progress updates (the library's own is 10 MiB)."""

_MISSING = object()
_plain_http_lock = threading.Lock()
_plain_http_depth = 0
_plain_http_originals: dict[str, object] = {}

_POLL_SEC = 0.25
"""How often the parent measures a child download's growth on disk."""

_CHILD_KINDS = frozenset({"http", "network", "disk", "other"})

_NO_FALLBACK_KINDS = frozenset({"http", "disk"})
"""Child failures plain HTTP would only repeat (the hub said no, the disk is full). Only a
failure the child marks ``xet`` falls back; a plain network error never does, so an unreachable
hub is not waited on twice."""

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


@contextmanager
def _plain_http_hub() -> Iterator[None]:
    """Download over plain HTTP in 1 MiB chunks so the bar moves and Cancel bites.

    hf_xet swallows exceptions from the progress callback, so Cancel is ignored and the bar
    only moves when the file ends; plain HTTP reports every chunk and raises propagate.
    The settings are process-wide: the first in saves the originals, the last out restores
    them. A hub missing an attribute logs a warning and leaves that one alone.
    """
    global _plain_http_depth
    from huggingface_hub import constants

    settings: dict[str, object] = {
        "DOWNLOAD_CHUNK_SIZE": HUB_CHUNK_BYTES,
        "HF_HUB_DISABLE_XET": True,
    }
    with _plain_http_lock:
        if _plain_http_depth == 0:
            _plain_http_originals.clear()
            try:
                for name, value in settings.items():
                    original = getattr(constants, name, _MISSING)
                    if original is _MISSING:
                        logger.warning(
                            "huggingface_hub has no %s; downloads keep its default", name
                        )
                        continue
                    _plain_http_originals[name] = original
                    setattr(constants, name, value)
            except BaseException:
                for name, original in _plain_http_originals.items():
                    setattr(constants, name, original)
                _plain_http_originals.clear()
                raise
        _plain_http_depth += 1
    try:
        yield
    finally:
        with _plain_http_lock:
            _plain_http_depth -= 1
            if _plain_http_depth == 0:
                for name, original in _plain_http_originals.items():
                    setattr(constants, name, original)
                _plain_http_originals.clear()


class HubChildError(RuntimeError):
    """The download child failed; ``kind`` and ``status`` say what the hub library raised there.

    ``kind`` is ``http`` (``status`` is the HTTP status), ``network``, ``disk`` (``errno`` is
    the OS error) or ``other`` (a bug, left unclassified). The bootstrap failure classifier maps
    it like the in-process hub exceptions. ``xet`` is true when the failing exception was
    an hf_xet failure; only those are retried over plain HTTP.
    """

    def __init__(
        self,
        kind: str,
        message: str,
        *,
        status: int | None = None,
        errno: int | None = None,
        error: str = "",
        xet: bool = False,
    ) -> None:
        super().__init__(message)
        self.kind = kind if kind in _CHILD_KINDS else "other"
        self.status = status
        self.errno = errno
        self.error = error
        self.xet = xet


def _child_argv(spec: Path) -> list[str]:
    """``-P`` like ``sidecar_launcher.rs``: the caller's cwd never shadows the hub library."""
    return [sys.executable, "-P", "-m", "podcast_mcp.util.hf_fetch_child", str(spec)]


def _xet_importable() -> bool:
    return importlib.util.find_spec("hf_xet") is not None


def _child_allowed() -> bool:
    """Whether the Xet child can run: not turned off, and hf_xet is there to be fast."""
    return not settings.flag("PODCAST_HF_IN_PROCESS") and _xet_importable()


def _cache_bytes(pin: PinnedSnapshot, cache_dir: Path) -> int:
    """Bytes in this repo's blobs, finished and ``.incomplete`` alike."""
    total = 0
    with contextlib.suppress(OSError):
        for entry in os.scandir(_blobs_dir(pin, cache_dir)):
            with contextlib.suppress(OSError):
                total += entry.stat().st_size
    return total


_INCOMPLETE = ".incomplete"
_STALE_PARTIAL_SEC = 3600.0


def _blobs_dir(pin: PinnedSnapshot, cache_dir: Path) -> Path:
    return cache_dir / f"models--{pin.hf_repo.replace('/', '--')}" / "blobs"


def _incomplete_names(blobs: Path) -> set[str]:
    """Names of the ``*.incomplete`` partials in ``blobs`` (empty when there are none)."""
    with contextlib.suppress(OSError):
        return {e.name for e in os.scandir(blobs) if e.name.endswith(_INCOMPLETE)}
    return set()


def _sweep_stale_partials(blobs: Path) -> None:
    """Remove Xet-style ``<sha>.<random>.incomplete`` partials idle for over an hour.

    hf_xet names each partial with a fresh random suffix, so a later download never reuses
    one a SIGKILLed parent left behind. The plain-HTTP resumable ``<sha>.incomplete`` (no
    second dot) is reused by the next download and recent files may belong to a live one:
    neither is touched. Best effort.
    """
    cutoff = time.time() - _STALE_PARTIAL_SEC
    for name in _incomplete_names(blobs):
        if "." not in name[: -len(_INCOMPLETE)]:
            continue
        with contextlib.suppress(OSError):
            path = blobs / name
            if path.stat().st_mtime < cutoff:
                path.unlink()


def _remove_new_partials(blobs: Path, before: set[str]) -> None:
    """Delete the ``.incomplete`` files this fetch created (best effort, child already reaped)."""
    for name in _incomplete_names(blobs) - before:
        with contextlib.suppress(OSError):
            (blobs / name).unlink()


_STDOUT_KEEP = 64 * 1024
_STDERR_TAIL = 2048
_STALE_SCRATCH_SEC = 3600.0
_SCRATCH_PREFIX = ".fetch-child-"


class _StdoutTail:
    """Drain the child's stdout on a thread so a chatty child never blocks on a full pipe.

    Only the last ``_STDOUT_KEEP`` bytes are kept; the result is the last JSON line.
    """

    def __init__(self, stream: Any) -> None:
        self._stream = stream
        self._tail = b""
        self._thread = threading.Thread(target=self._drain, name="hf-child-stdout", daemon=True)
        if stream is not None:
            self._thread.start()

    def _drain(self) -> None:
        try:
            while chunk := self._stream.read(65536):
                self._tail = (self._tail + chunk)[-_STDOUT_KEEP:]
        except (OSError, ValueError):
            return

    def result(self) -> dict[str, Any] | None:
        """The child's one JSON line, or None when it left none."""
        if self._thread.is_alive():
            self._thread.join(timeout=5.0)
        lines = [ln for ln in self._tail.decode("utf-8", "replace").splitlines() if ln.strip()]
        try:
            result = json.loads(lines[-1]) if lines else None
        except ValueError:
            return None
        return result if isinstance(result, dict) else None


def _int_or_none(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _sweep_stale_scratch(cache_dir: Path) -> None:
    """Remove scratch files a killed parent left behind (best effort)."""
    cutoff = time.time() - _STALE_SCRATCH_SEC
    with contextlib.suppress(OSError):
        for entry in os.scandir(cache_dir):
            if entry.name.startswith(_SCRATCH_PREFIX):
                with contextlib.suppress(OSError):
                    if entry.stat().st_mtime < cutoff:
                        os.unlink(entry.path)


def _log_child_stderr(log_path: Path) -> None:
    """Log the last bytes of the child's stderr before the scratch log is removed."""
    try:
        with log_path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            handle.seek(max(0, handle.tell() - _STDERR_TAIL))
            tail = handle.read().decode("utf-8", "replace").strip()
    except OSError:
        return
    if tail:
        logger.warning("download child stderr (tail): %s", tail)


def _run_child(
    pin: PinnedSnapshot,
    cache_dir: Path,
    force_download: bool,
    total: int | None,
    on_progress: OnProgress | None,
) -> tuple[Path | None, bool]:
    """Download in a child process, report its growth on disk, and kill it if ``on_progress`` raises.

    Returns ``(path, False)`` on success. Returns ``(None, xet_failed)`` when the child could
    not start, left no result (``xet_failed`` False), or failed with an hf_xet error (a blocked
    Xet host, a refused token; ``xet_failed`` True), so the caller downloads in-process over
    plain HTTP; blobs the child finished stay in the cache and a non-force plain path reuses
    them (a force one fetches everything again). Raises ``HubChildError`` for every other
    reported failure (http, disk, a plain network error) and whatever ``on_progress`` raises.
    """
    cache_dir.mkdir(parents=True, exist_ok=True)
    _sweep_stale_scratch(cache_dir)
    blobs = _blobs_dir(pin, cache_dir)
    _sweep_stale_partials(blobs)
    partials_before = _incomplete_names(blobs)
    spec = {
        "repo": pin.hf_repo,
        "revision": pin.revision,
        "allow_patterns": pin.allow_patterns,
        "cache_dir": str(cache_dir),
        "force_download": force_download,
    }
    fd, spec_name = tempfile.mkstemp(prefix=_SCRATCH_PREFIX, suffix=".json", dir=cache_dir)
    spec_path = Path(spec_name)
    log_path = spec_path
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(spec, handle)
        log_fd, log_name = tempfile.mkstemp(prefix=_SCRATCH_PREFIX, suffix=".log", dir=cache_dir)
        log_path = Path(log_name)
        with os.fdopen(log_fd, "wb") as log:
            baseline = _cache_bytes(pin, cache_dir)
            try:
                with process.detached_children():
                    proc = process.popen(
                        _child_argv(spec_path),
                        stdin=process.PIPE,
                        stdout=process.PIPE,
                        stderr=log,
                        start_new_session=True,
                    )
            except OSError as exc:
                logger.warning(
                    "download child could not start (%s); downloading in-process over plain HTTP",
                    exc,
                )
                return None, False
        path: Path | None = None
        try:
            path = _watch_child(proc, pin, cache_dir, baseline, total, on_progress)
        except HubChildError as exc:
            _log_child_stderr(log_path)
            if not exc.xet or exc.kind in _NO_FALLBACK_KINDS:
                raise
            logger.warning(
                "download child failed with a Xet error (%s); downloading in-process over plain HTTP",
                exc,
            )
            return None, True
        finally:
            if path is None:  # Cancel, failure or no result: the child is reaped by now
                _remove_new_partials(blobs, partials_before)
        if path is None:
            _log_child_stderr(log_path)
            logger.warning(
                "download child left no result (exit code %s); downloading in-process over plain HTTP",
                proc.returncode,
            )
        return path, False
    finally:
        for scratch in (spec_path, log_path):
            with contextlib.suppress(OSError):
                scratch.unlink()


def _watch_child(
    proc: process.Child | process.Popen[Any],
    pin: PinnedSnapshot,
    cache_dir: Path,
    baseline: int,
    total: int | None,
    on_progress: OnProgress | None,
) -> Path | None:
    """The snapshot path, or None when the child left no usable result (it could not run)."""
    stdout = _StdoutTail(proc.stdout)

    def grown() -> int:
        size = max(0, _cache_bytes(pin, cache_dir) - baseline)
        return min(size, total) if total is not None else size

    shown = 0
    try:
        while True:
            try:
                proc.wait(timeout=_POLL_SEC)
                break
            except process.TimeoutExpired:
                pass
            # Every tick, grown or not, so a stalled transfer still honours Cancel.
            shown = max(shown, grown())
            if on_progress is not None:
                on_progress(DownloadProgress(shown, total))
    except BaseException:
        process.kill_child(proc)
        with contextlib.suppress(OSError, process.SubprocessError):
            proc.wait(timeout=10)
        raise
    finally:
        if proc.stdin is not None:
            with contextlib.suppress(OSError, ValueError):
                proc.stdin.close()
    shown = max(shown, grown())
    result = stdout.result()
    if proc.stdout is not None:
        with contextlib.suppress(OSError):
            proc.stdout.close()
    if result is not None and "path" in result:
        if not isinstance(result["path"], str) or not result["path"]:
            result = None
    elif result is not None and not ("kind" in result or "error" in result):
        result = None
    if result is None:
        return None
    if "path" in result:
        if on_progress is not None:
            on_progress(
                DownloadProgress(total, total)
                if total is not None
                else DownloadProgress(shown, None)
            )
        return Path(result["path"])
    kind = result.get("kind")
    raise HubChildError(
        kind if isinstance(kind, str) else "other",
        f"{result.get('error', 'error')}: {result.get('message', '')}",
        status=_int_or_none(result.get("status")),
        errno=_int_or_none(result.get("errno")),
        error=str(result.get("error", "")),
        xet=result.get("xet") is True,
    )


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


class _MonotonicProgress:
    """Wraps ``on_progress`` so the bytes it reports never go backwards (the plain-HTTP
    fallback starts its own count at zero after the child already showed some)."""

    def __init__(self, sink: OnProgress, total: int | None) -> None:
        self._sink = sink
        self._total = total
        self._last = 0
        self._lock = threading.Lock()

    def __call__(self, progress: DownloadProgress) -> None:
        with self._lock:
            self._last = max(self._last, progress.bytes)
            self._sink(DownloadProgress(self._last, progress.total))

    def repeat(self) -> None:
        """Report the last value again: a tick with no new bytes, so Cancel is still seen."""
        self(DownloadProgress(0, self._total))


class _Stop:
    """Carries a Cancel raised by the heartbeat into the download thread's next progress update."""

    def __init__(self) -> None:
        self.error: BaseException | None = None

    def guard(self, report: OnProgress) -> OnProgress:
        def guarded(progress: DownloadProgress) -> None:
            if self.error is not None:
                raise self.error
            report(progress)

        return guarded


def _run_with_heartbeat(call: Callable[[], Path], report: _MonotonicProgress, stop: _Stop) -> Path:
    """Run the in-process download on a thread and tick ``report`` while it runs.

    The hub only updates its bar when bytes arrive, so a paused hub never lets Cancel through.
    The tick raises on the calling thread at once, and so does any other ``BaseException``
    (a ``KeyboardInterrupt`` in ``join``); the download thread stops at its next progress
    update. That bound is the hub's next byte update: a hub that sends nothing keeps the
    thread (with the process-wide plain-HTTP settings and the hub's blob lock) until a byte
    arrives or its socket times out, but the caller has long returned.
    """
    box: dict[str, Any] = {}

    def work() -> None:
        try:
            box["path"] = call()
        except BaseException as exc:  # handed back to the caller below
            box["error"] = exc

    thread = threading.Thread(target=work, name="plain-http-fallback", daemon=True)
    thread.start()
    try:
        while thread.is_alive():
            thread.join(_POLL_SEC)
            report.repeat()
    except BaseException as exc:  # Cancel, KeyboardInterrupt or anything else out of join/tick
        stop.error = exc
        raise
    if "error" in box:
        raise box["error"]
    return box["path"]


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

    cache_dir = Path(cache_dir)
    child_failed_on_xet = False

    def fetch(force_download: bool) -> Path:
        nonlocal child_failed_on_xet
        extra: dict[str, Any] = {}
        total: int | None = None
        report: _MonotonicProgress | None = None
        stop = _Stop()
        if on_progress is not None:
            total = _dry_run_total(pin, cache_dir, force_download)
            report = _MonotonicProgress(on_progress, total)
            report(DownloadProgress(0, total))
            extra["tqdm_class"] = _byte_bar(stop.guard(report), total)
        if _child_allowed() and not child_failed_on_xet:
            fetched, xet_failed = _run_child(pin, cache_dir, force_download, total, report)
            if fetched is not None:
                return fetched
            if xet_failed:
                child_failed_on_xet = True  # a force refetch must not spawn the child again

        def plain() -> Path:
            with _plain_http_hub():
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

        if report is not None:  # every plain-HTTP path honours Cancel, even on a paused hub
            return _run_with_heartbeat(plain, report, stop)
        return plain()

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
