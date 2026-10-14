from __future__ import annotations

from pathlib import Path

import numpy as np

from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.engines.media_probe import probe_media
from podcast_mcp.engines.sample_grid import Piece, PieceCells, lay_out
from podcast_mcp.engines.session_timeline import (
    SessionTimeline,
    TimelineClipSpan,
    clip_timeline_overlap_to_source,
)
from podcast_mcp.models import ClipJoinMode, EpisodeProject
from podcast_mcp.util.binaries import resolve_ffmpeg_pair
from podcast_mcp.util.pcm_stream import NoAudioDecodedError
from podcast_mcp.util.process import run
from podcast_mcp.util.tracks import track_audio_path
from podcast_mcp.util.wav import open_wav


def _decode_f32(path: Path, sample_rate: int, ffmpeg: str | None, layout: list[str]) -> np.ndarray:
    result = run(
        [
            resolve_ffmpeg_pair(ffmpeg=ffmpeg).ffmpeg,
            "-v",
            "error",
            "-i",
            str(path),
            *layout,
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


def load_mono_full(path: Path, *, sample_rate: int = 8000, ffmpeg: str | None = None) -> np.ndarray:
    return _decode_f32(path, sample_rate, ffmpeg, ["-ac", "1"])


def load_channels_full(path: Path, *, sample_rate: int = 8000) -> np.ndarray:
    """Every channel of the first audio stream, one column each."""
    probe = probe_media(path)
    if probe is None:
        raise ValueError(f"{path} could not be probed")
    channels = max(1, probe.channels)
    # No -ac: any channel count asks ffmpeg to remix a layout that is not its default for
    # that count (quad, 3.0(back)), which sums channels the gate must judge apart.
    return _decode_f32(path, sample_rate, None, []).reshape(-1, channels)


def _clip_window(
    path: Path,
    span: TimelineClipSpan,
    cell: PieceCells,
    *,
    sample_rate: int,
    preserve_channels: bool,
) -> np.ndarray:
    start_sec = float(span.source_start) + cell.first / sample_rate
    duration_sec = cell.count / sample_rate
    if preserve_channels:
        return load_wav_channels_window(
            path,
            start_sec=start_sec,
            duration_sec=duration_sec,
            sample_rate=sample_rate,
        )
    return load_mono_window(
        path,
        start_sec=start_sec,
        duration_sec=duration_sec,
        sample_rate=sample_rate,
    )


def raw_samples_on_timeline(
    spans: list[TimelineClipSpan],
    paths: list[Path],
    *,
    sources: dict[Path, np.ndarray],
    sample_rate: int = 8000,
    preserve_channels: bool = False,
) -> np.ndarray:
    """Raw clips placed on the timeline: mono, or ``(frames, channels)`` with
    ``preserve_channels``, where a mono clip on a multichannel lane fills every channel."""
    if not spans:
        load = load_channels_full if preserve_channels else load_mono_full
        if paths[0] not in sources:
            sources[paths[0]] = load(paths[0], sample_rate=sample_rate)
        return sources[paths[0]]
    order = sorted(range(len(spans)), key=lambda i: float(spans[i].timeline_start))
    spans = [spans[i] for i in order]
    paths = [paths[i] for i in order]
    cells = lay_out(
        [
            Piece(
                float(span.source_start),
                float(span.source_end),
                float(span.timeline_start),
                float(span.timeline_end),
            )
            for span, path in zip(spans, paths, strict=True)
        ],
        sample_rate,
    )
    end = max(0, *(cell.stop for cell in cells))
    layout: tuple[int, ...] = ()
    placed: np.ndarray | None = None
    for span, path, cell in zip(spans, paths, cells, strict=True):
        if cell.count <= 0:
            continue
        window = _clip_window(
            path, span, cell, sample_rate=sample_rate, preserve_channels=preserve_channels
        )
        if window.size < cell.count:
            raise ValueError(f"clip {span.clip.id} source samples are unavailable")
        chunk = window[: cell.count]
        if preserve_channels:
            if chunk.ndim == 1:
                chunk = chunk.reshape(-1, 1)
            if placed is None:
                layout = chunk.shape[1:]
                placed = np.zeros((end, *layout), dtype=np.float32)
            elif placed.shape[1:] != chunk.shape[1:]:
                raise ValueError("selected media channel layouts differ")
            placed[cell.dest : cell.stop] += chunk
        else:
            if placed is None:
                placed = np.zeros(end, dtype=np.float32)
            placed[cell.dest : cell.stop] += chunk
    if placed is None:
        return np.zeros(0 if not preserve_channels else (0, 1), dtype=np.float32)
    return placed


def raw_timeline_samples(
    project: EpisodeProject,
    track_id: str,
    *,
    sample_rate: int = 8000,
    sources: dict[Path, np.ndarray] | None = None,
    preserve_channels: bool = False,
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
    samples = raw_samples_on_timeline(
        spans,
        paths,
        sources=sources if sources is not None else {},
        sample_rate=sample_rate,
        preserve_channels=preserve_channels,
    )
    return np.zeros_like(samples) if not spans and track.timeline_empty else samples


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
        window = loader(
            track_audio_path(project, track_id),
            start_sec=start,
            duration_sec=end - start,
            sample_rate=sample_rate,
        )
        return np.zeros_like(window) if track.timeline_empty else window
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
    with open_wav(path) as source:
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
