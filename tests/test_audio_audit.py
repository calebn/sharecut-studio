from __future__ import annotations

import json
import wave
from dataclasses import replace
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from audibility_floors import floors_at
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.audio_quality import suppress_low_audibility_words
from podcast_mcp.engines.audio_audit import (
    AnalysisPolicy,
    CopyPath,
    TrackRmsCache,
    TrackRmsCacheSet,
    analyze_cleanup,
    analyze_gate_overreach,
    build_track_rms_caches,
    compute_word_audibility_map,
    list_bleed_words,
    list_flagged_words,
    list_low_audibility_words,
    load_mono_full,
    measure_window_rms_db,
    recommend_boundary_fades,
)
from podcast_mcp.engines.bleed_echo import EchoPairProfile
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.level_profile import LevelProfile
from podcast_mcp.engines.play_audit import write_stem_hash
from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    ProcessingChain,
    ProcessingEffect,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.util.dsp import DIGITAL_SILENCE_DB
from podcast_mcp.util.pcm_stream import NoAudioDecodedError


def _floor_at(audibility_db: float) -> LevelProfile:
    """A track profile whose audibility floor is ``audibility_db`` (27 dB under its speech)."""
    speech = audibility_db + 27.0
    return LevelProfile(room_db=DIGITAL_SILENCE_DB, speech_db=speech, loud_db=speech + 5.0)


def test_analysis_policy_from_defaults():
    pol = AnalysisPolicy.from_defaults(defaults=load_defaults())
    assert str(pol.ml_backend).lower() in ("off", "false", "0")


def test_measure_window_rms_db(sample_wav: Path):
    db = measure_window_rms_db(sample_wav, 0.0, 0.5)
    assert db is not None
    assert db > -60


def test_list_low_audibility_flags_quiet_word(sample_wav: Path, tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    raw = tmp_path / "raw" / "host.wav"
    raw.parent.mkdir(exist_ok=True)
    raw.write_bytes(sample_wav.read_bytes())
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        )
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.5, confidence=0.9),
            ],
        )
    ]

    with (
        patch("podcast_mcp.engines.audio_audit.TrackRmsCache.rms_db", return_value=-50.0),
        patch("podcast_mcp.engines.audio_audit.TrackRmsCache.profile", new=_floor_at(-40.0)),
    ):
        flagged = list_low_audibility_words(project, track_id="host", defaults=load_defaults())
    assert len(flagged) == 1
    assert flagged[0]["text"] == "hello"


def test_list_low_audibility_reads_the_floor_of_a_track_with_no_decoded_cache(
    sample_wav: Path, tmp_path: Path
):
    project = EpisodeProject.create("ep", str(tmp_path))
    raw = tmp_path / "raw" / "host.wav"
    raw.parent.mkdir(exist_ok=True)
    raw.write_bytes(sample_wav.read_bytes())
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    project.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="hello", start=0.0, end=0.5)])
    ]
    with (
        patch("podcast_mcp.engines.audio_audit.measure_window_rms_db", return_value=-50.0),
        patch("podcast_mcp.engines.audio_audit.file_level_profile", return_value=_floor_at(-40.0)),
    ):
        flagged = list_low_audibility_words(
            project, track_id="host", caches=TrackRmsCacheSet(), defaults=load_defaults()
        )
    assert [(row["text"], row["rms_db"], row["threshold_db"]) for row in flagged] == [
        ("hello", -50.0, -40.0)
    ]


def test_gate_overreach_no_gate(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    report = analyze_gate_overreach(project, "host", defaults=load_defaults())
    assert report["gate_present"] is False
    assert report["risk"] == "none"


def test_gate_overreach_high_risk_many_issues(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        )
    ]
    project.processing_chains = [
        ProcessingChain(
            track_id="host",
            effects=[ProcessingEffect(effect="agate", params={})],
        )
    ]
    words = [TranscriptWord(text=f"w{i}", start=i * 0.6, end=i * 0.6 + 0.4) for i in range(6)]
    project.transcripts = [Transcript(track_id="host", words=words)]
    with patch(
        "podcast_mcp.engines.audio_audit.measure_window_rms_db",
        side_effect=[-20.0, -50.0] * 20,
    ):
        report = analyze_gate_overreach(
            project, "host", policy=AnalysisPolicy(), defaults=load_defaults()
        )
    assert report["risk"] == "high"


def test_gate_overreach_with_gate_and_mock_issues(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    project.processing_chains = [
        ProcessingChain(
            track_id="host",
            effects=[ProcessingEffect(effect="agate", params={})],
        )
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="test", start=0.0, end=0.5),
            ],
        )
    ]
    with patch(
        "podcast_mcp.engines.audio_audit.measure_window_rms_db",
        side_effect=[-20.0, -50.0, None, None],
    ):
        report = analyze_gate_overreach(
            project, "host", policy=AnalysisPolicy(), defaults=load_defaults()
        )
    assert report["gate_present"] is True


def test_recommend_boundary_fades_adjacent_clips(tmp_path: Path):
    from podcast_mcp.models import MediaAsset

    project = EpisodeProject.create("ep", str(tmp_path))
    wav = tmp_path / "host.wav"
    wav.write_bytes(b"fake")
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path=str(wav), duration_sec=2.0),
        )
    ]
    project.timeline.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=0.0,
            fade_out_ms=0,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=1.0,
            source_end=2.0,
            timeline_start=1.0,
            fade_in_ms=0,
        ),
    ]
    with (
        patch(
            "podcast_mcp.engines.audio_audit.TrackRmsCache.from_timeline_stem",
            side_effect=Exception("no cache"),
        ),
        patch(
            "podcast_mcp.engines.audio_audit._processed_track_path",
            return_value=None,
        ),
        patch(
            "podcast_mcp.engines.audio_audit.timeline_to_source",
            return_value=(wav, 1.0),
        ),
        patch(
            "podcast_mcp.engines.audio_audit.measure_window_rms_db",
            side_effect=[-10.0, -30.0],
        ),
    ):
        recs = recommend_boundary_fades(
            project,
            policy=AnalysisPolicy(
                boundary_jump_db=5.0, recommended_fade_ms=20, harsh_fade_max_ms=80
            ),
            track_id="host",
            defaults=load_defaults(),
        )
    assert recs
    assert recs[0]["kind"] == "harsh_join"
    assert recs[0]["level_jump_db"] == 20.0
    # 20 dB jump → scaled fade (max(20, min(80, 40))) = 40
    assert recs[0]["recommended_fade_in_ms"] == 40


def test_recommend_boundary_fades_treats_sub_tolerance_gap_as_join(tmp_path: Path):
    from podcast_mcp.engines.clips_ops import JOIN_GAP_TOLERANCE_SEC
    from podcast_mcp.models import MediaAsset

    project = EpisodeProject.create("ep", str(tmp_path))
    wav = tmp_path / "host.wav"
    wav.write_bytes(b"fake")
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path=str(wav), duration_sec=2.0),
        )
    ]
    project.timeline.clips = [
        Clip(id="a", track_id="host", source_start=0.0, source_end=1.0, timeline_start=0.0),
        Clip(
            id="b",
            track_id="host",
            source_start=1.0,
            source_end=2.0,
            timeline_start=1.0 + JOIN_GAP_TOLERANCE_SEC / 2,
        ),
    ]
    with (
        patch(
            "podcast_mcp.engines.audio_audit.TrackRmsCache.from_timeline_stem",
            side_effect=Exception("no cache"),
        ),
        patch("podcast_mcp.engines.audio_audit._processed_track_path", return_value=None),
        patch("podcast_mcp.engines.audio_audit.timeline_to_source", return_value=(wav, 1.0)),
        patch(
            "podcast_mcp.engines.audio_audit.measure_window_rms_db",
            side_effect=[-10.0, -30.0],
        ),
    ):
        recs = recommend_boundary_fades(
            project,
            policy=AnalysisPolicy(
                boundary_jump_db=5.0, recommended_fade_ms=20, harsh_fade_max_ms=80
            ),
            track_id="host",
            defaults=load_defaults(),
        )
    assert [r["kind"] for r in recs] == ["harsh_join"]

    project.timeline.clips[1].timeline_start = 1.0 + JOIN_GAP_TOLERANCE_SEC + 1e-3
    recs = recommend_boundary_fades(project, track_id="host", defaults=load_defaults())
    assert recs[0]["kind"] == "gap_between_clips"


