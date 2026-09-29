"""Raw selected media projected onto the shared timeline for acoustic evidence."""

from __future__ import annotations

from pathlib import Path

import numpy as np

from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.engines.session_timeline import (
    SessionTimeline,
    TimelineClipSpan,
    clip_timeline_overlap_to_source,
)
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.binaries import resolve_ffmpeg
from podcast_mcp.util.pcm_stream import NoAudioDecodedError
from podcast_mcp.util.process import run
from podcast_mcp.util.tracks import track_audio_path


def load_mono_full(path: Path, *, sample_rate: int = 8000, ffmpeg: str | None = None) -> np.ndarray:
    result = run(
        [
            ffmpeg or resolve_ffmpeg(),
            "-v",
            "error",
            "-i",
            str(path),
            "-ac",
            "1",
            "-ar",
            str(sample_rate),
            "-f",
            "f32le",
            "pipe:1",
        ],
        capture_output=True,
        check=True,
    )
    samples = np.frombuffer(result.stdout, dtype=np.float32)
    if samples.size == 0:
        raise NoAudioDecodedError(path)
    return samples


def raw_samples_on_timeline(
    spans: list[TimelineClipSpan],
    paths: list[Path],
    *,
    sources: dict[Path, np.ndarray],
    sample_rate: int = 8000,
) -> np.ndarray:
    for path in paths:
        if path not in sources:
            sources[path] = load_mono_full(path, sample_rate=sample_rate)
    if not spans:
        return sources[paths[0]]
    if len(spans) == 1:
        span = spans[0]
        source = sources[paths[0]]
        if (
            span.timeline_start == 0
            and span.source_start == 0
            and span.timeline_end == span.source_end
            and round(float(span.source_end) * sample_rate) == source.size
        ):
            return source
    timeline_end = max(span.timeline_end for span in spans)
    placed = np.zeros(max(0, round(float(timeline_end) * sample_rate)), dtype=np.float32)
    for span, path in zip(spans, paths, strict=True):
        source = sources[path]
        target_start = round(float(span.timeline_start) * sample_rate)
        target_end = round(float(span.timeline_end) * sample_rate)
        source_start = round(float(span.source_start) * sample_rate)
        count = target_end - target_start
        if target_start < 0 or source_start < 0 or source_start + count > source.size:
            raise ValueError(f"clip {span.clip.id} source samples are unavailable")
        placed[target_start:target_end] += source[source_start : source_start + count]
    return placed


def raw_timeline_samples(
    project: EpisodeProject,
    track_id: str,
    *,
    sample_rate: int = 8000,
    sources: dict[Path, np.ndarray] | None = None,
) -> np.ndarray:
    from podcast_mcp.engines.timeline_render import resolve_clip_audio_path

    track = project.track_by_id(track_id)
    if track is None:
        raise ValueError(f"track {track_id} is unavailable")
    spans = SessionTimeline(project).lane_clip_spans(track_id)
    paths = (
        [resolve_clip_audio_path(project, track, span.clip) for span in spans]
        if spans
        else [track_audio_path(project, track_id).resolve()]
    )
    return raw_samples_on_timeline(
        spans, paths, sources=sources if sources is not None else {}, sample_rate=sample_rate
    )


def raw_timeline_window(
    project: EpisodeProject,
    track_id: str,
    start: float,
    end: float,
    *,
    sample_rate: int = 48_000,
) -> np.ndarray:
    """Decode only selected raw clip windows, retaining all requested frequencies."""
    from podcast_mcp.engines.timeline_render import resolve_clip_audio_path

    track = project.track_by_id(track_id)
    if track is None or start < 0 or end <= start:
        raise ValueError("raw timeline window is unavailable")
    spans = SessionTimeline(project).lane_clip_spans(track_id)
    if not spans:
        return load_mono_window(
            track_audio_path(project, track_id),
            start_sec=start,
            duration_sec=end - start,
            sample_rate=sample_rate,
        )
    samples = np.zeros(round((end - start) * sample_rate), dtype=np.float32)
    for span in spans:
        mapped = clip_timeline_overlap_to_source(span.clip, start, end)
        if mapped is None:
            continue
        lo, hi = max(start, float(span.timeline_start)), min(end, float(span.timeline_end))
        window = load_mono_window(
            resolve_clip_audio_path(project, track, span.clip),
            start_sec=float(mapped[0]),
            duration_sec=float(mapped[1] - mapped[0]),
            sample_rate=sample_rate,
        )
        offset = round((lo - start) * sample_rate)
        count = round((hi - lo) * sample_rate)
        if window.size < count:
            raise ValueError(f"clip {span.clip.id} source samples are unavailable")
        samples[offset : offset + count] += window[:count]
    return samples
