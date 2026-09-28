"""Waveform pyramid status, tiles and PCM windows for the host and guest viewers.

Media refs and build hooks live in ``engines/waveform_media`` (so the pipeline
never imports services) and are re-exported here. This module adds:

- ``media_index`` — a small LRU of each project's refs, keyed by the project
  JSON revision and checked against a stat signature of the media and stem
  files, parsed with a before/after revision check so a racing save is never
  cached;
- ``waveform_status`` — per-ref ``ready`` / ``generating`` / ``unavailable``,
  scheduling missing pyramids;
- ``tile_bytes`` — raw data-tile bins, with no project parse;
- ``pcm_block`` — host-only int16 min/max PCM windows for deep zoom;
  compressed blocks are served from a small LRU before the media is probed, and
  a miss takes one of ``PCM_DECODE_MAX_CONCURRENT`` process-wide decode slots
  (``WaveformBusyError`` when none is free), shared by concurrent requests for
  the same block;
- ``gc_pyramids`` — once per process per project, drop orphaned pyramids.

See ``docs/waveform.md``.
"""

from __future__ import annotations

import contextlib
import logging
import re
import time
import wave
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from threading import Event, Lock
from typing import Any, Literal, TypeVar, cast

from podcast_mcp.engines.waveform_media import (
    REASON_DECODE_FAILED,
    REASON_NO_MEDIA,
    MediaEntry,
    MediaKind,
    collect_media_refs,
    current_key,
    ensure_project_waveforms,
    ensure_track_waveforms,
    media_watch_paths,
    pyramid_target,
    schedule_stem_waveforms,
    schedule_track_waveforms,
)
from podcast_mcp.engines.waveform_pyramid import (
    BIN_BYTES,
    PcmSource,
    PyramidMeta,
    probe_pcm_source,
    pyramid_build_failed,
    pyramid_build_pending,
    pyramid_path,
    read_bins,
    read_meta,
    read_pcm_minmax,
    ref_slug,
    schedule_pyramid_build,
)
from podcast_mcp.models import workspace_artifacts_dir
from podcast_mcp.project_io import open_project
from podcast_mcp.util.project_state import FileRevision, file_revision
from podcast_mcp.util.rate_limit import ConcurrencyGate, RateLimitDecision
from podcast_mcp.util.timeline_zoom import (
    max_tiles_per_request,
    pcm_block_frames,
    waveform_format_version,
)

__all__ = [
    "PCM_DECODE_MAX_CONCURRENT",
    "MediaEntry",
    "MediaIndex",
    "StaleWaveformKeyError",
    "WaveformBusyError",
    "WaveformDecodeError",
    "current_key",
    "ensure_project_waveforms",
    "ensure_track_waveforms",
    "gc_pyramids",
    "live_key",
    "media_index",
    "parse_ref",
    "pcm_block",
    "schedule_stem_waveforms",
    "schedule_track_waveforms",
    "tile_bytes",
    "waveform_status",
]

RefKind = Literal["track", "source", "stem"]

_REF_RE = re.compile(r"^(track|source|stem):(.+)$")
_KEY_RE = re.compile(r"^[0-9a-f]{20}$")
_PYRAMID_NAME_RE = re.compile(r"^([A-Za-z0-9_-]+)\.[0-9a-f]{20}\.wfpk$")

_INDEX_MAX = 16
_META_MAX = 256
_PCM_MAX = 32  # decoded compressed blocks; each at most pcm_block_frames * 4 bytes (256 KiB)
# Process-wide, shared by every tab and project: one tab's fetchLimit (4) never trips it
# alone; more tabs doing compressed deep zoom get a 503 the client re-queues (latency only).
PCM_DECODE_MAX_CONCURRENT = 4
GC_MIN_AGE_SEC = 7 * 86_400.0

log = logging.getLogger(__name__)


class StaleWaveformKeyError(ValueError):
    """The requested key is not the ref's current key (HTTP 409)."""


class WaveformDecodeError(LookupError):
    """The media could not be read or decoded (HTTP 404, like a missing ref)."""