def test_fade_ms_for_level_jump_scales() -> None:
    from podcast_mcp.engines.audio_audit import fade_ms_for_level_jump

    pol = AnalysisPolicy(boundary_jump_db=12.0, recommended_fade_ms=20, harsh_fade_max_ms=80)
    assert fade_ms_for_level_jump(5.0, pol) == 20
    assert fade_ms_for_level_jump(20.0, pol) == 40
    assert fade_ms_for_level_jump(42.0, pol) == 80


def test_suppress_low_audibility_mutates_and_rebuilds(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="quiet", start=0.0, end=0.2),
                TranscriptWord(text="loud", start=0.3, end=0.5),
            ],
        )
    ]
    result = suppress_low_audibility_words(
        project,
        word_keys=[{"track_id": "host", "word_index": 0}],
        defaults=load_defaults(),
    )
    assert result["suppressed_count"] == 1
    assert project.transcripts[0].words[0].suppressed is True
    assert project.transcripts[0].words[0].audibility_locked is True
    merged = TranscriptionEngine(defaults=load_defaults()).merge_transcripts(project)
    assert "quiet" not in merged.utterances[0].text if merged.utterances else True


def test_suppress_low_audibility_heuristic_respects_lock(tmp_path: Path):
    """#781: a bulk (no word_keys) apply must not override a locked-unsuppressed word."""
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(
                    text="quiet", start=0.0, end=0.2, suppressed=False, audibility_locked=True
                ),
                TranscriptWord(text="loud", start=0.3, end=0.5),
            ],
        )
    ]
    with patch(
        "podcast_mcp.edits.audio_quality.list_low_audibility_words",
        return_value=[{"track_id": "host", "word_index": 0}],
    ):
        result = suppress_low_audibility_words(project, track_id="host", defaults=load_defaults())
    assert result["suppressed_count"] == 0
    assert project.transcripts[0].words[0].suppressed is False
    assert project.transcripts[0].words[0].audibility_locked is True


def test_zero_duration_words_classified_inaudible(tmp_path: Path):
    """ASR junk with start==end cannot be RMS-measured; map as inaudible."""
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        )
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="much,", start=0.5, end=0.5, confidence=0.9),
                TranscriptWord(text="Victoria", start=0.5, end=0.5, confidence=0.01),
                TranscriptWord(text="hello", start=1.0, end=1.4, confidence=0.9),
            ],
        )
    ]
    rows = compute_word_audibility_map(project, track_id="host", defaults=load_defaults())
    by_idx = {r["word_index"]: r for r in rows}
    assert by_idx[0]["audibility_status"] == "inaudible"
    assert by_idx[0]["reason"] == "zero_duration_word"
    assert by_idx[1]["audibility_status"] == "inaudible"
    assert by_idx[1]["reason"] == "zero_duration_word"
    # Non-degenerate word still goes through normal RMS path (may be audible/inaudible).
    assert 2 in by_idx
    assert by_idx[2]["reason"] != "zero_duration_word"


def test_sandwiched_zero_duration_deferred_not_suppressed(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=3.0,
            timeline_start=0.0,
        )
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="know", start=1.0, end=1.2),
                TranscriptWord(text="what", start=1.2, end=1.2),
                TranscriptWord(text="I'm", start=1.2, end=1.5),
            ],
        )
    ]
    rows = compute_word_audibility_map(project, track_id="host", defaults=load_defaults())
    by_idx = {r["word_index"]: r for r in rows}
    assert by_idx[1]["audibility_status"] == "deferred"
    assert by_idx[1]["reason"] == "sandwiched_zero_duration_word"

    from podcast_mcp.engines.transcript_reconcile import reconcile_transcript

    result = reconcile_transcript(project, dry_run=False, defaults=load_defaults())
    assert result.applied
    assert project.transcripts[0].words[1].suppressed is False
    merged = TranscriptionEngine(defaults=load_defaults()).merge_transcripts(project)
    assert any("what" in (u.text or "") for u in merged.utterances)


def test_effective_copy_lag_follows_lane_latency_steps() -> None:
    from podcast_mcp.engines.bleed_audibility_lag import effective_copy_lag_sec
    from podcast_mcp.engines.bleed_lag_segments import LagSegment, LagSteps

    steps = LagSteps(
        (
            LagSegment(start_sec=0.0, shift_sec=-0.12, frames=10, correlation=0.9),
            LagSegment(
                start_sec=180.0, shift_sec=-0.2, frames=10, correlation=0.9, gap_sec=(150.0, 210.0)
            ),
        ),
        step_cost=1.0,
    )
    assert effective_copy_lag_sec(0.14, steps, 50.0) == pytest.approx(0.14)
    assert effective_copy_lag_sec(0.14, steps, 200.0) == pytest.approx(0.22)


def test_short_word_audibility_uses_loudest_frame(tmp_path: Path):
    """A 40-100 ms word is not judged by span-mean RMS alone (#1594)."""
    from podcast_mcp.engines.audio_audit import _track_levels

    project = EpisodeProject.create("ep", str(tmp_path))
    caches = TrackRmsCacheSet(
        caches={
            "host": TrackRmsCache(
                samples=np.zeros(16_000, dtype=np.float32),
                recording_profile=LevelProfile(room_db=-60.0, speech_db=-30.0, loud_db=-28.0),
            )
        }
    )
    offsets = {"host": -30.0}
    with (
        patch(
            "podcast_mcp.engines.audio_audit.timeline_frame_levels_db",
            return_value=np.array([-38.0]),
        ),
        patch(
            "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
            return_value=-45.0,
        ),
    ):
        peak = _track_levels(
            project,
            ["host"],
            1.0,
            1.06,
            {},
            caches,
            offsets,
            word_dur=0.06,
            defaults=load_defaults(),
        )
        mean = _track_levels(
            project,
            ["host"],
            1.0,
            1.06,
            {},
            caches,
            offsets,
            word_dur=0.2,
            defaults=load_defaults(),
        )
    assert peak["host"] == pytest.approx(-8.0)
    assert mean["host"] == pytest.approx(-15.0)


def test_short_word_map_audible_when_peak_reaches_voice_floor(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=3.0,
            timeline_start=0.0,
        )
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="to", start=1.0, end=1.06, confidence=1.0)],
        )
    ]
    profile = LevelProfile(room_db=-60.0, speech_db=-30.0, loud_db=-28.0)
    caches = TrackRmsCacheSet(
        caches={
            "host": TrackRmsCache(
                samples=np.zeros(48_000, dtype=np.float32), recording_profile=profile
            )
        }
    )
    with (
        patch(
            "podcast_mcp.engines.audio_audit.timeline_frame_levels_db",
            return_value=np.array([-38.0]),
        ),
        patch(
            "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
            return_value=-45.0,
        ),
        patch(
            "podcast_mcp.engines.audio_audit.build_track_rms_caches",
            return_value=caches,
        ),
    ):
        rows = compute_word_audibility_map(project, track_id="host", defaults=load_defaults())
    assert rows[0]["audibility_status"] == "audible"


def test_anomalous_word_duration_deferred_skips_mean_rms(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host"),
        Track(id="guest", label="Guest", role=TrackRole.DIALOGUE, speaker="Guest"),
    ]
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=12.0,
            timeline_start=0.0,
        ),
        Clip(
            id="c2",
            track_id="guest",
            source_start=0.0,
            source_end=12.0,
            timeline_start=0.0,
        ),
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="about.", start=1.0, end=10.0),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text="loud", start=5.0, end=5.3),
            ],
        ),
    ]
    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        return_value=-20.0,
    ):
        rows = compute_word_audibility_map(
            project,
            track_id="host",
            policy=AnalysisPolicy(max_word_audibility_sec=2.0),
            defaults=load_defaults(),
        )
    by_idx = {r["word_index"]: r for r in rows}
    assert by_idx[0]["audibility_status"] == "deferred"
    assert by_idx[0]["reason"] == "anomalous_word_duration"

    from podcast_mcp.engines.transcript_reconcile import reconcile_transcript

    reconcile_transcript(
        project,
        dry_run=False,
        policy=AnalysisPolicy(max_word_audibility_sec=2.0),
        defaults=load_defaults(),
    )
    assert project.transcripts[0].words[0].suppressed is False


