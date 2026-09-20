"""Pipeline assemble/reconcile/analyze_cleanup benchmarks (pytest -m slow)."""

from __future__ import annotations

import json
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.clips_ops import clips_for_track
from podcast_mcp.engines.audio_audit import (
    AnalysisPolicy,
    analyze_cleanup,
    compute_word_audibility_map,
)
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
)
from podcast_mcp.pipeline import steps


@dataclass
class PipelineBenchmarkResult:
    assemble_sec: float = 0.0
    clip_count: int = 0
    render_track_to_file_calls: int = 0
    ffmpeg_subprocess_calls: int = 0
    reconcile_sec: float = 0.0
    load_mono_full_calls: int = 0
    compute_word_audibility_map_calls: int = 0
    analyze_cleanup_sec: float = 0.0
    analyze_cleanup_map_calls: int = 0
    track_durations: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "assemble_sec": round(self.assemble_sec, 3),
            "clip_count": self.clip_count,
            "render_track_to_file_calls": self.render_track_to_file_calls,
            "ffmpeg_subprocess_calls": self.ffmpeg_subprocess_calls,
            "reconcile_sec": round(self.reconcile_sec, 3),
            "load_mono_full_calls": self.load_mono_full_calls,
            "compute_word_audibility_map_calls": self.compute_word_audibility_map_calls,
            "analyze_cleanup_sec": round(self.analyze_cleanup_sec, 3),
            "analyze_cleanup_map_calls": self.analyze_cleanup_map_calls,
            "track_durations": {k: round(v, 3) for k, v in self.track_durations.items()},
        }


def _gapless_clip_project(
    tmp_path: Path,
    sample_wav: Path,
    *,
    clip_count: int = 50,
    clip_dur: float = 0.04,
) -> EpisodeProject:
    ws = tmp_path / "ws"
    ws.mkdir()
    raw = ws / "raw"
    raw.mkdir()
    audio = raw / "host.wav"
    audio.write_bytes(sample_wav.read_bytes())
    eng = FFmpegEngine()
    probe = eng.probe(audio)
    source_dur = probe.duration_sec

    project = EpisodeProject.create("bench_assemble", str(ws))
    project.ensure_dirs()
    project.timeline.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=source_dur),
        )
    )
    clips: list[Clip] = []
    timeline = 0.0
    source = 0.0
    for i in range(clip_count):
        take = min(clip_dur, source_dur - source)
        if take <= 0.001:
            break
        clips.append(
            Clip(
                id=f"c{i:04d}",
                track_id="host",
                source_start=source,
                source_end=source + take,
                timeline_start=timeline,
            )
        )
        source += take
        timeline += take
    project.timeline.clips = clips
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.3, confidence=0.9),
                TranscriptWord(text="world", start=0.5, end=0.8, confidence=0.9),
            ],
        )
    ]
    return project


def _two_track_reconcile_project(tmp_path: Path) -> EpisodeProject:
    project = EpisodeProject.create("bench_reconcile", str(tmp_path))
    for tid in ("host", "guest"):
        project.timeline.tracks.append(
            Track(
                id=tid,
                label=tid,
                role=TrackRole.DIALOGUE,
                speaker=tid,
            )
        )
        project.transcripts.append(
            Transcript(
                track_id=tid,
                words=[
                    TranscriptWord(text="one", start=0.0, end=0.4),
                    TranscriptWord(text="two", start=1.0, end=1.4),
                ],
            )
        )
    return project


def run_assemble_benchmark(project: EpisodeProject) -> PipelineBenchmarkResult:
    result = PipelineBenchmarkResult()
    result.clip_count = sum(
        len(clips_for_track(project, t.id)) for t in project.tracks if t.role == TrackRole.DIALOGUE
    )
    defaults = load_defaults()
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")

    original_render = eng.render_track_to_file
    render_calls = {"n": 0}
    subprocess_calls = {"n": 0}
    original_run = subprocess.run

    def counting_render(*args, **kwargs):
        render_calls["n"] += 1
        return original_render(*args, **kwargs)

    def counting_subprocess(cmd, *args, **kwargs):
        if isinstance(cmd, (list, tuple)) and cmd and "ffmpeg" in str(cmd[0]):
            subprocess_calls["n"] += 1
        return original_run(cmd, *args, **kwargs)

    eng.render_track_to_file = counting_render  # type: ignore[method-assign]
    with patch("subprocess.run", side_effect=counting_subprocess):
        t0 = time.perf_counter()
        with patch("podcast_mcp.pipeline.steps.ffmpeg", return_value=eng):
            steps.assemble_timeline(project, defaults)
        result.assemble_sec = time.perf_counter() - t0

    result.render_track_to_file_calls = render_calls["n"]
    result.ffmpeg_subprocess_calls = subprocess_calls["n"]
    for track in project.tracks:
        stem = project.artifacts_dir() / "tracks" / f"{track.id}.wav"
        if stem.is_file():
            result.track_durations[track.id] = eng.probe(stem).duration_sec
    return result


