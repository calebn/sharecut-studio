"""Waveform pyramid status, tiles and PCM windows for the host and guest viewers.

Media refs and build hooks live in ``engines/waveform_media`` (so the pipeline
never imports services) and are re-exported here. This module adds:

- ``media_index`` — a small LRU of each project's refs, keyed by the project
  JSON revision (plus the stems folder), parsed with a before/after revision
  check so a racing save is never cached;
- ``waveform_status`` — per-ref ``ready`` / ``generating`` / ``unavailable``,
  scheduling missing pyramids;
- ``tile_bytes`` — raw data-tile bins, with no project parse;
- ``pcm_block`` — host-only int16 min/max PCM windows for deep zoom;
- ``gc_pyramids`` — once per process per project, drop orphaned pyramids.

See ``docs/waveform.md``.
"""

from __future__ import annotations

import contextlib
import re
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Any, Literal, cast

from podcast_mcp.engines.waveform_media import (
    REASON_DECODE_FAILED,
    REASON_NO_MEDIA,
    MediaEntry,
    MediaKind,
    collect_media_refs,
    ensure_track_waveforms,
    pyramid_target,
    schedule_stem_waveforms,
    schedule_track_waveforms,
)
from podcast_mcp.engines.waveform_pyramid import (
    PyramidMeta,
    media_key,
    pyramid_build_failed,
    pyramid_build_pending,
    pyramid_path,
    read_bins,
    read_meta,
    read_pcm_minmax,
    ref_slug,
    schedule_pyramid_build,
)
from podcast_mcp.project_io import open_project
from podcast_mcp.util.project_state import FileRevision, file_revision
from podcast_mcp.util.timeline_zoom import (
    max_tiles_per_request,
    pcm_block_frames,
    waveform_format_version,
)

__all__ = [
    "MediaEntry",
    "MediaIndex",
    "StaleWaveformKeyError",
    "current_key",
    "ensure_track_waveforms",
    "gc_pyramids",
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
GC_MIN_AGE_SEC = 7 * 86_400.0


class StaleWaveformKeyError(ValueError):
    """The requested key is not the ref's current key (HTTP 409)."""


@dataclass(frozen=True)
class MediaIndex:
    artifacts_dir: Path
    refs: dict[str, MediaEntry]
    unavailable: dict[str, str]


_IndexKey = tuple[str, FileRevision, int | None]
_INDEX: OrderedDict[_IndexKey, MediaIndex] = OrderedDict()
_INDEX_LOCK = Lock()
_META: OrderedDict[str, PyramidMeta] = OrderedDict()
_META_LOCK = Lock()
_GC_DONE: set[str] = set()
_GC_LOCK = Lock()


def parse_ref(ref: str) -> tuple[RefKind, str]:
    """Split ``track:<id>`` / ``source:<id>`` / ``stem:<id>``; ``ValueError`` otherwise."""
    match = _REF_RE.fullmatch(ref)
    if match is None:
        raise ValueError(f"invalid media ref: {ref!r}")
    return cast(RefKind, match.group(1)), match.group(2)


def _artifacts_dir(project_path: Path) -> Path:
    return project_path.parent.resolve() / "artifacts"


def _stems_signature(project_path: Path) -> int | None:
    """Stem renders rewrite ``artifacts/tracks`` without touching the project JSON."""
    try:
        return (_artifacts_dir(project_path) / "tracks").stat().st_mtime_ns
    except OSError:
        return None


def media_index(project_path: Path) -> MediaIndex:
    """Refs of the project at *project_path* (LRU of 16, keyed by file revision)."""
    cache_key: _IndexKey = (
        str(project_path),
        file_revision(project_path),
        _stems_signature(project_path),
    )
    with _INDEX_LOCK:
        hit = _INDEX.get(cache_key)
        if hit is not None:
            _INDEX.move_to_end(cache_key)
            return hit
    before = file_revision(project_path)
    _, project = open_project(project_path)
    after = file_revision(project_path)
    refs = collect_media_refs(project)
    index = MediaIndex(
        artifacts_dir=_artifacts_dir(project_path),
        refs=refs.refs,
        unavailable=refs.unavailable,
    )
    if before == after == cache_key[1]:
        with _INDEX_LOCK:
            _INDEX[cache_key] = index
            while len(_INDEX) > _INDEX_MAX:
                _INDEX.popitem(last=False)
    return index


def current_key(entry: MediaEntry) -> str:
    """Pyramid key of *entry*'s media as it is on disk now."""
    st = entry.abs_path.stat()
    return media_key(entry.rel_path, st.st_size, st.st_mtime_ns)


def _meta(path: Path, key: str) -> PyramidMeta:
    with _META_LOCK:
        hit = _META.get(key)
        if hit is not None:
            _META.move_to_end(key)
            return hit
    meta = read_meta(path)
    with _META_LOCK:
        _META[key] = meta
        while len(_META) > _META_MAX:
            _META.popitem(last=False)
    return meta


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
            with contextlib.suppress(OSError):
                target.out.unlink()
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
    gc_pyramids(project_path)
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
    ``ValueError`` for bad input, ``LookupError`` when the pyramid is missing.
    """
    path = _pyramid_file(project_path, ref, key)
    meta = _meta(path, key)
    if not 0 <= level < len(meta.levels):
        raise ValueError("level out of range")
    if not 1 <= count <= max_tiles_per_request():
        raise ValueError(f"count must be 1..{max_tiles_per_request()}")
    first_bin = start * meta.bins_per_tile
    if start < 0 or first_bin >= meta.levels[level].bins:
        raise ValueError("start out of range")
    return read_bins(path, meta, level, first_bin, count * meta.bins_per_tile)


def pcm_block(project_path: Path, ref: str, key: str, block: int) -> bytes:
    """int16 ``(min, max)`` pairs for frames ``[block*B, min((block+1)*B, total))``.

    ``StaleWaveformKeyError`` when *key* is not the ref's current key.
    """
    parse_ref(ref)
    entry = media_index(project_path).refs.get(ref)
    if entry is None:
        raise LookupError("unknown media ref")
    if current_key(entry) != key:
        raise StaleWaveformKeyError("waveform key is stale")
    meta = _meta(_pyramid_file(project_path, ref, key), key)
    frames_per_block = pcm_block_frames()
    start = block * frames_per_block
    if block < 0 or start >= meta.total_frames:
        raise ValueError("block out of range")
    frames = min(frames_per_block, meta.total_frames - start)
    pairs = read_pcm_minmax(
        entry.abs_path,
        start,
        frames,
        sample_rate=meta.sample_rate,
        channels=meta.channels,
    )
    return pairs.astype("<i2").tobytes()


def gc_pyramids(project_path: Path) -> int:
    """Once per process per project: delete week-old pyramids whose ref is gone."""
    marker = str(project_path.resolve())
    with _GC_LOCK:
        if marker in _GC_DONE:
            return 0
        _GC_DONE.add(marker)
    index = media_index(project_path)
    live = {ref_slug(*parse_ref(ref)) for ref in (*index.refs, *index.unavailable)}
    cutoff = time.time() - GC_MIN_AGE_SEC
    removed = 0
    for path in (index.artifacts_dir / "peaks").glob("*.wfpk"):
        match = _PYRAMID_NAME_RE.fullmatch(path.name)
        if match is None or match.group(1) in live:
            continue
        with contextlib.suppress(OSError):
            if path.stat().st_mtime < cutoff:
                path.unlink()
                removed += 1
    return removed
