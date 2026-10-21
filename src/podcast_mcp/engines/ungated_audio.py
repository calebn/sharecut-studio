from __future__ import annotations

import contextlib
import subprocess
import threading
from collections.abc import Iterator
from pathlib import Path

import numpy as np

from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.engines.media_probe import probe_media
from podcast_mcp.engines.mono_downmix import ffmpeg_mono_mean_layout
from podcast_mcp.engines.sample_grid import Piece, lay_out
from podcast_mcp.engines.session_timeline import (
    SessionTimeline,
    TimelineClipSpan,
    clip_timeline_overlap_to_source,
)
from podcast_mcp.models import ClipJoinMode, EpisodeProject
from podcast_mcp.util.batch_scope import scoped_by_file
from podcast_mcp.util.binaries import resolve_ffmpeg_pair
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.pcm_stream import NoAudioDecodedError
from podcast_mcp.util.process import popen, run
from podcast_mcp.util.tracks import track_audio_path
from podcast_mcp.util.wav import open_wav


def _decode_f32(path: Path, sample_rate: int, ffmpeg: str | None, layout: list[str]) -> np.ndarray:
    return scoped_by_file(
        "decode",
        path,
        (sample_rate, ffmpeg, tuple(layout)),
        lambda: _decode_f32_uncached(path, sample_rate, ffmpeg, layout),
    )


def _decode_f32_uncached(
    path: Path, sample_rate: int, ffmpeg: str | None, layout: list[str]
) -> np.ndarray:
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


def resample_stream(chunks: Iterator[np.ndarray], from_rate: int, to_rate: int) -> np.ndarray:
    """Mono ``chunks`` converted by ffmpeg exactly as decoding a wav of them at ``to_rate`` would.

    The chunks stream through one ffmpeg process, so the converter's state carries across
    chunk edges as it does across a file, and only the converted result is held.
    """
    if from_rate == to_rate:
        return np.concatenate(list(chunks))
    process = popen(
        [
            resolve_ffmpeg_pair().ffmpeg,
            "-v",
            "error",
            "-f",
            "f32le",
            "-ar",
            str(from_rate),
            "-ac",
            "1",
            "-i",
            "pipe:0",
            "-ar",
            str(to_rate),
            "-f",
            "f32le",
            "pipe:1",
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    failure: list[BaseException] = []

    def feed() -> None:
        assert process.stdin is not None
        try:
            for chunk in chunks:
                process.stdin.write(np.ascontiguousarray(chunk, dtype="<f4").tobytes())
        except BrokenPipeError:
            pass
        except BaseException as exc:
            failure.append(exc)
        finally:
            with contextlib.suppress(BrokenPipeError):
                process.stdin.close()

    feeder = threading.Thread(target=feed, daemon=True)
    feeder.start()
    assert process.stdout is not None and process.stderr is not None
    converted = process.stdout.read()
    error = process.stderr.read()
    feeder.join()
    code = process.wait()
    if failure:
        raise failure[0]
    if code != 0:
        raise RuntimeError(f"ffmpeg resample failed: {error.decode(errors='replace')[-500:]}")
    return np.frombuffer(converted, dtype="<f4")


def load_mono_full(path: Path, *, sample_rate: int = 8000, ffmpeg: str | None = None) -> np.ndarray:
    return _decode_f32(path, sample_rate, ffmpeg, ffmpeg_mono_mean_layout(path))


def load_channels_full(path: Path, *, sample_rate: int = 8000) -> np.ndarray:
    """Every channel of the first audio stream, one column each."""
    probe = probe_media(path)
    if probe is None:
        raise CodedValueError(
            f"{path.name} could not be probed. Choose a playable audio file.", code="invalid_audio"
        )
    channels = max(1, probe.channels)
    # No -ac: any channel count asks ffmpeg to remix a layout that is not its default for
    # that count (quad, 3.0(back)), which sums channels the gate must judge apart.
    return _decode_f32(path, sample_rate, None, []).reshape(-1, channels)


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
    load = load_channels_full if preserve_channels else load_mono_full
    for path in paths:
        if path not in sources:
            sources[path] = load(path, sample_rate=sample_rate)
    if not spans:
        return sources[paths[0]]
    if len(spans) == 1:
        span = spans[0]
        source = sources[paths[0]]
        if (
            span.timeline_start == 0
            and span.source_start == 0
            and span.timeline_end == span.source_end
            and round(float(span.source_end) * sample_rate) == source.shape[0]
        ):
            return source
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
    layout = max(sources[path].shape[1:] for path in paths)
    placed = np.zeros((max(0, *(cell.stop for cell in cells)), *layout), dtype=np.float32)
    for span, path, cell in zip(spans, paths, cells, strict=True):
        source = sources[path]
        if cell.dest < 0 or cell.first < 0 or cell.first + cell.count > source.shape[0]:
            raise CodedValueError(
                f"clip {span.clip.id} source samples are unavailable. Re-render the track and try again.",
                code="source_samples_unavailable",
            )
        placed[cell.dest : cell.stop] += source[cell.first : cell.first + cell.count]
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
        raise CodedValueError(
            f"track {track_id} is unavailable. Add media to that track first.",
            code="track_has_no_media",
        )
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
        raise CodedValueError(
            "raw timeline window is unavailable. Re-render the track and try again.",
            code="source_samples_unavailable",
        )
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
            raise CodedValueError(
                f"clip {span.clip.id} source samples are unavailable. Re-render the track and try again.",
                code="source_samples_unavailable",
            )
        if samples is None:
            samples = np.zeros(
                (round((end - start) * sample_rate), *window.shape[1:]), dtype=np.float32
            )
        if samples.shape[1:] != window.shape[1:]:
            raise CodedValueError(
                "selected media channel layouts differ. Use clips with the same channel layout.",
                code="channel_layout_mismatch",
            )
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
            raise CodedValueError(
                "full-band channel evidence needs mono/stereo PCM16 at the evidence rate or below",
                code="stem_format_unsupported",
            )
        first = round(start_sec * rate)
        count = round(duration_sec * rate)
        if first < 0 or first + count > source.getnframes():
            raise CodedValueError(
                "source channel samples are unavailable. Re-render the track and try again.",
                code="source_samples_unavailable",
            )
        source.setpos(first)
        samples = (
            np.frombuffer(source.readframes(count), dtype="<i2")
            .reshape(-1, channels)
            .astype(np.float32)
            / 32768
        )
    if samples.shape[0] != count:
        raise CodedValueError(
            "source channel samples are unavailable. Re-render the track and try again.",
            code="source_samples_unavailable",
        )
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