def run_reconcile_benchmark(project: EpisodeProject) -> PipelineBenchmarkResult:
    from podcast_mcp.engines import audio_audit

    result = PipelineBenchmarkResult()
    AnalysisPolicy.from_defaults()
    map_calls = {"n": 0}
    mono_calls = {"n": 0}
    original_map = compute_word_audibility_map
    original_mono = audio_audit.load_mono_full

    def counting_map(*args, **kwargs):
        map_calls["n"] += 1
        return original_map(*args, **kwargs)

    def counting_mono(*args, **kwargs):
        mono_calls["n"] += 1
        return original_mono(*args, **kwargs)

    def fake_rms(proj, track_id, t_start, t_end, **kwargs):
        if track_id == "host" and t_start >= 1.0:
            return -40.0
        if track_id == "guest" and t_start >= 1.0:
            return -30.0
        return -35.0

    with (
        patch(
            "podcast_mcp.engines.transcript_reconcile.compute_word_audibility_map",
            side_effect=counting_map,
        ),
        patch(
            "podcast_mcp.engines.audio_audit.load_mono_full",
            side_effect=counting_mono,
        ),
        patch(
            "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
            side_effect=fake_rms,
        ),
    ):
        t0 = time.perf_counter()
        steps.reconcile_transcript(project, load_defaults())
        result.reconcile_sec = time.perf_counter() - t0

    result.compute_word_audibility_map_calls = map_calls["n"]
    result.load_mono_full_calls = mono_calls["n"]
    return result


def run_analyze_cleanup_benchmark(project: EpisodeProject) -> PipelineBenchmarkResult:
    result = PipelineBenchmarkResult()
    pol = AnalysisPolicy.from_defaults()
    map_calls = {"n": 0}
    original_map = compute_word_audibility_map

    def counting_map(*args, **kwargs):
        map_calls["n"] += 1
        return original_map(*args, **kwargs)

    def fake_rms(proj, track_id, t_start, t_end, **kwargs):
        if track_id == "host" and t_start >= 1.0:
            return -40.0
        if track_id == "guest" and t_start >= 1.0:
            return -30.0
        return -35.0

    with (
        patch(
            "podcast_mcp.engines.audio_audit.compute_word_audibility_map",
            side_effect=counting_map,
        ),
        patch(
            "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
            side_effect=fake_rms,
        ),
        patch(
            "podcast_mcp.engines.audio_audit.measure_window_rms_db",
            return_value=-50.0,
        ),
    ):
        t0 = time.perf_counter()
        analyze_cleanup(project, policy=pol)
        result.analyze_cleanup_sec = time.perf_counter() - t0

    result.analyze_cleanup_map_calls = map_calls["n"]
    return result


@pytest.mark.slow
def test_benchmark_assemble_synthetic(tmp_path: Path, sample_wav: Path):
    project = _gapless_clip_project(tmp_path, sample_wav, clip_count=50)
    result = run_assemble_benchmark(project)
    expected_timeline_end = max(c.timeline_end for c in clips_for_track(project, "host"))
    assert result.clip_count == 50
    assert result.assemble_sec < 60.0
    # Single-pass render: the whole track assembles in one ffmpeg filter_complex
    # invocation, not one subprocess per clip.
    assert result.render_track_to_file_calls == 0
    assert 0 < result.ffmpeg_subprocess_calls < result.clip_count
    assert "host" in result.track_durations
    assert abs(result.track_durations["host"] - expected_timeline_end) < 0.15


@pytest.mark.slow
def test_benchmark_reconcile_synthetic(tmp_path: Path):
    project = _two_track_reconcile_project(tmp_path)
    result = run_reconcile_benchmark(project)
    assert result.reconcile_sec < 5.0
    assert result.compute_word_audibility_map_calls >= 1


@pytest.mark.slow
def test_benchmark_analyze_cleanup_synthetic(tmp_path: Path):
    project = _two_track_reconcile_project(tmp_path)
    result = run_analyze_cleanup_benchmark(project)
    assert result.analyze_cleanup_sec < 10.0
    assert result.analyze_cleanup_map_calls >= 1


@pytest.mark.slow
def test_benchmark_analyze_cleanup_map_pass_count(tmp_path: Path):
    project = _two_track_reconcile_project(tmp_path)
    pol = AnalysisPolicy.from_defaults()

    def fake_rms(proj, track_id, t_start, t_end, **kwargs):
        return -40.0

    map_calls = {"n": 0}
    original_map = compute_word_audibility_map

    def counting_map(*args, **kwargs):
        map_calls["n"] += 1
        return original_map(*args, **kwargs)

    with (
        patch(
            "podcast_mcp.engines.audio_audit.compute_word_audibility_map",
            side_effect=counting_map,
        ),
        patch(
            "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
            side_effect=fake_rms,
        ),
        patch(
            "podcast_mcp.engines.audio_audit.measure_window_rms_db",
            return_value=-50.0,
        ),
    ):
        analyze_cleanup(project, policy=pol)

    assert map_calls["n"] <= len(project.tracks) * 2


@pytest.mark.slow
def test_benchmark_optional_cleanup_test_assemble():
    from optional_projects import cleanup_test_project

    path = cleanup_test_project()
    if path is None:
        pytest.skip(
            "podcast-cleanup-test not available "
            "(set PODCAST_CLEANUP_TEST_PROJECT or use a sibling checkout)"
        )
    project = load_project(path)
    result = run_assemble_benchmark(project)
    print(json.dumps(result.to_dict(), indent=2))
    assert result.clip_count > 0
    assert result.assemble_sec < 600.0