def test_analyze_cleanup_summary(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    report = analyze_cleanup(project, defaults=load_defaults())
    assert "tracks" in report
    assert "summary" in report
    assert report["tracks"][0]["health"] is None


def test_analyze_cleanup_includes_health_with_processed_stem(tmp_path: Path, sample_wav: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    stem = project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(sample_wav.read_bytes())
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    report = analyze_cleanup(project, defaults=load_defaults())
    health = report["tracks"][0]["health"]
    assert health is not None
    assert "crest_factor" in health
    assert "hum" in health
    assert "hum_detected" in health["hum"]


def test_mcp_analyze_cleanup_tool(tmp_path: Path):
    from podcast_mcp.mcp import server as mcp_server

    path = mcp_server.episode_create(str(tmp_path / "ws"))
    out = mcp_server.analyze_cleanup_tool(path)
    data = json.loads(out)
    assert "summary" in data


def test_apply_fade_recommendations(tmp_path: Path):
    from podcast_mcp.edits.audio_quality import apply_fade_recommendations

    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    project.timeline.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=0.0,
            fade_out_ms=0,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=1.0,
            source_end=2.0,
            timeline_start=1.0,
            fade_in_ms=0,
        ),
    ]
    recs = [
        {
            "left_clip_id": "a",
            "clip_id": "b",
            "recommended_fade_in_ms": 25,
            "recommended_fade_out_ms": 25,
        }
    ]
    result = apply_fade_recommendations(project, recs, defaults=load_defaults())
    assert result["applied_fade_updates"] == 2
    # Dialogue fades capped at render.join_fade_max_ms (40)
    assert project.clips[0].fade_out_ms == 25
    assert project.clips[1].fade_in_ms == 25


def test_edit_service_analyze_cleanup(minimal_project, tmp_workspace):
    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.services.document import AnalysisService

    ws = ProjectWorkspace.open(minimal_project)
    report = AnalysisService(ws).analyze_cleanup()
    assert "summary" in report


def test_edit_service_suppress_low_audibility(minimal_project, tmp_workspace):
    from podcast_mcp.models import Transcript, TranscriptWord
    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.services.document import AnalysisService

    proj = load_project(minimal_project)
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="x", start=0.0, end=0.1)],
        )
    ]
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    out = AnalysisService(ws).suppress_low_audibility(
        word_keys=[{"track_id": "host", "word_index": 0}]
    )
    assert out["suppressed_count"] == 1


def test_analyze_cleanup_matches_separate_scans(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
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
    pol = AnalysisPolicy(bleed_dominance_db=6.0)

    def fake_rms(proj, track_id, t_start, t_end, **kwargs):
        if track_id == "host" and t_start >= 1.0:
            return -40.0
        if track_id == "guest" and t_start >= 1.0:
            return -30.0
        return -50.0

    with (
        patch(
            "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
            side_effect=fake_rms,
        ),
        patch(
            "podcast_mcp.engines.audio_audit.measure_window_rms_db",
            return_value=-50.0,
        ),
        floors_at(-35.0),
        patch("podcast_mcp.engines.audio_audit.file_level_profile", return_value=_floor_at(-35.0)),
    ):
        expected_low = {
            tid: list_low_audibility_words(project, track_id=tid, defaults=load_defaults())
            for tid in ("host", "guest")
        }
        expected_flagged = {
            tid: list_flagged_words(project, policy=pol, track_id=tid, defaults=load_defaults())
            for tid in ("host", "guest")
        }
        report = analyze_cleanup(project, policy=pol, defaults=load_defaults())

    by_track = {row["track_id"]: row for row in report["tracks"]}
    for tid in ("host", "guest"):
        assert by_track[tid]["low_audibility_count"] == len(expected_low[tid])
        assert by_track[tid]["flagged_count"] == len(expected_flagged[tid])
        assert by_track[tid]["low_audibility_sample"] == expected_low[tid][:10]
        assert by_track[tid]["flagged_sample"] == expected_flagged[tid][:10]


def test_gap_between_clips_recommends_fade(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    project.timeline.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=0.0,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=1.0,
            source_end=2.0,
            timeline_start=1.5,
        ),
    ]
    recs = recommend_boundary_fades(project, track_id="host", defaults=load_defaults())
    assert recs[0]["kind"] == "gap_between_clips"


def test_analysis_policy_from_custom_defaults():
    pol = AnalysisPolicy.from_defaults(
        {
            "analysis": {
                "heuristics": {
                    "bleed_text_match_enabled": False,
                    "bleed_text_match_min_overlap_sec": 0.1,
                    "bleed_text_match_min_dominance_db": 4.0,
                },
                "ml_backend": "nisqa",
            }
        }
    )
    assert pol.ml_backend == "nisqa"
    assert pol.bleed_text_match_enabled is False
    assert pol.bleed_text_match_min_overlap_sec == 0.1
    assert pol.bleed_text_match_min_dominance_db == 4.0


def test_load_mono_full_decodes(sample_wav: Path):
    samples = load_mono_full(sample_wav)
    assert samples.size > 0
    assert samples.dtype.name == "float32"


def test_load_mono_full_empty_raises(tmp_path: Path):
    empty = tmp_path / "empty.wav"
    empty.write_bytes(b"not audio")
    with patch("podcast_mcp.engines.ungated_audio.run") as run:
        run.return_value = MagicMock(stdout=b"", returncode=0)
        with pytest.raises(NoAudioDecodedError, match="no audio decoded"):
            load_mono_full(empty)


def test_track_rms_cache_windowing(sample_wav: Path):
    cache = TrackRmsCache.from_timeline_stem(sample_wav)
    assert cache.rms_db(0.0, 0.004) is None
    db = cache.rms_db(0.0, 0.5)
    assert db is not None
    assert cache.rms_db(100.0, 101.0) is None


def test_build_track_rms_caches_uses_processed_stem(sample_wav: Path, tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    stem = project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(sample_wav.read_bytes())
    write_stem_hash(project, "host", defaults=load_defaults())
    caches = build_track_rms_caches(project, defaults=load_defaults())
    assert caches.get("host") is not None


def test_measure_window_rms_db_with_cache(sample_wav: Path):
    cache = TrackRmsCache.from_timeline_stem(sample_wav)
    assert measure_window_rms_db(sample_wav, 0.0, 0.5, cache=cache) is not None
    assert measure_window_rms_db(sample_wav, 0.0, 0.001, cache=cache) is None


def test_measure_window_rms_db_decode_failure(sample_wav: Path):
    with patch(
        "podcast_mcp.engines.audio_audit.load_mono_window",
        side_effect=ValueError("bad"),
    ):
        assert measure_window_rms_db(sample_wav, 0.0, 0.5) is None


def test_compute_word_audibility_transcript_off(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    pol = AnalysisPolicy(transcript_mode="off")
    assert compute_word_audibility_map(project, policy=pol, defaults=load_defaults()) == []


def test_list_bleed_words_filters_status(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="x", start=0.0, end=0.4)],
        )
    ]
    rows = [
        {
            "audibility_status": "bleed",
            "text": "x",
            "track_id": "host",
            "word_index": 0,
        },
        {
            "audibility_status": "audible",
            "text": "y",
            "track_id": "host",
            "word_index": 1,
        },
    ]
    with patch(
        "podcast_mcp.engines.audio_audit.compute_word_audibility_map",
        return_value=rows,
    ):
        bleed = list_bleed_words(project, defaults=load_defaults())
    assert len(bleed) == 1
    assert bleed[0]["audibility_status"] == "bleed"


def test_inaudible_when_own_rms_missing(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="ghost", start=0.0, end=0.4)],
        )
    ]
    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        return_value=None,
    ):
        rows = compute_word_audibility_map(project, defaults=load_defaults())
    assert rows[0]["audibility_status"] == "inaudible"