class WaveformBusyError(RuntimeError):
    """Every compressed-media PCM decode slot is taken (HTTP 503 with ``Retry-After``)."""

    def __init__(self, decision: RateLimitDecision) -> None:
        super().__init__("waveform decoder busy")
        self.retry_after = decision.retry_after_header


_WatchSig = tuple[tuple[int, int] | None, ...]


@dataclass(frozen=True)
class MediaIndex:
    artifacts_dir: Path
    refs: dict[str, MediaEntry]
    unavailable: dict[str, str]
    watch_paths: tuple[Path, ...] = ()
    watch_sig: _WatchSig = ()


_IndexKey = tuple[str, FileRevision]
_INDEX: OrderedDict[_IndexKey, MediaIndex] = OrderedDict()
_INDEX_LOCK = Lock()
_META: OrderedDict[tuple[str, str], PyramidMeta] = OrderedDict()
_META_LOCK = Lock()
_GC_DONE: set[str] = set()
_GC_LOCK = Lock()
_PCM_DECODES = ConcurrencyGate(limit=PCM_DECODE_MAX_CONCURRENT, bucket_name="pcm_decode")
_PCM_GATE_KEY = "host"  # the gate is keyed; the decode budget is one process-wide key
_PcmKey = tuple[str, str, int]  # (media path, pyramid key, block)
_PCM: OrderedDict[_PcmKey, bytes] = OrderedDict()
_PCM_LOCK = Lock()
_PCM_INFLIGHT: dict[_PcmKey, Event] = {}  # blocks being decoded; guarded by _PCM_LOCK

_K = TypeVar("_K")
_V = TypeVar("_V")


def _lru_get(cache: OrderedDict[_K, _V], key: _K) -> _V | None:
    """Hit moves to the MRU end. The caller holds the cache's lock."""
    hit = cache.get(key)
    if hit is not None:
        cache.move_to_end(key)
    return hit


def _lru_put(cache: OrderedDict[_K, _V], key: _K, value: _V, limit: int) -> None:
    """Insert and evict LRU entries past *limit*. The caller holds the cache's lock."""
    cache[key] = value
    while len(cache) > limit:
        cache.popitem(last=False)


def parse_ref(ref: str) -> tuple[RefKind, str]:
    """Split ``track:<id>`` / ``source:<id>`` / ``stem:<id>``; ``ValueError`` otherwise."""
    match = _REF_RE.fullmatch(ref)
    if match is None:
        raise ValueError(f"invalid media ref: {ref!r}")
    return cast(RefKind, match.group(1)), match.group(2)


def _artifacts_dir(project_path: Path) -> Path:
    return workspace_artifacts_dir(project_path.parent.resolve())


def _watch_signature(paths: tuple[Path, ...]) -> _WatchSig:
    out: list[tuple[int, int] | None] = []
    for path in paths:
        try:
            st = path.stat()
        except OSError:
            out.append(None)
            continue
        out.append((st.st_size, st.st_mtime_ns))
    return tuple(out)


def media_index(project_path: Path) -> MediaIndex:
    """Refs of the project at *project_path* (LRU of 16 keyed by file revision).

    A hit is reused only while its watched media and stem files are unchanged.
    """
    cache_key: _IndexKey = (str(project_path), file_revision(project_path))
    with _INDEX_LOCK:
        hit = _lru_get(_INDEX, cache_key)
    if hit is not None and _watch_signature(hit.watch_paths) == hit.watch_sig:
        return hit
    before = file_revision(project_path)
    _, project = open_project(project_path)
    after = file_revision(project_path)
    watch_paths = media_watch_paths(project)
    watch_sig = _watch_signature(watch_paths)  # before collecting: a later change misses next time
    refs = collect_media_refs(project)
    index = MediaIndex(
        artifacts_dir=_artifacts_dir(project_path),
        refs=refs.refs,
        unavailable=refs.unavailable,
        watch_paths=watch_paths,
        watch_sig=watch_sig,
    )
    if before == after == cache_key[1]:
        with _INDEX_LOCK:
            _lru_put(_INDEX, cache_key, index, _INDEX_MAX)
    return index


