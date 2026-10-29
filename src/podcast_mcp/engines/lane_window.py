"""What a lane plays on the session clock: each clip's placement and the samples under a window."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import NamedTuple

import numpy as np

from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.engines.media_probe import probe_media
from podcast_mcp.engines.mute_regions import (
    IgnoredWordRegions,
    mute_spans_for_source_window,
    sample_mute_envelopes,
)
from podcast_mcp.engines.sample_grid import Piece, lay_out
from podcast_mcp.engines.timeline_render import ClipAudioPaths
from podcast_mcp.models import Clip, EpisodeProject, Track
from podcast_mcp.util.intervals import merge_intervals
from podcast_mcp.util.media_identity import same_recording
from podcast_mcp.util.workspace_paths import resolve_under_workspace

CLOCK_EPS_SEC = 1e-6


@dataclass(frozen=True)
class Placement:
    """One stretch of a recording on the session clock: its audio plays from ``src_start``
    at ``tl_start`` until ``tl_end``. ``media`` is ``None`` when the file the render would
    play cannot be named."""

    track_id: str
    source_id: str | None
    media: Path | None
    tl_start: float
    tl_end: float
    src_start: float
    excluded_word_spans: tuple[tuple[float, float], ...] = ()

    @property
    def src_end(self) -> float:
        return self.src_start + (self.tl_end - self.tl_start)

    def to_session(self, source_sec: float) -> float:
        return self.tl_start + (source_sec - self.src_start)

    def to_source(self, session_sec: float) -> float:
        return self.src_start + (session_sec - self.tl_start)

    def abuts(self, other: Placement) -> bool:
        """Whether ``other`` plays on from where this ends, in both clocks."""
        return (
            self.track_id == other.track_id
            and self.source_id == other.source_id
            and self.media is not None
            and other.media is not None
            and same_recording(self.media, other.media)
            and abs(self.tl_end - other.tl_start) < CLOCK_EPS_SEC
            and abs(self.src_end - other.src_start) < CLOCK_EPS_SEC
        )


def lane_clip_placements(project: EpisodeProject, track: Track) -> list[tuple[Clip, Placement]]:
    """Each clip a lane plays with its placement, in timeline order.

    A lane with no clips plays its media from the start of the session, as ingest places
    an un-clipped track. The media a clip plays is resolved as the render resolves it.
    """
    clips = sorted(
        (c for c in project.clips if c.track_id == track.id), key=lambda c: c.timeline_start
    )
    ignored = IgnoredWordRegions(project)
    sample_rates: dict[Path, int | None] = {}
    if not clips:
        if track.timeline_empty or track.media is None:
            return []
        clips = [
            Clip(
                id="implicit",
                track_id=track.id,
                source_start=0.0,
                source_end=math.inf,
                timeline_start=0.0,
            )
        ]
    audio_path = ClipAudioPaths(project, track)
    return [
        (clip, _clip_placement(project, track, clip, ignored, sample_rates, audio_path))
        for clip in clips
    ]


def lane_placements(project: EpisodeProject, track: Track) -> list[Placement]:
    """The recordings a lane plays and where, in timeline order; abutting clips are one."""
    placements: list[Placement] = []
    for _, placement in lane_clip_placements(project, track):
        if placements and placements[-1].abuts(placement):
            last = placements[-1]
            placements[-1] = Placement(
                last.track_id,
                last.source_id,
                last.media,
                last.tl_start,
                placement.tl_end,
                last.src_start,
                tuple(merge_intervals((*last.excluded_word_spans, *placement.excluded_word_spans))),
            )
        else:
            placements.append(placement)
    return placements


def primary_media(project: EpisodeProject, track: Track) -> Path | None:
    """The track's own media file, resolved as the render resolves it; ``None`` when it
    has none or it lies outside the workspace."""
    if track.media is None:
        return None
    try:
        return resolve_under_workspace(project, track.media.path)
    except (OSError, ValueError):
        return None


def _clip_placement(
    project: EpisodeProject,
    track: Track,
    clip: Clip,
    ignored: IgnoredWordRegions,
    sample_rates: dict[Path, int | None],
    audio_path: ClipAudioPaths,
) -> Placement:
    try:
        media: Path | None = audio_path(clip)
    except (OSError, ValueError):
        media = None
    ignored_regions = ignored.for_clip(clip)
    excluded: list[tuple[float, float]] = []
    envelopes = mute_spans_for_source_window(
        clip, clip.source_start, clip.source_end, ignored_regions
    )
    if envelopes:
        if media is not None and media not in sample_rates:
            info = probe_media(media)
            sample_rates[media] = info.sample_rate if info is not None else None
        rate = sample_rates.get(media) if media is not None else None
        if rate is None:
            excluded = [(clip.source_start, clip.source_end)]
        else:
            samples = sample_mute_envelopes(
                envelopes, clip.source_end - clip.source_start, rate, source_start=clip.source_start
            )
            for index, sample in enumerate(samples):
                first, last = sample.silent_span()
                if index + 1 < len(samples):
                    last = min(last, samples[index + 1].first)
                if last > first:
                    excluded.append((first / rate, last / rate))
    bounded = tuple(
        merge_intervals(
            (max(lo, clip.source_start), min(hi, clip.source_end))
            for lo, hi in excluded
            if hi > clip.source_start and lo < clip.source_end
        )
    )
    return Placement(
        track.id,
        clip.source_id,
        media,
        clip.timeline_start,
        clip.timeline_end,
        clip.source_start,
        bounded,
    )


class SampleRun(NamedTuple):
    """``length`` samples of ``media`` from source sample ``first``, played from timeline
    sample ``dest``. ``media`` is ``None`` when the file cannot be named."""

    media: Path | None
    dest: int
    first: int
    length: int


def read_samples(runs: Sequence[SampleRun], first: int, size: int, sample_rate: int) -> np.ndarray:
    """The ``size`` mono samples from timeline sample ``first`` that ``runs`` play, summed.

    Where nothing plays the window is silence. Raises when a run under the window cannot
    be named or read.
    """
    out = np.zeros(max(0, size), dtype=np.float32)
    for run in runs:
        k0, k1 = max(run.dest, first), min(run.dest + run.length, first + out.size)
        if k1 <= k0:
            continue
        if run.media is None:
            raise FileNotFoundError("a lane plays a recording that cannot be named")
        chunk = load_mono_window(
            run.media,
            start_sec=(run.first + k0 - run.dest) / sample_rate,
            duration_sec=(k1 - k0) / sample_rate,
            sample_rate=sample_rate,
            antialias=True,
        )
        at = k0 - first
        out[at : at + chunk.size] += chunk[: out.size - at]
    return out


def lane_window(
    project: EpisodeProject, track: Track, lo: float, hi: float, sample_rate: int
) -> np.ndarray:
    """What ``track``'s lane plays over session ``[lo, hi)``, as mono samples at ``sample_rate``.

    Each clip's recording is read at the samples that back it (``engines.sample_grid``) and
    laid where they play; where the lane plays nothing the window is silence. Raises when a
    recording under the window cannot be named or read.
    """
    pairs = lane_clip_placements(project, track)
    cells = lay_out(
        [
            Piece(
                p.src_start,
                p.src_end if math.isfinite(p.tl_end) else p.src_start + max(0.0, hi - p.tl_start),
                p.tl_start,
                p.tl_end,
            )
            for _, p in pairs
        ],
        sample_rate,
    )
    runs = [
        SampleRun(p.media, cell.dest, cell.first, cell.count)
        for (_, p), cell in zip(pairs, cells, strict=True)
    ]
    return read_samples(runs, round(lo * sample_rate), round((hi - lo) * sample_rate), sample_rate)
