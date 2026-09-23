#!/usr/bin/env python3
"""Create a disposable long-form project for browser performance profiling.

The generated project uses sparse silent WAVs and flat overview peaks. It is a
UI/data-shape fixture, not an audio fidelity fixture, and is refused below
``tests/fixtures`` so it is never committed. The output is suitable for
``DAW_E2E_PROJECT`` and can be removed after the benchmark.
"""

from __future__ import annotations

import argparse
import math
import shutil
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from podcast_mcp.engines.peaks import write_silent_peaks
from podcast_mcp.models import load_project
from podcast_mcp.models.history import ProjectHistory
from podcast_mcp.models.episode import (
    Clip,
    CombinedTranscript,
    CombinedUtterance,
    EpisodeProject,
    RenderSection,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.project_store import ProjectStore
from podcast_mcp.util.wav import (
    MAX_PCM_WAV_DATA_BYTES,
    PCM_SAMPLE_WIDTH_BYTES,
    WAV_HEADER_BYTES,
    pcm_wav_header,
)

ROOT = Path(__file__).resolve().parents[1]
FIXTURES_ROOT = ROOT / "tests" / "fixtures"
SOURCE_FIXTURE = FIXTURES_ROOT / "aligned_dialogue"
BENCHMARK_NAME = "large-project benchmark (disposable)"
DEFAULT_DURATION = 2 * 60 * 60
DEFAULT_CLIPS = 1_200
DEFAULT_UTTERANCES = 10_000
SAMPLE_RATE = 48_000
TRACKS = ("reference", "guest")
# Each utterance holds the first 55% of its slot, leaving a silent gap before the next.
UTTERANCE_FILL = 0.55
# Timestamps are stored at millisecond precision; spans must survive rounding.
MIN_SPAN_SEC = 0.002


def _ms(value: float) -> float:
    return round(value, 3)


def _validate(output: Path, duration: float, clip_count: int, utterance_count: int) -> int:
    """Reject bad arguments before touching the filesystem; return the frame count."""
    if output.resolve().is_relative_to(FIXTURES_ROOT.resolve()):
        raise ValueError(f"refusing to write a disposable benchmark below {FIXTURES_ROOT}")
    if output.exists():
        raise FileExistsError(output)
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("duration must be a positive finite number of seconds")
    if clip_count < 2 or utterance_count < 2:
        raise ValueError("counts must be at least two")
    if clip_count % len(TRACKS):
        raise ValueError("clip count must be divisible by the track count")
    frames = round(duration * SAMPLE_RATE)
    if frames * PCM_SAMPLE_WIDTH_BYTES > MAX_PCM_WAV_DATA_BYTES:
        raise ValueError("duration is too long for a 16-bit mono RIFF WAV")
    duration_sec = frames / SAMPLE_RATE
    if duration_sec / (clip_count // len(TRACKS)) < MIN_SPAN_SEC:
        raise ValueError("too many clips for the duration (clips would be under 2 ms)")
    if duration_sec / utterance_count * UTTERANCE_FILL < MIN_SPAN_SEC:
        raise ValueError("too many utterances for the duration (words would be under 2 ms)")
    return frames


def _clips(duration_sec: float, clip_count: int) -> list[Clip]:
    """Contiguous clips per track from one shared bounds list (no rounding gaps)."""
    per_track = clip_count // len(TRACKS)
    span = duration_sec / per_track
    bounds = [_ms(index * span) for index in range(per_track)] + [duration_sec]
    return [
        Clip(
            id=f"benchmark-clip-{slot * len(TRACKS) + lane:05d}",
            track_id=track_id,
            source_start=bounds[slot],
            source_end=bounds[slot + 1],
            timeline_start=bounds[slot],
        )
        for slot in range(per_track)
        for lane, track_id in enumerate(TRACKS)
    ]


def _utterances(duration_sec: float, utterance_count: int) -> list[CombinedUtterance]:
    """One global, non-overlapping slot per utterance; speakers strictly alternate."""
    slot = duration_sec / utterance_count
    return [
        CombinedUtterance(
            track_id=TRACKS[index % len(TRACKS)],
            speaker=TRACKS[index % len(TRACKS)],
            start=_ms(index * slot),
            end=_ms(index * slot + slot * UTTERANCE_FILL),
            text=f"benchmark-{index:05d}",
        )
        for index in range(utterance_count)
    ]


def _shape_project(
    project: EpisodeProject, duration_sec: float, clip_count: int, utterance_count: int
) -> None:
    project.meta.name = BENCHMARK_NAME
    project.meta.created_at = datetime.now(UTC).isoformat()
    # The source's ingest offsets and render/pipeline state describe its 60 s audio.
    project.meta.ingest_alignment = None
    project.render = RenderSection()
    project.history = ProjectHistory()
    project.timeline.duration_sec = duration_sec
    for track in project.timeline.tracks:
        if track.media is not None:
            track.media.duration_sec = duration_sec
            track.media.sample_rate = SAMPLE_RATE
            track.media.channels = 1
    for source in project.sources:
        source.duration_sec = duration_sec
        source.sample_rate = SAMPLE_RATE
        source.channels = 1
    project.timeline.clips = _clips(duration_sec, clip_count)

    utterances = _utterances(duration_sec, utterance_count)
    project.transcript_data.per_track = [
        Transcript(
            track_id=track_id,
            language="en",
            words=[
                TranscriptWord(text=row.text, start=row.start, end=row.end, confidence=0.95)
                for row in utterances
                if row.track_id == track_id
            ],
        )
        for track_id in TRACKS
    ]
    # Keep the combined view explicit: the normal merge groups close words into
    # long turns, which would benchmark one pathological DOM node instead of a
    # realistic alternating-speaker transcript.
    project.transcript_data.combined = CombinedTranscript(utterances=utterances)


def _write_sparse_wav(path: Path, frames: int) -> None:
    """Create a seekable silent WAV whose data payload consumes no blocks."""
    data_size = frames * PCM_SAMPLE_WIDTH_BYTES
    with path.open("wb") as wav:
        wav.write(pcm_wav_header(data_size, SAMPLE_RATE))
        wav.truncate(WAV_HEADER_BYTES + data_size)


def _write_tree(
    staging: Path, final: Path, project: EpisodeProject, frames: int, duration_sec: float
) -> None:
    project.meta.workspace_dir = str(staging)
    ProjectStore(staging / "episode.project.json").commit(project)
    for folder in ("raw", "sources"):
        (staging / folder).mkdir()
        for track_id in TRACKS:
            _write_sparse_wav(staging / folder / f"{track_id}.wav", frames)
    for track in project.timeline.tracks:
        if track.media is None:
            continue
        write_silent_peaks(
            staging / track.media.path,
            staging / "artifacts" / "peaks" / f"{track.id}.json",
            duration_sec,
            source=final / track.media.path,
        )


def build_project(
    output: Path,
    *,
    duration: float = DEFAULT_DURATION,
    clip_count: int = DEFAULT_CLIPS,
    utterance_count: int = DEFAULT_UTTERANCES,
) -> Path:
    """Write a valid project with unique clips and alternating speaker turns.

    The tree is built in a sibling staging directory and renamed into place, so
    a failure never leaves a partial ``output`` behind.
    """
    frames = _validate(output, duration, clip_count, utterance_count)
    duration_sec = frames / SAMPLE_RATE
    project = load_project(SOURCE_FIXTURE / "episode.project.json")
    _shape_project(project, duration_sec, clip_count, utterance_count)

    final = output.resolve()
    final.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{final.name}.", dir=final.parent))
    try:
        _write_tree(staging, final, project, frames, duration_sec)
        staging.rename(final)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return final / "episode.project.json"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True, help="new disposable output directory")
    parser.add_argument("--duration", type=float, default=DEFAULT_DURATION)
    parser.add_argument("--clips", type=int, default=DEFAULT_CLIPS)
    parser.add_argument("--utterances", type=int, default=DEFAULT_UTTERANCES)
    args = parser.parse_args()
    print(
        build_project(
            args.out,
            duration=args.duration,
            clip_count=args.clips,
            utterance_count=args.utterances,
        )
    )


if __name__ == "__main__":
    main()