def test_gate_overreach_no_transcript_words(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    project.processing_chains = [
        ProcessingChain(
            track_id="host",
            effects=[ProcessingEffect(effect="agate", params={})],
        )
    ]
    report = analyze_gate_overreach(project, "host", defaults=load_defaults())
    assert report["risk"] == "unknown"
    assert "No transcript words" in report["advice"]


def test_gate_overreach_moderate_risk(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        )
    ]
    project.processing_chains = [
        ProcessingChain(
            track_id="host",
            effects=[ProcessingEffect(effect="agate", params={})],
        )
    ]
    words = [TranscriptWord(text=f"w{i}", start=i * 0.6, end=i * 0.6 + 0.4) for i in range(2)]
    project.transcripts = [Transcript(track_id="host", words=words)]

    def fake_measure(path, start, end, **kwargs):
        return -50.0 if end - start <= 0.04 else -20.0

    with patch(
        "podcast_mcp.engines.audio_audit.measure_window_rms_db",
        side_effect=fake_measure,
    ):
        report = analyze_gate_overreach(
            project, "host", policy=AnalysisPolicy(), defaults=load_defaults()
        )
    assert report["risk"] == "moderate"
    assert "Review flagged words" in report["advice"]


def test_gate_overreach_processed_onset_chop(tmp_path: Path, sample_wav: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    stem = project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(sample_wav.read_bytes())
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        )
    ]
    project.processing_chains = [
        ProcessingChain(
            track_id="host",
            effects=[ProcessingEffect(effect="agate", params={})],
        )
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="one", start=0.0, end=0.4)],
        )
    ]

    def fake_cache_rms(self, start, end):
        return -50.0 if end - start <= 0.04 else -20.0

    with (
        patch(
            "podcast_mcp.engines.audio_audit.measure_window_rms_db",
            return_value=-20.0,
        ),
        patch.object(TrackRmsCache, "rms_db", fake_cache_rms),
    ):
        report = analyze_gate_overreach(
            project, "host", policy=AnalysisPolicy(), defaults=load_defaults()
        )
    assert any(i["kind"] == "processed_onset_chop" for i in report["issues"])


def test_recommend_boundary_fades_processed_track(sample_wav: Path, tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    stem = project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(sample_wav.read_bytes())
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    project.timeline.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=0.0,
            fade_out_ms=25,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=1.0,
            source_end=2.0,
            timeline_start=1.0,
            fade_in_ms=25,
        ),
    ]
    with patch(
        "podcast_mcp.engines.audio_audit.measure_window_rms_db",
        side_effect=[-10.0, -30.0],
    ):
        recs = recommend_boundary_fades(
            project,
            policy=AnalysisPolicy(boundary_jump_db=5.0),
            track_id="host",
            defaults=load_defaults(),
        )
    assert recs and recs[0]["kind"] == "harsh_join"


def test_recommend_boundary_fades_raw_timeline_source(tmp_path: Path, sample_wav: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    raw = tmp_path / "raw" / "host.wav"
    raw.parent.mkdir(exist_ok=True)
    raw.write_bytes(sample_wav.read_bytes())
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    project.timeline.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=0.0,
            fade_out_ms=0,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=1.0,
            source_end=2.0,
            timeline_start=1.0,
            fade_in_ms=0,
        ),
    ]
    with patch(
        "podcast_mcp.engines.audio_audit.measure_window_rms_db",
        side_effect=[-12.0, -12.0],
    ):
        recs = recommend_boundary_fades(project, track_id="host", defaults=load_defaults())
    assert recs
    assert "missing boundary fades" in recs[0]["reason"]


def test_list_low_audibility_uses_proc_cache(sample_wav: Path, tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    stem = project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(sample_wav.read_bytes())
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="quiet", start=0.0, end=0.5),
                TranscriptWord(text="skip", start=0.6, end=0.8, suppressed=True),
            ],
        )
    ]
    write_stem_hash(project, "host", defaults=load_defaults())
    with (
        patch("podcast_mcp.engines.audio_audit.TrackRmsCache.rms_db", return_value=-55.0),
        patch("podcast_mcp.engines.audio_audit.TrackRmsCache.profile", new=_floor_at(-40.0)),
    ):
        flagged = list_low_audibility_words(project, track_id="host", defaults=load_defaults())
    assert len(flagged) == 1
    assert flagged[0]["context_before"] == ""


def test_analyze_cleanup_suggest_mode_and_skip_non_dialogue(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host"),
        Track(id="music", label="Music", role=TrackRole.MUSIC, speaker="Music"),
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="x", start=0.0, end=0.4)],
        )
    ]
    audibility_map = [
        {
            "track_id": "host",
            "word_index": 0,
            "text": "x",
            "start": 0.0,
            "end": 0.4,
            "audibility_status": "inaudible",
            "dominant_track": None,
            "suppressed": False,
        }
    ]
    pol = AnalysisPolicy(transcript_mode="suggest")
    with (
        patch(
            "podcast_mcp.engines.audio_audit.analyze_gate_overreach",
            return_value={"risk": "none", "gate_present": False},
        ),
        patch(
            "podcast_mcp.engines.audio_audit.list_low_audibility_words",
            return_value=[],
        ),
        patch(
            "podcast_mcp.engines.audio_audit.compute_word_audibility_map",
            return_value=audibility_map,
        ),
        patch(
            "podcast_mcp.engines.audio_audit.recommend_boundary_fades",
            return_value=[{"kind": "harsh_join"}],
        ),
    ):
        report = analyze_cleanup(project, policy=pol, defaults=load_defaults())
    assert len(report["tracks"]) == 1
    assert report["tracks"][0]["suppression_recommendations"] == [
        {"track_id": "host", "source_id": None, "word_index": 0}
    ]
    assert "boundary fade" in report["summary"]


def test_analyze_cleanup_summary_no_issues(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    with (
        patch(
            "podcast_mcp.engines.audio_audit.analyze_gate_overreach",
            return_value={"risk": "none", "gate_present": False},
        ),
        patch(
            "podcast_mcp.engines.audio_audit.list_low_audibility_words",
            return_value=[],
        ),
        patch(
            "podcast_mcp.engines.audio_audit.compute_word_audibility_map",
            return_value=[],
        ),
        patch(
            "podcast_mcp.engines.audio_audit.recommend_boundary_fades",
            return_value=[],
        ),
    ):
        report = analyze_cleanup(project, defaults=load_defaults())
    assert report["summary"] == "No significant cleanup issues detected."


def test_analyze_cleanup_shares_cache_set(tmp_path: Path, monkeypatch):
    from podcast_mcp.engines import audio_audit as aa

    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    shared = aa.TrackRmsCacheSet()
    builds = []
    seen = []
    monkeypatch.setattr(aa, "build_track_rms_caches", lambda _, **_kw: builds.append(1) or shared)

    def record(*args, **kwargs):
        seen.append(kwargs["caches"])
        return []

    def record_gate(*args, **kwargs):
        seen.append(kwargs["caches"])
        return {"risk": "none"}

    monkeypatch.setattr(aa, "analyze_gate_overreach", record_gate)
    monkeypatch.setattr(aa, "list_low_audibility_words", record)
    monkeypatch.setattr(aa, "compute_word_audibility_map", record)
    monkeypatch.setattr(aa, "recommend_boundary_fades", record)
    aa.analyze_cleanup(project, defaults=load_defaults())
    assert len(builds) == 1
    assert seen == [shared] * 4


def test_rms_db_edge_cases(monkeypatch):
    from podcast_mcp.engines import audio_audit as aa
    from podcast_mcp.util.dsp import rms_db

    assert rms_db(np.array([], dtype=np.float32)) == DIGITAL_SILENCE_DB
    assert rms_db(np.zeros(100, dtype=np.float32)) == DIGITAL_SILENCE_DB
    assert rms_db(np.zeros(100, dtype=np.float32), floor_db=-400.0) == -400.0
    cache = aa.TrackRmsCache(np.zeros(16_000, dtype=np.float32), 16_000)
    assert cache.rms_db(0.0, 0.5) == DIGITAL_SILENCE_DB
    assert cache.rms_db(5.0, 6.0) is None
    monkeypatch.setattr(aa, "load_mono_window", lambda *a, **k: np.array([], dtype=np.float32))
    assert aa.measure_window_rms_db(Path("x.wav"), 0.0, 1.0) is None


def test_rms_for_track_at_timeline_paths(sample_wav: Path, tmp_path: Path):
    from podcast_mcp.engines import audio_audit as aa

    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    raw = tmp_path / "raw" / "host.wav"
    raw.parent.mkdir(exist_ok=True)
    raw.write_bytes(sample_wav.read_bytes())
    stem = project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(sample_wav.read_bytes())
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            gain_db=3.0,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        )
    ]
    caches = build_track_rms_caches(project, defaults=load_defaults())
    proc_rms = aa._rms_for_track_at_timeline(
        project, "host", 0.0, 0.5, caches=caches, defaults=load_defaults()
    )
    assert proc_rms is not None
    assert proc_rms > -80.0

    stem.unlink()
    raw_rms = aa._rms_for_track_at_timeline(project, "host", 0.0, 0.5, defaults=load_defaults())
    assert raw_rms is not None

    with patch(
        "podcast_mcp.engines.lane_window.lane_clip_placements",
        side_effect=RuntimeError("bad map"),
    ):
        assert (
            aa._rms_for_track_at_timeline(project, "host", 0.0, 0.5, defaults=load_defaults())
            is None
        )