def live_key(entry: MediaEntry) -> str:
    """``current_key`` for request paths: missing or unreadable media is ``LookupError`` (404).

    Use this, not ``current_key``, on any HTTP path (``pcm_block``, guest tiles)."""
    try:
        return current_key(entry)
    except OSError as exc:
        raise LookupError("waveform media not found") from exc


def _meta(path: Path, key: str) -> PyramidMeta:
    cache_key = (str(path), key)
    with _META_LOCK:
        hit = _lru_get(_META, cache_key)
    if hit is not None:
        return hit
    meta = read_meta(path)
    with _META_LOCK:
        _lru_put(_META, cache_key, meta, _META_MAX)
    return meta


def _drop_pyramid(path: Path, key: str) -> None:
    """Delete a corrupt pyramid and its cached header so the next status call rebuilds it."""
    with _META_LOCK:
        _META.pop((str(path), key), None)
    with contextlib.suppress(OSError):
        path.unlink()


def _served_meta(path: Path, key: str) -> PyramidMeta:
    """``_meta`` for request paths: an unreadable pyramid is ``WaveformDecodeError`` (404).

    A corrupt file is deleted so the next status call queues a rebuild, as ``_ref_status`` does.
    """
    try:
        return _meta(path, key)
    except ValueError as exc:
        _drop_pyramid(path, key)
        raise WaveformDecodeError("waveform pyramid could not be read") from exc
    except OSError as exc:
        raise WaveformDecodeError("waveform pyramid could not be read") from exc


def _ready_entry(key: str, meta: PyramidMeta) -> dict[str, Any]:
    return {
        "status": "ready",
        "key": key,
        "sample_rate": meta.sample_rate,
        "channels": meta.channels,
        "total_frames": meta.total_frames,
        "base_spp": meta.base_spp,
        "level_factor": meta.level_factor,
        "bins_per_tile": meta.bins_per_tile,
        "levels": [{"spp": lv.spp, "bins": lv.bins} for lv in meta.levels],
    }


def _unavailable(reason: str) -> dict[str, Any]:
    return {"status": "unavailable", "reason": reason}


def _generating() -> dict[str, Any]:
    return {"status": "generating"}


def _ref_status(artifacts_dir: Path, ref: str, entry: MediaEntry) -> dict[str, Any]:
    try:
        target = pyramid_target(artifacts_dir, ref, entry)
    except OSError:
        return _unavailable(REASON_NO_MEDIA)
    # Pending first: a job drops its pending mark only after os.replace (#421).
    if pyramid_build_pending(target.slug, target.key):
        return _generating()
    if target.out.is_file():
        try:
            return _ready_entry(target.key, _meta(target.out, target.key))
        except (OSError, ValueError):
            _drop_pyramid(target.out, target.key)
    if pyramid_build_failed(target.key):
        return _unavailable(REASON_DECODE_FAILED)
    if schedule_pyramid_build(ref, target.key, entry.abs_path, target.out):
        return _generating()
    return _unavailable(REASON_DECODE_FAILED)


def _ref_kind(ref: str) -> MediaKind:
    return "stem" if ref.startswith("stem:") else "raw"


def waveform_status(project_path: Path, kind: MediaKind) -> dict[str, Any]:
    """``{"format_version", "media": {ref: entry}}`` for every ref of *kind*."""
    index = media_index(project_path)
    try:
        gc_pyramids(project_path, index)
    except Exception:
        log.warning("waveform pyramid GC failed for %s", project_path, exc_info=True)
    media: dict[str, dict[str, Any]] = {}
    for ref, entry in index.refs.items():
        if entry.kind == kind:
            media[ref] = _ref_status(index.artifacts_dir, ref, entry)
    for ref, reason in index.unavailable.items():
        if _ref_kind(ref) == kind:
            media[ref] = _unavailable(reason)
    return {"format_version": waveform_format_version(), "media": dict(sorted(media.items()))}


