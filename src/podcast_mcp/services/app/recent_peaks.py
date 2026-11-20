"""Loudness shape of a Recent card, folded from waveform pyramids already on disk.

Nothing here decodes audio or queues a pyramid build: a pyramid that is not ready gives a flat
card, and the card fills in once a build elsewhere finishes. The plan (which clip pieces play
from which media) is made once per project file revision; the stamp of the pyramid files is
read on every request.
"""

from __future__ import annotations

import logging
import math
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from podcast_mcp.engines.waveform_media import MediaEntry, current_key, resolve_media_refs
from podcast_mcp.engines.waveform_pyramid import (
    PyramidMeta,
    pyramid_path,
    read_bins,
    read_meta,
    ref_slug,
)
from podcast_mcp.models import load_project
from podcast_mcp.util.peak_bins import bin_peaks

log = logging.getLogger(__name__)

COLUMNS = 96

PyramidStamp = tuple[tuple[str, int | None, int | None], ...]

_MediaStat = tuple[str, int, int]

_MEDIA_KEYS: dict[Path, tuple[_MediaStat, str]] = {}
_MEDIA_KEYS_LOCK = threading.Lock()


@dataclass(frozen=True)
class PeakPlan:
    duration_sec: float
    refs: tuple[tuple[str, MediaEntry], ...]
    pieces: tuple[tuple[str, float, float, float], ...]
    artifacts_dir: Path


def plan_peaks(project_file: Path) -> PeakPlan | None:
    try:
        return _plan(project_file)
    except Exception:
        log.warning("Cannot plan recent peaks for %s", project_file, exc_info=True)
        return None


def _plan(project_file: Path) -> PeakPlan | None:
    project = load_project(project_file)
    duration = project.timeline.duration_sec
    if duration is None or not math.isfinite(duration) or duration <= 0:
        return None
    pieces: list[tuple[str, float, float, float]] = []
    for clip in project.clips:
        if project.track_by_id(clip.track_id) is None:
            return None
        ref = f"source:{clip.source_id}" if clip.source_id else f"track:{clip.track_id}"
        for src_a, src_b, tl_a in clip.virtual_pieces():
            if not all(math.isfinite(v) for v in (src_a, src_b, tl_a)):
                return None
            if src_b > src_a:
                pieces.append((ref, src_a, src_b, tl_a))
    if not pieces:
        return None
    needed = sorted({piece[0] for piece in pieces})
    found = resolve_media_refs(project, needed).refs
    if any(ref not in found for ref in needed):
        return None
    return PeakPlan(
        duration_sec=float(duration),
        refs=tuple((ref, found[ref]) for ref in needed),
        pieces=tuple(pieces),
        artifacts_dir=project.artifacts_dir(),
    )


def prune_media_keys(plans: list[PeakPlan]) -> None:
    keep = {entry.abs_path for plan in plans for _, entry in plan.refs}
    with _MEDIA_KEYS_LOCK:
        for stale in [path for path in _MEDIA_KEYS if path not in keep]:
            del _MEDIA_KEYS[stale]


def _media_key(entry: MediaEntry) -> str:
    """The pyramid key of the media, probed once per (path, size, mtime_ns), failures included."""
    st = entry.abs_path.stat()
    stat: _MediaStat = (entry.rel_path, st.st_size, st.st_mtime_ns)
    with _MEDIA_KEYS_LOCK:
        cached = _MEDIA_KEYS.get(entry.abs_path)
    if cached is not None and cached[0] == stat:
        return cached[1]
    key = current_key(entry)
    with _MEDIA_KEYS_LOCK:
        _MEDIA_KEYS[entry.abs_path] = (stat, key)
    return key


def pyramid_stamp(plan: PeakPlan) -> tuple[PyramidStamp, list[tuple[str, Path]] | None]:
    """The stamp of the plan's pyramid files, and their paths when every one is on disk."""
    stamp: list[tuple[str, int | None, int | None]] = []
    ready: list[tuple[str, Path]] = []
    for ref, entry in plan.refs:
        kind, _, ref_id = ref.partition(":")
        out = pyramid_path(plan.artifacts_dir / "peaks", ref_slug(kind, ref_id), _media_key(entry))
        try:
            st = out.stat()
        except OSError:
            stamp.append((out.name, None, None))
            continue
        stamp.append((out.name, st.st_mtime_ns, st.st_size))
        ready.append((ref, out))
    return tuple(stamp), ready if len(ready) == len(plan.refs) else None


def _level_for(meta: PyramidMeta, column_sec: float) -> int:
    level = 0
    for idx, lv in enumerate(meta.levels):
        if lv.spp / meta.sample_rate <= column_sec:
            level = idx
    return level


def _amplitudes(path: Path, meta: PyramidMeta, level: int) -> np.ndarray:
    raw = read_bins(path, meta, level, 0, meta.levels[level].bins)
    bins = np.frombuffer(raw, dtype="<i2").reshape(-1, 3).astype(np.int32)
    return np.abs(bins[:, :2]).max(axis=1) if bins.size else np.zeros(0, dtype=np.int32)


def fold_peaks(plan: PeakPlan, ready: list[tuple[str, Path]]) -> list[float]:
    """Max-pool every plan piece into COLUMNS columns of the timeline, loudest scaled to 1."""
    column_sec = plan.duration_sec / COLUMNS
    columns = np.zeros(COLUMNS, dtype=np.int32)
    for ref, path in ready:
        meta = read_meta(path)
        if meta.total_frames <= 0 or meta.sample_rate <= 0:
            return []
        level = _level_for(meta, column_sec)
        amp = _amplitudes(path, meta, level)
        bin_sec = meta.levels[level].spp / meta.sample_rate
        for piece_ref, src_a, src_b, tl_a in plan.pieces:
            if piece_ref != ref:
                continue
            first = max(0, math.floor(src_a / bin_sec))
            last = min(amp.size, math.ceil(src_b / bin_sec))
            if last <= first:
                continue
            idx = np.arange(first, last)
            at = tl_a + (idx + 0.5) * bin_sec - src_a
            keep = (at >= -bin_sec) & (at <= plan.duration_sec + bin_sec)
            cols = np.clip((at[keep] / column_sec).astype(np.int64), 0, COLUMNS - 1)
            np.maximum.at(columns, cols, amp[idx][keep])
    return bin_peaks(columns, COLUMNS)