def test_a_stale_stem_is_not_read_at_the_timeline_seconds_an_edit_moved(
    sample_wav: Path, tmp_path: Path
):
    from podcast_mcp.engines import audio_audit as aa

    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    raw = tmp_path / "raw" / "host.wav"
    raw.parent.mkdir(exist_ok=True)
    raw.write_bytes(sample_wav.read_bytes())
    stem = project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(sample_wav.read_bytes())
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    project.timeline.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=2.0, timeline_start=0.0)
    ]

    # The stem is not fresh (it has no hash from a render): the lane's recording is read.
    with (
        patch("podcast_mcp.engines.play_audit.stem_is_fresh", return_value=False),
        patch("podcast_mcp.engines.audio_audit.load_mono_window") as stem_read,
        patch(
            "podcast_mcp.engines.lane_window.load_mono_window", return_value=np.zeros(4000)
        ) as lane,
    ):
        assert (
            aa.timeline_window_samples(project, "host", 0.0, 0.5, defaults=load_defaults())
            is not None
        )
    stem_read.assert_not_called()
    lane.assert_called_once()
    assert lane.call_args.kwargs["antialias"] is True

    # A fresh stem is read as it is.
    with (
        patch("podcast_mcp.engines.play_audit.stem_is_fresh", return_value=True),
        patch(
            "podcast_mcp.engines.audio_audit.load_mono_window", return_value=np.zeros(4000)
        ) as stem_read,
        patch("podcast_mcp.engines.lane_window.load_mono_window") as lane,
    ):
        assert (
            aa.timeline_window_samples(project, "host", 0.0, 0.5, defaults=load_defaults())
            is not None
        )
    stem_read.assert_called_once()
    assert stem_read.call_args.kwargs["antialias"] is True
    lane.assert_not_called()


def test_list_low_audibility_timeline_source_error(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="x", start=0.0, end=0.4)],
        )
    ]
    with patch(
        "podcast_mcp.engines.audio_audit.timeline_to_source",
        side_effect=RuntimeError("bad map"),
    ):
        assert list_low_audibility_words(project, track_id="host", defaults=load_defaults()) == []


def test_gate_overreach_skips_bad_timeline_map(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    project.processing_chains = [
        ProcessingChain(
            track_id="host",
            effects=[ProcessingEffect(effect="agate", params={})],
        )
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="x", start=0.0, end=0.4)],
        )
    ]
    with patch(
        "podcast_mcp.engines.audio_audit.timeline_to_source",
        side_effect=RuntimeError("bad map"),
    ):
        report = analyze_gate_overreach(project, "host", defaults=load_defaults())
    assert report["issues"] == []


def test_recommend_boundary_fades_timeline_map_error(tmp_path: Path, sample_wav: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    raw = tmp_path / "raw" / "host.wav"
    raw.parent.mkdir(exist_ok=True)
    raw.write_bytes(sample_wav.read_bytes())
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    project.timeline.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=0.0,
            fade_out_ms=0,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=1.0,
            source_end=2.0,
            timeline_start=1.0,
            fade_in_ms=0,
        ),
    ]
    with patch(
        "podcast_mcp.engines.audio_audit.timeline_to_source",
        side_effect=RuntimeError("bad map"),
    ):
        recs = recommend_boundary_fades(project, track_id="host", defaults=load_defaults())
    assert recs and "missing boundary fades" in recs[0]["reason"]


def test_analyze_cleanup_skips_non_dialogue_track(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="music", label="Music", role=TrackRole.MUSIC, speaker="Music"),
    ]
    report = analyze_cleanup(project, track_id="music", defaults=load_defaults())
    assert report["tracks"] == []
    assert report["summary"] == "No dialogue tracks to analyze."


def test_analyze_cleanup_summary_with_gate_and_bleed(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    per_track = [
        {
            "track_id": "host",
            "gate_analysis": {"risk": "high"},
            "low_audibility_count": 2,
            "flagged_count": 3,
            "bleed_count": 1,
            "fade_recommendations": [{"kind": "harsh_join"}],
        }
    ]
    from podcast_mcp.engines import audio_audit as aa

    summary = aa._summarize_report(per_track)
    assert "gate risk high" in summary
    assert "low-audibility" in summary
    assert "flagged words" in summary
    assert "bleed words" in summary
    assert "boundary fade" in summary


def test_analyze_cleanup_flags_high_bleed_ratio(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text=f"w{i}", start=float(i), end=i + 0.4) for i in range(5)],
        )
    ]
    bleed_rows = [
        {"track_id": "host", "word_index": i, "audibility_status": "bleed"} for i in range(2)
    ]
    with (
        patch(
            "podcast_mcp.engines.audio_audit.analyze_gate_overreach",
            return_value={"risk": "none", "gate_present": False},
        ),
        patch(
            "podcast_mcp.engines.audio_audit.list_low_audibility_words",
            return_value=[],
        ),
        patch(
            "podcast_mcp.engines.audio_audit.compute_word_audibility_map",
            return_value=bleed_rows,
        ),
        patch(
            "podcast_mcp.engines.audio_audit.recommend_boundary_fades",
            return_value=[],
        ),
    ):
        report = analyze_cleanup(
            project, policy=AnalysisPolicy(bleed_ratio_warn_threshold=0.2), defaults=load_defaults()
        )
    row = report["tracks"][0]
    assert row["bleed_ratio"] == 0.4
    assert "high_bleed_warning" in row
    assert "podcast-mute-bleed" in row["high_bleed_warning"]
    assert "HIGH BLEED" in report["summary"]


def test_analyze_cleanup_no_bleed_warning_below_threshold(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text=f"w{i}", start=float(i), end=i + 0.4) for i in range(10)],
        )
    ]
    bleed_rows = [{"track_id": "host", "word_index": 0, "audibility_status": "bleed"}]
    with (
        patch(
            "podcast_mcp.engines.audio_audit.analyze_gate_overreach",
            return_value={"risk": "none", "gate_present": False},
        ),
        patch(
            "podcast_mcp.engines.audio_audit.list_low_audibility_words",
            return_value=[],
        ),
        patch(
            "podcast_mcp.engines.audio_audit.compute_word_audibility_map",
            return_value=bleed_rows,
        ),
        patch(
            "podcast_mcp.engines.audio_audit.recommend_boundary_fades",
            return_value=[],
        ),
    ):
        report = analyze_cleanup(
            project, policy=AnalysisPolicy(bleed_ratio_warn_threshold=0.2), defaults=load_defaults()
        )
    row = report["tracks"][0]
    assert row["bleed_ratio"] == 0.1
    assert "high_bleed_warning" not in row


def test_analyze_cleanup_bleed_ratio_none_without_transcript(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    report = analyze_cleanup(project, defaults=load_defaults())
    assert report["tracks"][0]["bleed_ratio"] is None


def test_analyze_cleanup_off_mode_skips_audibility_map(tmp_path: Path):
    """``transcript_mode: off`` must not pay for an acoustic pass it never reports:
    characterization pin, true on trunk and on this branch alike."""
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    project.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="x", start=0.0, end=0.4)])
    ]
    pol = AnalysisPolicy(transcript_mode="off")

    with patch(
        "podcast_mcp.engines.audio_audit.compute_word_audibility_map"
    ) as mock_audibility_map:
        report = analyze_cleanup(project, policy=pol, defaults=load_defaults())

    mock_audibility_map.assert_not_called()
    row = report["tracks"][0]
    assert row["flagged_count"] == 0
    assert "suppression_recommendations" not in row