def _pyramid_file(project_path: Path, ref: str, key: str) -> Path:
    if not _KEY_RE.fullmatch(key):
        raise ValueError("invalid waveform key")
    kind, ref_id = parse_ref(ref)
    path = pyramid_path(_artifacts_dir(project_path) / "peaks", ref_slug(kind, ref_id), key)
    if not path.is_file():
        raise LookupError("waveform pyramid not found")
    return path


def tile_bytes(project_path: Path, ref: str, key: str, level: int, start: int, count: int) -> bytes:
    """Concatenated bins of data tiles ``[start, start+count)``, clipped at the level end.

    Does not parse the project: the file name is derived from *ref* and *key*.
    ``ValueError`` for bad input, ``LookupError`` when the pyramid is missing or
    corrupt, including a short read under a cached header (the file and its
    cached header are dropped).
    """
    path = _pyramid_file(project_path, ref, key)
    meta = _served_meta(path, key)
    if not 0 <= level < len(meta.levels):
        raise ValueError("level out of range")
    if not 1 <= count <= max_tiles_per_request():
        raise ValueError(f"count must be 1..{max_tiles_per_request()}")
    first_bin = start * meta.bins_per_tile
    if start < 0 or first_bin >= meta.levels[level].bins:
        raise ValueError("start out of range")
    data = read_bins(path, meta, level, first_bin, count * meta.bins_per_tile)
    want = min(count * meta.bins_per_tile, meta.levels[level].bins - first_bin) * BIN_BYTES
    if len(data) != want:  # the file changed under a cached header: never serve it as immutable
        _drop_pyramid(path, key)
        raise WaveformDecodeError("waveform pyramid could not be read")
    return data


def _read_pcm_bytes(
    entry: MediaEntry, key: str, meta: PyramidMeta, start: int, frames: int, source: PcmSource
) -> bytes:
    try:
        pairs = read_pcm_minmax(
            entry.abs_path,
            start,
            frames,
            sample_rate=meta.sample_rate,
            channels=meta.channels,
            source=source,
        )
    except (OSError, EOFError, RuntimeError, wave.Error) as exc:
        raise WaveformDecodeError("waveform media could not be decoded") from exc
    if live_key(entry) != key:  # media replaced mid-read: never cache the wrong samples
        raise StaleWaveformKeyError("waveform key is stale")
    return pairs.astype("<i2").tobytes()


def _decode_pcm_block(cache_key: _PcmKey, read: Callable[[], bytes]) -> bytes:
    """A compressed block from the LRU, from a concurrent decode of it, or from *read*.

    The first caller for *cache_key* takes a decode slot without waiting
    (``WaveformBusyError`` when none is free) and runs *read*; later callers wait
    for that decode instead of taking a slot, then look again (a failed decode
    stores nothing, so one of them decodes next). *read* ends within the ffmpeg
    watchdog, so the wait is bounded.
    """
    done: Event | None = None
    while True:
        with _PCM_LOCK:
            hit = _lru_get(_PCM, cache_key)
            if hit is not None:
                return hit
            pending = _PCM_INFLIGHT.get(cache_key)
            if pending is None:
                decision = _PCM_DECODES.try_enter(_PCM_GATE_KEY)
                if not decision.allowed:
                    raise WaveformBusyError(decision)
                done = _PCM_INFLIGHT[cache_key] = Event()
                break
        pending.wait()
    assert done is not None
    try:
        body = read()
        with _PCM_LOCK:
            _lru_put(_PCM, cache_key, body, _PCM_MAX)
        return body
    finally:
        _PCM_DECODES.exit(_PCM_GATE_KEY)
        with _PCM_LOCK:
            del _PCM_INFLIGHT[cache_key]
        done.set()


