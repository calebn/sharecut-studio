from __future__ import annotations

import wave
from pathlib import Path

import numpy as np

from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.engines.session_timeline import (
    SessionTimeline,
    TimelineClipSpan,
    clip_timeline_overlap_to_source,
)
from podcast_mcp.models import ClipJoinMode, EpisodeProject
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
    preserve_channels: bool = False,
) -> np.ndarray:
    """Decode only selected raw clip windows, retaining all requested frequencies."""
    from podcast_mcp.engines.timeline_render import resolve_clip_audio_path

    track = project.track_by_id(track_id)
    if track is None or start < 0 or end <= start:
        raise ValueError("raw timeline window is unavailable")
    spans = SessionTimeline(project).lane_clip_spans(track_id)
    if not spans:
        loader = load_wav_channels_window if preserve_channels else load_mono_window
        return loader(
            track_audio_path(project, track_id),
            start_sec=start,
            duration_sec=end - start,
            sample_rate=sample_rate,
        )
    samples: np.ndarray | None = None
    for span in spans:
        mapped = clip_timeline_overlap_to_source(span.clip, start, end)
        if mapped is None:
            continue
        lo, hi = max(start, float(span.timeline_start)), min(end, float(span.timeline_end))
        loader = load_wav_channels_window if preserve_channels else load_mono_window
        window = loader(
            resolve_clip_audio_path(project, track, span.clip),
            start_sec=float(mapped[0]),
            duration_sec=float(mapped[1] - mapped[0]),
            sample_rate=sample_rate,
        )
        offset = round((lo - start) * sample_rate)
        count = round((hi - lo) * sample_rate)
        if window.shape[0] < count:
            raise ValueError(f"clip {span.clip.id} source samples are unavailable")
        if samples is None:
            samples = np.zeros(
                (round((end - start) * sample_rate), *window.shape[1:]), dtype=np.float32
            )
        if samples.shape[1:] != window.shape[1:]:
            raise ValueError("selected media channel layouts differ")
        samples[offset : offset + count] += window[:count]
    return (
        samples
        if samples is not None
        else np.zeros(
            (round((end - start) * sample_rate), 1)
            if preserve_channels
            else round((end - start) * sample_rate),
            dtype=np.float32,
        )
    )


def load_wav_channels_window(
    path: Path, *, start_sec: float, duration_sec: float, sample_rate: int
) -> np.ndarray:
    """Bounded PCM16 reads retain every channel for speech-preservation vetoes."""
    with wave.open(str(path), "rb") as source:
        rate, channels = source.getframerate(), source.getnchannels()
        if source.getsampwidth() != 2 or rate > sample_rate or channels not in (1, 2):
            raise ValueError(
                "full-band channel evidence needs mono/stereo PCM16 at the evidence rate or below"
            )
        first = round(start_sec * rate)
        count = round(duration_sec * rate)
        if first < 0 or first + count > source.getnframes():
            raise ValueError("source channel samples are unavailable")
        source.setpos(first)
        samples = (
            np.frombuffer(source.readframes(count), dtype="<i2")
            .reshape(-1, channels)
            .astype(np.float32)
            / 32768
        )
    if samples.shape[0] != count:
        raise ValueError("source channel samples are unavailable")
    if rate == sample_rate:
        return samples
    positions = np.arange(round(duration_sec * sample_rate)) * rate / sample_rate
    return np.column_stack(
        [np.interp(positions, np.arange(count), samples[:, channel]) for channel in range(channels)]
    ).astype(np.float32)


def raw_evidence_layout_reason(project: EpisodeProject, track_id: str) -> str | None:
    """Raw placement evidence requires the renderer to retain the declared timeline clock."""
    if any(
        clip.track_id == track_id
        and clip.join_in_mode == ClipJoinMode.CROSSFADE
        and clip.fade_in_ms > 0
        for clip in project.clips
    ):
        return "unsupported_crossfade_evidence_clock"
    return None