def test_analyze_cleanup_suggest_mode_includes_text_match_loser(tmp_path: Path):
    """A word the acoustic map alone calls audible, but that loses an identical-text
    overlap to another track, still gets a suppression recommendation (#806): the
    recommendation comes from `word_targets`, the same per-word rule
    `reconcile_transcript` applies, not from the acoustic map on its own."""
    project = EpisodeProject.create("ep", str(tmp_path))
    for tid in ("host", "guest"):
        project.timeline.tracks.append(
            Track(id=tid, label=tid, role=TrackRole.DIALOGUE, speaker=tid)
        )
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.5, confidence=0.9),
                TranscriptWord(text="bleed", start=1.0, end=1.5, confidence=0.9),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text="world", start=0.0, end=0.5, confidence=0.9),
                TranscriptWord(text="bleed", start=1.0, end=1.5, confidence=0.85),
            ],
        ),
    ]
    pol = AnalysisPolicy(transcript_mode="suggest", bleed_text_match_enabled=True)

    def room_pair(source: str, bleed: str) -> EchoPairProfile:
        return EchoPairProfile(
            source_track_id=source,
            bleed_track_id=bleed,
            span_start=0.0,
            span_end=10.0,
            dominated_frames=100,
            copy_frames=40,
            consistent_frames=30,
            lag_ms=3.0,
            level_db=-18.0,
            examples=(1.0,),
            null_runs=8,
            null_copy_rate=0.05,
            null_consistent_rate=0.02,
        )

    # The identical-text rule runs only on a pair with measured bleed (#774); bleed
    # both ways keeps the loudness rule this test pins.
    with (
        patch(
            "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
            return_value=-35.0,
        ),
        patch(
            "podcast_mcp.engines.audio_audit.TrackRmsCacheSet.echo_pairs",
            new=lambda self: [room_pair("host", "guest"), room_pair("guest", "host")],
        ),
    ):
        report = analyze_cleanup(project, policy=pol, defaults=load_defaults())

    by_track = {row["track_id"]: row for row in report["tracks"]}
    assert by_track["guest"]["flagged_count"] == 0
    assert by_track["guest"]["suppression_recommendations"] == [
        {"track_id": "guest", "source_id": None, "word_index": 1}
    ]
    assert "suppression_recommendations" not in by_track["host"]


def test_audio_diagnostics_report_with_processed_stem(tmp_path: Path, sample_wav: Path):
    from podcast_mcp.edits.audio_quality import audio_diagnostics_report

    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    stem = project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(sample_wav.read_bytes())
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")

    report = audio_diagnostics_report(project, "host", defaults=load_defaults())
    assert report["track_id"] == "host"
    assert Path(report["spectrogram_png"]).is_file()
    assert Path(report["waveform_png"]).is_file()
    assert "crest_factor" in report["astats"]
    assert "hum_detected" in report["hum"]


def test_audio_diagnostics_report_with_time_window(tmp_path: Path, sample_wav: Path):
    from podcast_mcp.edits.audio_quality import audio_diagnostics_report

    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    stem = project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(sample_wav.read_bytes())
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")

    report = audio_diagnostics_report(
        project, "host", start_sec=0.0, end_sec=1.0, defaults=load_defaults()
    )
    assert "spectrogram_0.000_1.000" in report["spectrogram_png"]
    assert report["window"]["start"] == 0.0
    assert report["window"]["end"] == 1.0


def test_audio_diagnostics_report_pngs_false_omits_png_keys(
    tmp_path: Path, sample_wav: Path, monkeypatch
):
    from podcast_mcp.edits.audio_quality import audio_diagnostics_report

    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    stem = project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(sample_wav.read_bytes())
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")

    def boom_png(*_args, **_kwargs):
        raise AssertionError("PNG render should not run when pngs=False")

    monkeypatch.setattr(FFmpegEngine, "render_spectrogram", boom_png)
    monkeypatch.setattr(FFmpegEngine, "render_showwavespic", boom_png)
    report = audio_diagnostics_report(
        project, "host", start_sec=0.0, end_sec=1.0, pngs=False, defaults=load_defaults()
    )
    assert "spectrogram_png" not in report
    assert "waveform_png" not in report
    assert "crest_factor" in report["astats"]
    assert "hum_detected" in report["hum"]
    assert report["window"]["start"] == 0.0


def test_audio_diagnostics_windowed_hum_not_full_file(tmp_path: Path):
    from audition_eval import generate_tone, inject_hum_span
    from podcast_mcp.edits.audio_quality import audio_diagnostics_report
    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")

    clean = tmp_path / "clean.wav"
    mixed = tmp_path / "mixed.wav"
    generate_tone(clean, duration_sec=8.0, freq_hz=220.0)
    inject_hum_span(clean, mixed, start_sec=4.0, end_sec=8.0, freq_hz=60.0, mix_db=0.0)

    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    stem = project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(mixed.read_bytes())
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]

    clean_win = audio_diagnostics_report(
        project, "host", start_sec=0.0, end_sec=3.0, defaults=load_defaults()
    )
    hum_win = audio_diagnostics_report(
        project, "host", start_sec=4.5, end_sec=8.0, defaults=load_defaults()
    )
    assert clean_win["hum"]["hum_detected"] is False
    assert hum_win["hum"]["hum_detected"] is True
    assert "window" in hum_win


def test_audio_diagnostics_report_falls_back_to_raw_media(tmp_path: Path, sample_wav: Path):
    from podcast_mcp.edits.audio_quality import audio_diagnostics_report

    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    raw = tmp_path / "raw" / "host.wav"
    raw.parent.mkdir(parents=True, exist_ok=True)
    raw.write_bytes(sample_wav.read_bytes())
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")

    report = audio_diagnostics_report(project, "host", defaults=load_defaults())
    assert Path(report["spectrogram_png"]).is_file()


def test_audio_diagnostics_report_raises_without_media(tmp_path: Path):
    from podcast_mcp.edits.audio_quality import audio_diagnostics_report

    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    with pytest.raises(ValueError, match="no audio available"):
        audio_diagnostics_report(project, "host", defaults=load_defaults())


def test_audio_diagnostics_report_rejects_inverted_window(tmp_path: Path, sample_wav: Path):
    from podcast_mcp.edits.audio_quality import audio_diagnostics_report

    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    stem = project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(sample_wav.read_bytes())
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    with pytest.raises(ValueError, match="end_sec"):
        audio_diagnostics_report(
            project, "host", start_sec=2.0, end_sec=1.0, defaults=load_defaults()
        )


def test_diagnostics_dir_rejects_traversal(tmp_path: Path) -> None:
    from podcast_mcp.edits.audio_quality import diagnostics_dir

    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    with pytest.raises(ValueError, match="unsafe"):
        diagnostics_dir(project, "../etc")
    with pytest.raises(ValueError, match="unsafe"):
        diagnostics_dir(project, "host/../../tmp")


def test_diagnostics_dir_rejects_outward_symlink(tmp_path: Path) -> None:
    from podcast_mcp.edits.audio_quality import diagnostics_dir

    project = EpisodeProject.create("ep", str(tmp_path / "workspace"))
    project.ensure_dirs()
    root = project.artifacts_dir() / "diagnostics"
    root.mkdir(parents=True, exist_ok=True)
    (root / "host").symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(ValueError, match="diagnostics path escaped artifacts"):
        diagnostics_dir(project, "host")


def test_diagnostics_dir_accepts_literal_tilde_track_id(tmp_path: Path) -> None:
    from podcast_mcp.edits.audio_quality import diagnostics_dir

    project = EpisodeProject.create("ep", str(tmp_path / "workspace"))
    project.ensure_dirs()
    out = diagnostics_dir(project, "~nobody-local")
    assert out == (project.artifacts_dir() / "diagnostics" / "~nobody-local").resolve()


def test_audio_diagnostics_window_maps_offset_clip_to_source(tmp_path: Path) -> None:
    from audition_eval import generate_tone, inject_hum_span
    from podcast_mcp.edits.audio_quality import audio_diagnostics_report

    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")

    tone = tmp_path / "tone.wav"
    raw = tmp_path / "raw" / "host.wav"
    raw.parent.mkdir(parents=True)
    generate_tone(tone, duration_sec=10.0, freq_hz=220.0)
    inject_hum_span(tone, raw, start_sec=0.0, end_sec=3.0, freq_hz=60.0, mix_db=0.0)

    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    project.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=4.0,
            source_end=10.0,
            timeline_start=0.0,
        )
    ]
    # Timeline 0-2s is source 4-6s (clean). Timeline seconds on raw would hit hum 0-3s.
    clean = audio_diagnostics_report(
        project, "host", start_sec=0.0, end_sec=2.0, pngs=False, defaults=load_defaults()
    )
    assert clean["hum"]["hum_detected"] is False