def pcm_block(project_path: Path, ref: str, key: str, block: int) -> bytes:
    """int16 ``(min, max)`` pairs for frames ``[block*B, min((block+1)*B, total))``.

    ``StaleWaveformKeyError`` when *key* is not the ref's current key, checked before
    and after the read. Compressed blocks are kept in an LRU of ``_PCM_MAX`` (32)
    keyed by media path, key and block, looked up before the media is probed; only
    bytes that passed the after-read key check are stored. The LRU trusts the key
    (size + ``mtime_ns``): same-size media replaced within one mtime tick keeps
    serving old samples until evicted, as tiles and the browser cache already do.
    On a miss, media off the WAV fast path goes through ``_decode_pcm_block``: one
    of ``PCM_DECODE_MAX_CONCURRENT`` process-wide slots, taken without waiting
    (``WaveformBusyError`` when none is free) and shared by concurrent requests for
    the same block. A decode runs to the end (at most the ffmpeg watchdog) even when
    its client has gone away and holds its slot until then; its block is still cached.
    """
    parse_ref(ref)
    entry = media_index(project_path).refs.get(ref)
    if entry is None:
        raise LookupError("unknown media ref")
    if live_key(entry) != key:
        raise StaleWaveformKeyError("waveform key is stale")
    meta = _served_meta(_pyramid_file(project_path, ref, key), key)
    frames_per_block = pcm_block_frames()
    start = block * frames_per_block
    if block < 0 or start >= meta.total_frames:
        raise ValueError("block out of range")
    frames = min(frames_per_block, meta.total_frames - start)
    cache_key: _PcmKey = (str(entry.abs_path), key, block)
    with _PCM_LOCK:
        hit = _lru_get(_PCM, cache_key)
    if hit is not None:  # only compressed blocks are stored, and the key was checked live above
        return hit
    try:
        source = probe_pcm_source(entry.abs_path)
    except OSError as exc:
        raise WaveformDecodeError("waveform media could not be decoded") from exc
    if not source.needs_decode:
        return _read_pcm_bytes(entry, key, meta, start, frames, source)
    return _decode_pcm_block(
        cache_key, lambda: _read_pcm_bytes(entry, key, meta, start, frames, source)
    )


def gc_pyramids(project_path: Path, index: MediaIndex | None = None) -> int:
    """Once per process per project: drop week-old orphan pyramids and legacy peaks JSON.

    Per-ref pruning never reaches refs that were deleted, so orphans are swept
    here. ``artifacts/peaks/*.json`` is the pre-pyramid overview format; nothing
    here reads it, but an older app build may still write it. Both sweeps keep
    the ``GC_MIN_AGE_SEC`` guard because a guest status poll can trigger this
    pass, except legacy peaks JSON: at once when that track has a live
    ``.wfpk``, otherwise once week-old. The project counts as done only after
    a pass succeeds.
    """
    marker = str(project_path.resolve())
    with _GC_LOCK:
        if marker in _GC_DONE:
            return 0
        _GC_DONE.add(marker)
    try:
        index = index if index is not None else media_index(project_path)
        live = {ref_slug(*parse_ref(ref)) for ref in (*index.refs, *index.unavailable)}
        cutoff = time.time() - GC_MIN_AGE_SEC
        removed = 0
        peaks = index.artifacts_dir / "peaks"
        live_pyramids: set[str] = set()
        for path in peaks.glob("*.wfpk"):
            match = _PYRAMID_NAME_RE.fullmatch(path.name)
            if match is None:
                continue
            if match.group(1) in live:
                live_pyramids.add(match.group(1))
                continue
            with contextlib.suppress(OSError):
                if path.stat().st_mtime < cutoff:
                    path.unlink()
                    removed += 1
        for legacy in peaks.glob("*.json"):
            # ``peaks/{track}.json`` is superseded once that track has a pyramid (#530);
            # ``ref_slug`` hashes ids an older build wrote unsanitized.
            superseded = ref_slug("track", legacy.stem) in live_pyramids
            with contextlib.suppress(OSError):
                if superseded or legacy.stat().st_mtime < cutoff:
                    legacy.unlink()
                    removed += 1
    except BaseException:
        with _GC_LOCK:
            _GC_DONE.discard(marker)
        raise
    return removed
