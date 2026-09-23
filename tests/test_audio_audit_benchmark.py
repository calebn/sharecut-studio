"""Regression coverage for deterministic audibility-cache decoder usage."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

from optional_projects import cleanup_test_project
from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.engines.audio_audit import (
    TrackRmsCache,
    build_track_rms_caches,
    compute_word_audibility_map,
    measure_window_rms_db,
)
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)


def _stem_project(tmp_path: Path) -> tuple[EpisodeProject, Path]:
    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    raw = tmp_path / "raw" / "host.wav"
    raw.parent.mkdir(exist_ok=True)
    sr = 8000
    dur = 2.0
    t = np.linspace(0, dur, int(sr * dur), endpoint=False)
    samples = (0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    import wave

    with wave.open(str(raw), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes((samples * 32767).astype(np.int16).tobytes())

    stem = project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(raw.read_bytes())

    project.timeline.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path=f"raw/{raw.name}", duration_sec=dur),
        )
    )
    project.timeline.clips.append(
        Clip(
            id="c-host",
            track_id="host",
            source_start=0.0,
            source_end=dur,
            timeline_start=0.0,
        )
    )
    words = [
        TranscriptWord(text="hello", start=0.1 + i * 0.05, end=0.14 + i * 0.05, confidence=0.9)
        for i in range(20)
    ]
    project.transcripts = [Transcript(track_id="host", words=words)]
    return project, stem


def test_track_rms_cache_decodes_once_and_reuses_samples(tmp_path: Path):
    project, stem = _stem_project(tmp_path)
    windows = [(w.start, w.end) for w in project.transcripts[0].words[:10]]

    samples = np.linspace(-0.5, 0.5, 16_000, dtype=np.float32)
    window_calls = 0
    full_calls = 0

    def fake_window(*_args, start_sec: float, duration_sec: float, **_kwargs):
        nonlocal window_calls
        window_calls += 1
        start = round(start_sec * 8_000)
        end = start + round(duration_sec * 8_000)
        return samples[start:end]

    def fake_full(*_args, **_kwargs):
        nonlocal full_calls
        full_calls += 1
        return samples

    with (
        patch("podcast_mcp.engines.audio_audit.load_mono_window", side_effect=fake_window),
        patch("podcast_mcp.engines.audio_audit.load_mono_full", side_effect=fake_full),
    ):
        uncached = [measure_window_rms_db(stem, start, end) for start, end in windows]
        assert window_calls == len(windows)

        cache = TrackRmsCache.from_timeline_stem(stem)
        cached = [measure_window_rms_db(stem, start, end, cache=cache) for start, end in windows]

    assert full_calls == 1
    assert window_calls == len(windows)
    np.testing.assert_allclose(cached, uncached, rtol=0.0, atol=1e-12)


def test_track_rms_cache_matches_ffmpeg_windows(tmp_path: Path):
    project, stem = _stem_project(tmp_path)
    cache = TrackRmsCache.from_timeline_stem(stem)
    for w in project.transcripts[0].words[:5]:
        ffmpeg_db = measure_window_rms_db(stem, w.start, w.end)
        cache_db = cache.rms_db(w.start, w.end)
        assert ffmpeg_db is not None and cache_db is not None
        assert abs(ffmpeg_db - cache_db) < 0.5


def test_build_track_rms_caches_uses_stems(tmp_path: Path):
    project, _ = _stem_project(tmp_path)
    caches = build_track_rms_caches(project)
    assert "host" in caches.caches


def test_compute_word_audibility_map_reuses_processed_stem_cache(tmp_path: Path):
    project, stem = _stem_project(tmp_path)
    samples = np.full(16_000, 0.3, dtype=np.float32)

    with (
        patch(
            "podcast_mcp.engines.audio_audit.load_mono_full",
            return_value=samples,
        ) as full_decode,
        patch("podcast_mcp.engines.audio_audit.load_mono_window") as window_decode,
    ):
        rows = compute_word_audibility_map(project, track_id="host")

    full_decode.assert_called_once_with(stem, sample_rate=8_000)
    window_decode.assert_not_called()
    assert len(rows) == len(project.transcripts[0].words)
    assert all(row["track_id"] == "host" for row in rows)
    assert all(row["own_rms_db"] is not None for row in rows)
    assert all(row["audibility_status"] == "audible" for row in rows)


@pytest.mark.skipif(
    cleanup_test_project() is None,
    reason="podcast-cleanup-test not available (PODCAST_CLEANUP_TEST_PROJECT or sibling checkout)",
)
def test_profile_cleanup_test_sample():
    import cProfile
    import pstats
    from io import StringIO

    from podcast_mcp.engines.audio_audit import compute_word_audibility_map
    from podcast_mcp.models import load_project

    path = cleanup_test_project()
    assert path is not None
    project = load_project(path)

    class LimitedProject:
        def __init__(self, p: EpisodeProject):
            self._p = p

        def __getattr__(self, name: str):
            return getattr(self._p, name)

        def transcript_for_track(self, track_id: str):
            tr = self._p.transcript_for_track(track_id)
            if tr is None:
                return None
            from podcast_mcp.models import Transcript

            return Transcript(
                track_id=tr.track_id,
                words=tr.words[:200],
            )

    limited = LimitedProject(project)
    profiler = cProfile.Profile()
    profiler.enable()
    with patch(
        "podcast_mcp.engines.audio_audit.load_mono_window",
        wraps=load_mono_window,
    ) as mocked:
        compute_word_audibility_map(limited, track_id="olga")
        ffmpeg_calls = mocked.call_count
    profiler.disable()
    stats = pstats.Stats(profiler)
    stats.sort_stats("cumulative")
    buf = StringIO()
    import contextlib

    with contextlib.redirect_stdout(buf):
        stats.print_stats(5)

    assert ffmpeg_calls == 0