def test_clipping_indicated_unions_astats_signals() -> None:
    from podcast_mcp.engines.audio_audit import clipping_indicated

    assert clipping_indicated(None) is False
    assert clipping_indicated({"flat_factor": 1.0}) is True
    assert clipping_indicated({"peak_count": 2}) is False
    assert clipping_indicated({"peak_level_db": -0.1}) is True
    assert (
        clipping_indicated({"peak_level_db": -12.0, "flat_factor": 0.0, "peak_count": 99}) is False
    )
    assert clipping_indicated({"peak_level_db": -12.0, "flat_factor": 6.0}) is True


def test_clipping_indicated_ignores_flat_factor_in_near_silence() -> None:
    """A gated track peaking at -68.7 dBFS repeats sample values (flat_factor 6.0)
    without clipping anything (#775)."""
    from podcast_mcp.engines.audio_audit import clipping_indicated

    assert (
        clipping_indicated({"peak_level_db": -68.725109, "flat_factor": 6.0206, "peak_count": 2})
        is False
    )
    assert clipping_indicated({"peak_level_db": -20.0, "flat_factor": 6.0}) is True
    assert clipping_indicated({"peak_level_db": -20.1, "flat_factor": 6.0}) is False


def _bleed_path(source: str, bleed: str) -> EchoPairProfile:
    return EchoPairProfile(
        source_track_id=source,
        bleed_track_id=bleed,
        span_start=0.0,
        span_end=10.0,
        dominated_frames=100,
        copy_frames=40,
        consistent_frames=30,
        lag_ms=3.0,
        level_db=-18.0,
        examples=(1.0,),
        null_runs=8,
        null_copy_rate=0.05,
        null_consistent_rate=0.02,
    )


def _caches_with_paths(*pairs: EchoPairProfile) -> TrackRmsCacheSet:
    caches = TrackRmsCacheSet()
    caches._echo_pairs = list(pairs)
    return caches


@pytest.mark.parametrize(
    ("guest_into_host", "host_into_guest", "host_sources", "guest_sources"),
    [
        (30, 30, {"guest"}, {"host"}),
        (1500, 30, {"guest"}, set()),
        (1500, 31, {"guest"}, {"host"}),
        (1500, 0, {"guest"}, set()),
    ],
    ids=["even", "one-way-by-more-than-fifty", "just-under-fifty", "no-reverse-path"],
)
def test_a_path_the_reverse_path_dwarfs_is_not_a_source(
    guest_into_host: int, host_into_guest: int, host_sources: set[str], guest_sources: set[str]
) -> None:
    """Two mics hearing one sound at a fixed ratio measure a path both ways; only the one that
    leaks counts, so the quiet side's words are never judged the louder mic's copy (#1495)."""
    pairs = [replace(_bleed_path("guest", "host"), consistent_frames=guest_into_host)]
    if host_into_guest:
        pairs.append(replace(_bleed_path("host", "guest"), consistent_frames=host_into_guest))
    caches = _caches_with_paths(*pairs)
    assert set(caches.leak_paths("host")) == host_sources
    assert set(caches.leak_paths("guest")) == guest_sources


@pytest.mark.parametrize(
    ("paths", "expected"),
    [
        ([], ("audible", None)),
        ([("host", "guest")], ("audible", None)),
        ([("guest", "host")], ("bleed", "guest")),
        ([("guest", "host"), ("host", "guest")], ("bleed", "guest")),
    ],
    ids=["no-path", "path-the-other-way", "path-from-the-louder-mic", "both-ways"],
)
def test_bleed_needs_a_measured_path_from_the_louder_mic(tmp_path: Path, paths, expected):
    """The guest mic is 10 dB louder in the host word's window in every case; the word is
    `bleed` only when a guest -> host path is measured (#774)."""
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id=tid, label=tid, role=TrackRole.DIALOGUE, speaker=tid) for tid in ("host", "guest")
    ]
    project.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="own", start=0.0, end=0.4)]),
        Transcript(track_id="guest", words=[TranscriptWord(text="loud", start=0.0, end=0.4)]),
    ]
    levels = {"host": -36.0, "guest": -26.0}
    with (
        patch(
            "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
            side_effect=lambda project, track_id, t0, t1, **kw: levels[track_id],
        ),
        patch(
            "podcast_mcp.engines.audio_audit.TrackRmsCacheSet.echo_pairs",
            new=lambda self: [_bleed_path(a, b) for a, b in paths],
        ),
    ):
        rows = compute_word_audibility_map(
            project, policy=AnalysisPolicy(), defaults=load_defaults()
        )

    assert [(r["track_id"], r["audibility_status"], r["dominant_track"]) for r in rows] == [
        ("host", *expected),
        ("guest", "audible", None),
    ]
    assert rows[0]["track_rms_db"] == {"host": -36.0, "guest": -26.0}


def test_cache_set_measures_its_bleed_paths_once() -> None:
    caches = TrackRmsCacheSet(
        caches={
            "host": TrackRmsCache(samples=np.zeros(800, dtype=np.float32), sample_rate=8000),
            "guest": TrackRmsCache(samples=np.zeros(800, dtype=np.float32), sample_rate=8000),
        }
    )
    measure = MagicMock(return_value=[_bleed_path("guest", "host")])
    with patch("podcast_mcp.engines.bleed_echo.echo_risk_pairs", measure):
        assert caches.echo_pairs() == [_bleed_path("guest", "host")]
        assert caches.bleed_paths("host") == {"guest": CopyPath()}
        assert caches.bleed_paths("guest") == {}

    assert measure.call_count == 1
    (audio, references), kwargs = measure.call_args
    assert set(audio) == {"host", "guest"} and kwargs == {"sample_rate": 8000}
    assert references == {"host": 0.0, "guest": 0.0}
    assert TrackRmsCacheSet().echo_pairs() == []


def test_rms_cache_reports_digital_silence_at_the_floor_the_caller_names() -> None:
    cache = TrackRmsCache(np.zeros(16_000, dtype=np.float32), 16_000)

    assert cache.rms_db(0.0, 0.5) == DIGITAL_SILENCE_DB
    assert cache.rms_db(0.0, 0.5, floor_db=-400.0) == -400.0


