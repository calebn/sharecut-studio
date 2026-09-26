#!/usr/bin/env python3
"""Create a disposable long-form project for browser performance profiling.

The generated project uses sparse silent WAVs and, per track, a ``.wfpk``
waveform pyramid written without decoding (``--waveform synthetic`` draws a
speech-like envelope; ``silent`` draws nothing). It is a UI/data-shape
fixture, not an audio fidelity fixture, and is refused below ``tests/fixtures``
so it is never committed. The output is suitable for ``DAW_E2E_PROJECT`` and
can be removed after the benchmark.
"""

from __future__ import annotations

import argparse
import math
import shutil
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

from podcast_mcp.engines.waveform_pyramid import (
    media_key,
    pyramid_path,
    ref_slug,
    write_synthetic_pyramid,
)
from podcast_mcp.history.manager import snapshot_from_project
from podcast_mcp.models import load_project
from podcast_mcp.models.episode import (
    Clip,
    CombinedTranscript,
    CombinedUtterance,
    EpisodeProject,
    MediaAsset,
    RenderSection,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.models.history import HistoryEntry, ProjectHistory
from podcast_mcp.project_store import ProjectStore, history_index_path, history_snapshot_path
from podcast_mcp.util.wav import (
    MAX_PCM_WAV_DATA_BYTES,
    PCM_SAMPLE_WIDTH_BYTES,
    WAV_HEADER_BYTES,
    pcm_wav_header,
)
from podcast_mcp.util.workspace_paths import workspace_relpath

ROOT = Path(__file__).resolve().parents[1]
FIXTURES_ROOT = ROOT / "tests" / "fixtures"
SOURCE_FIXTURE = FIXTURES_ROOT / "aligned_dialogue"
BENCHMARK_NAME = "large-project benchmark (disposable)"
DEFAULT_DURATION = 2 * 60 * 60
DEFAULT_CLIPS = 1_200
DEFAULT_UTTERANCES = 10_000
SAMPLE_RATE = 48_000
# The source fixture's speakers; they alternate in the transcript. --tracks adds t2, t3, ...
TRACKS = ("reference", "guest")
DEFAULT_TRACKS = len(TRACKS)
WAVEFORM_MODES = ("synthetic", "silent")
# Each utterance holds the first 55% of its slot, leaving a silent gap before the next.
UTTERANCE_FILL = 0.55
# Timestamps are stored at millisecond precision; spans must survive rounding.
MIN_SPAN_SEC = 0.002
# Each step is a before/after pair (two entries) toggling the first clip's fade-in.
DEFAULT_HISTORY_STEPS = 500
HISTORY_LABEL = "benchmark fade toggle"
HISTORY_OPERATION = "benchmark_fade_toggle"
HISTORY_FADE_MS = 10


def _ms(value: float) -> float:
    return round(value, 3)


def _track_ids(track_count: int) -> tuple[str, ...]:
    return TRACKS + tuple(f"t{index}" for index in range(len(TRACKS), track_count))


def _validate(
    output: Path,
    duration: float,
    clip_count: int,
    utterance_count: int,
    track_count: int = DEFAULT_TRACKS,
    waveform: str = "synthetic",
    history_steps: int = DEFAULT_HISTORY_STEPS,
) -> int:
    """Reject bad arguments before touching the filesystem; return the frame count."""
    if output.resolve().is_relative_to(FIXTURES_ROOT.resolve()):
        raise ValueError(f"refusing to write a disposable benchmark below {FIXTURES_ROOT}")
    if output.exists():
        raise FileExistsError(output)
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("duration must be a positive finite number of seconds")
    if clip_count < 2 or utterance_count < 2:
        raise ValueError("counts must be at least two")
    if track_count < len(TRACKS):
        raise ValueError(f"track count must be at least {len(TRACKS)}")
    if waveform not in WAVEFORM_MODES:
        raise ValueError(f"waveform must be one of {', '.join(WAVEFORM_MODES)}")
    if history_steps < 0:
        raise ValueError("history steps must be zero or more")
    if clip_count % track_count:
        raise ValueError("clip count must be divisible by the track count")
    frames = round(duration * SAMPLE_RATE)
    if frames * PCM_SAMPLE_WIDTH_BYTES > MAX_PCM_WAV_DATA_BYTES:
        raise ValueError("duration is too long for a 16-bit mono RIFF WAV")
    duration_sec = frames / SAMPLE_RATE
    if duration_sec / (clip_count // track_count) < MIN_SPAN_SEC:
        raise ValueError("too many clips for the duration (clips would be under 2 ms)")
    if duration_sec / utterance_count * UTTERANCE_FILL < MIN_SPAN_SEC:
        raise ValueError("too many utterances for the duration (words would be under 2 ms)")
    return frames


def _clips(duration_sec: float, clip_count: int, track_ids: tuple[str, ...]) -> list[Clip]:
    """Contiguous clips per track from one shared bounds list (no rounding gaps)."""
    per_track = clip_count // len(track_ids)
    span = duration_sec / per_track
    bounds = [_ms(index * span) for index in range(per_track)] + [duration_sec]
    return [
        Clip(
            id=f"benchmark-clip-{slot * len(track_ids) + lane:05d}",
            track_id=track_id,
            source_start=bounds[slot],
            source_end=bounds[slot + 1],
            timeline_start=bounds[slot],
        )
        for slot in range(per_track)
        for lane, track_id in enumerate(track_ids)
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
    project: EpisodeProject,
    duration_sec: float,
    clip_count: int,
    utterance_count: int,
    track_ids: tuple[str, ...] = TRACKS,
) -> None:
    project.meta.name = BENCHMARK_NAME
    project.meta.created_at = datetime.now(UTC).isoformat()
    # The source's ingest offsets and render/pipeline state describe its 60 s audio.
    project.meta.ingest_alignment = None
    project.render = RenderSection()
    project.history = ProjectHistory()
    project.timeline.duration_sec = duration_sec
    for track_id in track_ids[len(TRACKS) :]:
        project.timeline.tracks.append(
            Track(
                id=track_id,
                label=track_id,
                role=TrackRole.DIALOGUE,
                speaker=track_id,
                media=MediaAsset(path=f"raw/{track_id}.wav"),
            )
        )
    for track in project.timeline.tracks:
        if track.media is not None:
            track.media.duration_sec = duration_sec
            track.media.sample_rate = SAMPLE_RATE
            track.media.channels = 1
    for source in project.sources:
        source.duration_sec = duration_sec
        source.sample_rate = SAMPLE_RATE
        source.channels = 1
    project.timeline.clips = _clips(duration_sec, clip_count, track_ids)

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


def _write_waveform(
    project: EpisodeProject, track_id: str, audio: Path, frames: int, *, seed: int, waveform: str
) -> Path:
    """Write the track's ``.wfpk`` under the key the viewer will ask for."""
    st = audio.stat()
    key = media_key(workspace_relpath(project, audio), st.st_size, st.st_mtime_ns)
    out = pyramid_path(project.artifacts_dir() / "peaks", ref_slug("track", track_id), key)
    return write_synthetic_pyramid(
        out,
        sample_rate=SAMPLE_RATE,
        total_frames=frames,
        seed=seed,
        silent=waveform == "silent",
    )


def _seed_history(project: EpisodeProject, steps: int) -> None:
    """Seed ``steps`` before/after pairs sharing two full-size snapshot files.

    The snapshots differ only in the first clip's ``fade_in_ms``; the chain ends
    on the base state so the project file matches the cursor.
    """
    if steps == 0:
        project.history = ProjectHistory()
        return
    clip = project.timeline.clips[0]
    original = clip.fade_in_ms
    base = snapshot_from_project(project)
    clip.fade_in_ms = HISTORY_FADE_MS
    faded = snapshot_from_project(project)
    clip.fade_in_ms = original
    index_path = history_index_path(project)
    files: dict[str, str] = {}
    for name, snapshot in (("base", base), ("faded", faded)):
        path = history_snapshot_path(index_path, f"benchmark-{name}")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(snapshot.model_dump_json(indent=2, by_alias=True), encoding="utf-8")
        files[name] = workspace_relpath(project, path)
    states = ["base" if (steps - j) % 2 == 0 else "faded" for j in range(steps + 1)]
    started = datetime.now(UTC) - timedelta(seconds=2 * steps)
    entries: list[HistoryEntry] = []
    for step in range(steps):
        params = {"track_id": clip.track_id, "fade_ms": HISTORY_FADE_MS, "step": step}
        for phase, state in (("before", states[step]), ("after", states[step + 1])):
            entries.append(
                HistoryEntry(
                    id=f"benchmark-{len(entries):06d}",
                    label=f"{phase} {HISTORY_LABEL}",
                    created_at=(started + timedelta(seconds=len(entries))).isoformat(),
                    snapshot_file=files[state],
                    operation=HISTORY_OPERATION,
                    params=params,
                )
            )
    project.history = ProjectHistory(cursor=len(entries) - 1, entries=entries)


def _write_tree(
    staging: Path,
    project: EpisodeProject,
    frames: int,
    *,
    track_ids: tuple[str, ...] = TRACKS,
    waveform: str = "synthetic",
    history_steps: int = 0,
) -> None:
    project.meta.workspace_dir = str(staging)
    _seed_history(project, history_steps)
    ProjectStore(staging / "episode.project.json").commit(project)
    for folder in ("raw", "sources"):
        (staging / folder).mkdir()
        for track_id in track_ids:
            _write_sparse_wav(staging / folder / f"{track_id}.wav", frames)
    for seed, track in enumerate(project.timeline.tracks):
        if track.media is None:
            continue
        # Keys hash the workspace-relative path, so they survive the rename to *final*.
        _write_waveform(
            project, track.id, staging / track.media.path, frames, seed=seed, waveform=waveform
        )


def build_project(
    output: Path,
    *,
    duration: float = DEFAULT_DURATION,
    clip_count: int = DEFAULT_CLIPS,
    utterance_count: int = DEFAULT_UTTERANCES,
    track_count: int = DEFAULT_TRACKS,
    waveform: str = "synthetic",
    history_steps: int = DEFAULT_HISTORY_STEPS,
) -> Path:
    """Write a valid project with unique clips and alternating speaker turns.

    The tree is built in a sibling staging directory and renamed into place, so
    a failure never leaves a partial ``output`` behind.
    """
    frames = _validate(
        output, duration, clip_count, utterance_count, track_count, waveform, history_steps
    )
    duration_sec = frames / SAMPLE_RATE
    track_ids = _track_ids(track_count)
    project = load_project(SOURCE_FIXTURE / "episode.project.json")
    _shape_project(project, duration_sec, clip_count, utterance_count, track_ids)

    final = output.resolve()
    final.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{final.name}.", dir=final.parent))
    try:
        _write_tree(
            staging,
            project,
            frames,
            track_ids=track_ids,
            waveform=waveform,
            history_steps=history_steps,
        )
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
    parser.add_argument(
        "--tracks",
        type=int,
        default=DEFAULT_TRACKS,
        help="dialogue tracks; extras are t2, t3, ... (no transcripts)",
    )
    parser.add_argument(
        "--waveform",
        choices=WAVEFORM_MODES,
        default="synthetic",
        help="per-track .wfpk: speech-like envelope or all-zero",
    )
    parser.add_argument(
        "--history",
        type=int,
        default=DEFAULT_HISTORY_STEPS,
        help="history steps (two entries each); 0 leaves the history empty",
    )
    args = parser.parse_args()
    print(
        build_project(
            args.out,
            duration=args.duration,
            clip_count=args.clips,
            utterance_count=args.utterances,
            track_count=args.tracks,
            waveform=args.waveform,
            history_steps=args.history,
        )
    )


if __name__ == "__main__":
    main()