@pytest.mark.parametrize("gain_db", [-12.0, 6.0])
def test_reconciliation_evidence_leaves_the_effects_chain_out(tmp_path: Path, gain_db: float):
    """A compressor's threshold is an absolute level, so the processed track would not move
    with the recording's gain: the evidence is read before the chain (#1495)."""
    from podcast_mcp.engines.audio_audit import build_reconciliation_caches
    from podcast_mcp.models import Clip, MediaAsset, ProcessingChain, ProcessingEffect

    def level_db(gain: float) -> float:
        workspace = tmp_path / f"g{gain}"
        workspace.mkdir()
        project = EpisodeProject.create("ep", str(workspace))
        project.ensure_dirs()
        raw = workspace / "raw" / "host.wav"
        raw.parent.mkdir(exist_ok=True)
        t = np.arange(48000 * 2) / 48000
        samples = 0.5 * 10 ** (gain / 20) * np.sin(2 * np.pi * 220 * t)
        with wave.open(str(raw), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(48000)
            wav.writeframes((samples * 32767).astype("<i2").tobytes())
        project.timeline.tracks = [
            Track(
                id="host",
                label="Host",
                role=TrackRole.DIALOGUE,
                speaker="Host",
                transcript_gate=True,
                media=MediaAsset(path="raw/host.wav"),
            )
        ]
        project.clips = [
            Clip(id="c", track_id="host", source_start=0, source_end=2, timeline_start=0)
        ]
        project.processing_chains = [
            ProcessingChain(
                track_id="host",
                effects=[
                    ProcessingEffect(
                        effect="acompressor",
                        params={
                            "threshold_db": -18.0,
                            "ratio": 3.0,
                            "attack_ms": 15,
                            "release_ms": 150,
                        },
                    )
                ],
            )
        ]
        cache = build_reconciliation_caches(project, defaults=load_defaults()).get("host")
        assert cache is not None
        level = cache.rms_db(0.5, 1.5)
        assert level is not None
        return level

    assert level_db(gain_db) - level_db(0.0) == pytest.approx(gain_db, abs=0.1)


def _voice_scale_caches(a_gain: float = 1.0, b_gain: float = 1.0) -> TrackRmsCacheSet:
    """A quiet mic A (own speech at 0.05) and a call recording B that carries A 12 dB hotter."""
    rate = 8000
    rng = np.random.default_rng(2)
    clock = np.arange(8 * rate) / rate

    def burst(start: float, end: float, amp: float) -> np.ndarray:
        inside = (clock >= start) & (clock < end)
        shape = 0.5 - 0.5 * np.cos(2 * np.pi * 4 * (clock - start))
        return np.where(inside, amp * rng.normal(size=clock.size) * shape, 0.0)

    room = 0.0005
    a = burst(0.5, 3.5, 0.05) + room * rng.normal(size=clock.size)
    b = burst(0.5, 3.5, 0.2) + burst(4.5, 7.5, 0.2) + room * rng.normal(size=clock.size)
    return TrackRmsCacheSet(
        caches={
            "a": TrackRmsCache(samples=a * a_gain, sample_rate=rate),
            "b": TrackRmsCache(samples=b * b_gain, sample_rate=rate),
        }
    )


def _own_word_verdict(caches: TrackRmsCacheSet, project: EpisodeProject, *, start: float) -> str:
    """The verdict for a word of A's at ``start`` (B is a bleed source for A)."""
    from podcast_mcp.engines import audio_audit as aa

    ids = ["a", "b"]
    offsets = aa._voice_offsets(ids, caches)
    floors = aa._voice_floors(ids, caches, offsets)
    levels = aa._track_levels(
        project, ids, start, start + 1.0, {}, caches, offsets, defaults=load_defaults()
    )
    return aa._classify_word_audibility(
        "a",
        levels.get("a"),
        levels,
        policy=AnalysisPolicy(bleed_dominance_db=6.0),
        bleed_sources={"b"},
        voice_floors=floors,
    )[0]


def _two_mic_project(tmp_path: Path) -> EpisodeProject:
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="a", label="A", role=TrackRole.DIALOGUE),
        Track(id="b", label="B", role=TrackRole.DIALOGUE),
    ]
    return project


def test_a_hot_copy_on_another_recording_does_not_outrank_a_quiet_mic_own_speech(
    tmp_path: Path,
) -> None:
    """#1495: B carries A 12 dB hotter than A's own mic; on raw levels B always dominates A."""
    project = _two_mic_project(tmp_path)
    assert _own_word_verdict(_voice_scale_caches(), project, start=1.0) == "audible"


def test_whisper_above_low_band_hvac_is_audible_in_the_speech_band() -> None:
    """#1377: broadband room from HVAC must not call band-limited speech inaudible."""
    from podcast_mcp.engines import audio_audit as aa

    rate = 8000
    duration = 8.0
    clock = np.arange(int(rate * duration)) / rate
    hvac = 0.011 * np.sin(2 * np.pi * 90.0 * clock)
    loud = (clock >= 0.5) & (clock < 1.5)
    speech = np.where(loud, 0.08 * np.sin(2 * np.pi * 1200.0 * clock), 0.0)
    word_start, word_end = 3.0, 3.4
    inside = (clock >= word_start) & (clock < word_end)
    whisper = np.where(inside, 0.011 * np.sin(2 * np.pi * 2000.0 * clock), 0.0)
    samples = (hvac + speech + whisper).astype(np.float32)
    cache = TrackRmsCache(samples=samples, sample_rate=rate)

    broadband_floor = cache.profile.audibility_floor_db
    speech_floor = cache.speech_profile.audibility_floor_db
    word_broadband = cache.rms_db(word_start, word_end)
    word_speech = cache.speech_rms_db(word_start, word_end)
    assert word_broadband is not None and word_speech is not None
    assert word_broadband < broadband_floor
    assert word_speech >= speech_floor

    caches = TrackRmsCacheSet(caches={"host": cache})
    offsets = aa._voice_offsets(["host"], caches)
    floors = aa._voice_floors(["host"], caches, offsets)
    speech_offsets = aa._speech_voice_offsets(["host"], caches)
    inaudibility_floors = aa._inaudibility_floors(["host"], caches, speech_offsets)
    levels = aa._track_levels(
        EpisodeProject.create("ep", "/tmp"),
        ["host"],
        word_start,
        word_end,
        {},
        caches,
        offsets,
        defaults=load_defaults(),
    )
    own_speech = cache.speech_rms_db(word_start, word_end)
    assert own_speech is not None
    own_speech -= speech_offsets.get("host", 0.0)
    status, _ = aa._classify_word_audibility(
        "host",
        levels.get("host"),
        levels,
        policy=AnalysisPolicy(),
        bleed_sources=set(),
        voice_floors=floors,
        own_speech_level=own_speech,
        inaudibility_floors=inaudibility_floors,
    )
    assert status == "audible"


def test_reconcile_verdicts_do_not_depend_on_balance_gain_or_recording_gain(
    tmp_path: Path,
) -> None:
    """#1495: a track's ``gain_db`` and a file recorded +12 dB hotter give the same verdicts."""
    project = _two_mic_project(tmp_path)
    base = _own_word_verdict(_voice_scale_caches(), project, start=1.0)
    project.timeline.tracks[0].gain_db = 18.0
    assert _own_word_verdict(_voice_scale_caches(), project, start=1.0) == base
    for gains in ((4.0, 1.0), (1.0, 4.0), (0.25, 0.25)):
        assert _own_word_verdict(_voice_scale_caches(*gains), project, start=1.0) == base


@pytest.mark.parametrize(
    ("t_start", "t_end"),
    [(4.00175, 4.08175), (508.348981, 508.408981), (0.0, 0.1), (12.3, 12.4)],
)
def test_cache_window_reads_the_samples_the_uncached_reader_does(t_start, t_end):
    rate = 8_000
    cache = TrackRmsCache(np.arange(600 * rate, dtype=np.float32), rate)
    window = cache.window(t_start, t_end)
    assert window.size == round((t_end - t_start) * rate)
    assert window[0] == round(t_start * rate)


def test_cache_window_before_the_offset_clamps_to_the_cache_start():
    cache = TrackRmsCache(np.arange(8_000, dtype=np.float32), 8_000, timeline_offset_sec=1.0)
    window = cache.window(0.5, 1.5)
    assert window.size == 4_000
    assert window[0] == 0


def test_cached_and_uncached_window_reads_return_the_same_samples(tmp_path: Path):
    from podcast_mcp.engines import audio_audit as aa

    rate = aa._RMS_SAMPLE_RATE
    raw = tmp_path / "raw"
    raw.mkdir()
    noise = np.random.default_rng(7).uniform(-0.5, 0.5, 6 * rate)
    with wave.open(str(raw / "host.wav"), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes((noise * 32767).astype("<i2").tobytes())
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=6.0),
        )
    ]
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.7,
            source_end=5.0,
            timeline_start=2.00175,
        )
    ]
    caches = aa.build_track_rms_caches(project, defaults=load_defaults())
    for t0, t1 in [(4.00175, 4.08175), (3.348981, 3.408981), (2.5, 2.6003), (5.1234, 5.2)]:
        cached, _ = aa.timeline_window_samples(
            project, "host", t0, t1, caches=caches, defaults=load_defaults()
        )
        uncached, _ = aa.timeline_window_samples(project, "host", t0, t1, defaults=load_defaults())
        assert cached.size == uncached.size
        np.testing.assert_allclose(cached, uncached, atol=1e-4)


def test_cache_window_length_rounds_apart_from_its_start():
    rate = 8_000
    cache = TrackRmsCache(np.arange(10 * rate, dtype=np.float32), rate)
    t_start, t_end = 8000.6 / 8000, 8002.4 / 8000
    assert round(t_start * rate) + round((t_end - t_start) * rate) != round(t_end * rate)
    window = cache.window(t_start, t_end)
    assert window.size == round((t_end - t_start) * rate)
    assert window[0] == round(t_start * rate)
