from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from podcast_mcp.edits.audio_quality import suppress_low_audibility_words
from podcast_mcp.engines.audio_audit import (
    AnalysisPolicy,
    TrackRmsCache,
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
from podcast_mcp.engines.ffmpeg import FFmpegEngine
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


def test_analysis_policy_from_defaults():
    pol = AnalysisPolicy.from_defaults()
    assert pol.audibility_rms_db == -42.0
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

    pol = AnalysisPolicy(audibility_rms_db=0.0)
    with patch(
        "podcast_mcp.engines.audio_audit.measure_window_rms_db",
        return_value=-50.0,
    ):
        flagged = list_low_audibility_words(project, policy=pol, track_id="host")
    assert len(flagged) == 1
    assert flagged[0]["text"] == "hello"


def test_gate_overreach_no_gate(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    report = analyze_gate_overreach(project, "host")
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
        report = analyze_gate_overreach(project, "host", policy=AnalysisPolicy())
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
        report = analyze_gate_overreach(project, "host", policy=AnalysisPolicy())
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
        )
    assert recs
    assert recs[0]["kind"] == "harsh_join"
    assert recs[0]["level_jump_db"] == 20.0
    # 20 dB jump → scaled fade (max(20, min(80, 40))) = 40
    assert recs[0]["recommended_fade_in_ms"] == 40


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
    )
    assert result["suppressed_count"] == 1
    assert project.transcripts[0].words[0].suppressed is True
    merged = TranscriptionEngine().merge_transcripts(project)
    assert "quiet" not in merged.utterances[0].text if merged.utterances else True


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
    rows = compute_word_audibility_map(project, track_id="host")
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
    rows = compute_word_audibility_map(project, track_id="host")
    by_idx = {r["word_index"]: r for r in rows}
    assert by_idx[1]["audibility_status"] == "deferred"
    assert by_idx[1]["reason"] == "sandwiched_zero_duration_word"

    from podcast_mcp.engines.transcript_reconcile import reconcile_transcript

    result = reconcile_transcript(project, dry_run=False)
    assert result.applied
    assert project.transcripts[0].words[1].suppressed is False
    merged = TranscriptionEngine().merge_transcripts(project)
    assert any("what" in (u.text or "") for u in merged.utterances)


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
        )
    by_idx = {r["word_index"]: r for r in rows}
    assert by_idx[0]["audibility_status"] == "deferred"
    assert by_idx[0]["reason"] == "anomalous_word_duration"

    from podcast_mcp.engines.transcript_reconcile import reconcile_transcript

    reconcile_transcript(
        project,
        dry_run=False,
        policy=AnalysisPolicy(max_word_audibility_sec=2.0),
    )
    assert project.transcripts[0].words[0].suppressed is False


def test_analyze_cleanup_summary(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    report = analyze_cleanup(project)
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
    report = analyze_cleanup(project)
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
    result = apply_fade_recommendations(project, recs)
    assert result["applied_fade_updates"] == 2
    # Dialogue fades capped at render.join_fade_max_ms (40)
    assert project.clips[0].fade_out_ms == 25
    assert project.clips[1].fade_in_ms == 25


def test_edit_service_analyze_cleanup(minimal_project, tmp_workspace):
    from podcast_mcp.services import EditService, ProjectWorkspace

    ws = ProjectWorkspace.open(minimal_project)
    report = EditService(ws).analyze_cleanup()
    assert "summary" in report


def test_edit_service_suppress_low_audibility(minimal_project, tmp_workspace):
    from podcast_mcp.models import Transcript, TranscriptWord
    from podcast_mcp.services import EditService, ProjectWorkspace

    proj = load_project(minimal_project)
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="x", start=0.0, end=0.1)],
        )
    ]
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    out = EditService(ws).suppress_low_audibility(
        words_json=[{"track_id": "host", "word_index": 0}]
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
    pol = AnalysisPolicy(audibility_rms_db=-35.0, bleed_dominance_db=6.0)

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
    ):
        expected_low = {
            tid: list_low_audibility_words(project, policy=pol, track_id=tid)
            for tid in ("host", "guest")
        }
        expected_flagged = {
            tid: list_flagged_words(project, policy=pol, track_id=tid) for tid in ("host", "guest")
        }
        report = analyze_cleanup(project, policy=pol)

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
    recs = recommend_boundary_fades(project, track_id="host")
    assert recs[0]["kind"] == "gap_between_clips"


def test_analysis_policy_from_custom_defaults():
    pol = AnalysisPolicy.from_defaults(
        {
            "analysis": {
                "heuristics": {
                    "audibility_rms_db": -30.0,
                    "bleed_text_match_enabled": False,
                    "bleed_text_match_min_overlap_sec": 0.1,
                    "bleed_text_match_min_dominance_db": 4.0,
                },
                "ml_backend": "nisqa",
            }
        }
    )
    assert pol.audibility_rms_db == -30.0
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
    with patch("podcast_mcp.engines.audio_audit.run") as run:
        run.return_value = MagicMock(stdout=b"", returncode=0)
        with pytest.raises(ValueError, match="no audio decoded"):
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
    caches = build_track_rms_caches(project)
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
    assert compute_word_audibility_map(project, policy=pol) == []


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
        bleed = list_bleed_words(project)
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
        rows = compute_word_audibility_map(project)
    assert rows[0]["audibility_status"] == "inaudible"


def test_muted_track_rms_is_floor(tmp_path: Path):
    from podcast_mcp.engines import audio_audit as aa

    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            muted=True,
        )
    ]
    assert aa._rms_for_track_at_timeline(project, "host", 0.0, 0.5) == -80.0


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
    report = analyze_gate_overreach(project, "host")
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
        report = analyze_gate_overreach(project, "host", policy=AnalysisPolicy())
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
        report = analyze_gate_overreach(project, "host", policy=AnalysisPolicy())
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
        recs = recommend_boundary_fades(project, track_id="host")
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
    with patch(
        "podcast_mcp.engines.audio_audit.TrackRmsCache.rms_db",
        return_value=-55.0,
    ):
        flagged = list_low_audibility_words(
            project, policy=AnalysisPolicy(audibility_rms_db=-40.0), track_id="host"
        )
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
    flagged = [
        {
            "track_id": "host",
            "word_index": 0,
            "audibility_status": "inaudible",
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
            "podcast_mcp.engines.audio_audit.list_flagged_words",
            return_value=flagged,
        ),
        patch(
            "podcast_mcp.engines.audio_audit.recommend_boundary_fades",
            return_value=[{"kind": "harsh_join"}],
        ),
    ):
        report = analyze_cleanup(project, policy=pol)
    assert len(report["tracks"]) == 1
    assert report["tracks"][0]["suppression_recommendations"]
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
            "podcast_mcp.engines.audio_audit.list_flagged_words",
            return_value=[],
        ),
        patch(
            "podcast_mcp.engines.audio_audit.recommend_boundary_fades",
            return_value=[],
        ),
    ):
        report = analyze_cleanup(project)
    assert report["summary"] == "No significant cleanup issues detected."


def test_rms_db_edge_cases(monkeypatch):
    from podcast_mcp.engines import audio_audit as aa
    from podcast_mcp.util.dsp import rms_db

    assert rms_db(np.array([], dtype=np.float32)) == -80.0
    assert rms_db(np.zeros(100, dtype=np.float32)) == -80.0
    assert rms_db(np.zeros(100, dtype=np.float32), floor_db=-400.0) == -400.0
    cache = aa.TrackRmsCache(np.zeros(16_000, dtype=np.float32), 16_000)
    assert cache.rms_db(0.0, 0.5) == -80.0
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
    caches = build_track_rms_caches(project)
    proc_rms = aa._rms_for_track_at_timeline(project, "host", 0.0, 0.5, caches=caches)
    assert proc_rms is not None
    assert proc_rms > -80.0

    stem.unlink()
    raw_rms = aa._rms_for_track_at_timeline(project, "host", 0.0, 0.5)
    assert raw_rms is not None

    with patch(
        "podcast_mcp.engines.audio_audit.timeline_to_source",
        side_effect=RuntimeError("bad map"),
    ):
        assert aa._rms_for_track_at_timeline(project, "host", 0.0, 0.5) is None


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
        assert list_low_audibility_words(project, track_id="host") == []


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
        report = analyze_gate_overreach(project, "host")
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
        recs = recommend_boundary_fades(project, track_id="host")
    assert recs and "missing boundary fades" in recs[0]["reason"]


def test_analyze_cleanup_skips_non_dialogue_track(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="music", label="Music", role=TrackRole.MUSIC, speaker="Music"),
    ]
    report = analyze_cleanup(project, track_id="music")
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
            "podcast_mcp.engines.audio_audit.list_flagged_words",
            return_value=bleed_rows,
        ),
        patch(
            "podcast_mcp.engines.audio_audit.recommend_boundary_fades",
            return_value=[],
        ),
    ):
        report = analyze_cleanup(project, policy=AnalysisPolicy(bleed_ratio_warn_threshold=0.2))
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
            "podcast_mcp.engines.audio_audit.list_flagged_words",
            return_value=bleed_rows,
        ),
        patch(
            "podcast_mcp.engines.audio_audit.recommend_boundary_fades",
            return_value=[],
        ),
    ):
        report = analyze_cleanup(project, policy=AnalysisPolicy(bleed_ratio_warn_threshold=0.2))
    row = report["tracks"][0]
    assert row["bleed_ratio"] == 0.1
    assert "high_bleed_warning" not in row


def test_analyze_cleanup_bleed_ratio_none_without_transcript(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    report = analyze_cleanup(project)
    assert report["tracks"][0]["bleed_ratio"] is None


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

    report = audio_diagnostics_report(project, "host")
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

    report = audio_diagnostics_report(project, "host", start_sec=0.0, end_sec=1.0)
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
    report = audio_diagnostics_report(project, "host", start_sec=0.0, end_sec=1.0, pngs=False)
    assert "spectrogram_png" not in report
    assert "waveform_png" not in report
    assert "crest_factor" in report["astats"]
    assert "hum_detected" in report["hum"]
    assert report["window"]["start"] == 0.0


def test_audio_diagnostics_windowed_hum_not_full_file(tmp_path: Path):
    from podcast_mcp.edits.audio_quality import audio_diagnostics_report
    from podcast_mcp.edits.audition_eval import generate_tone, inject_hum_span
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

    clean_win = audio_diagnostics_report(project, "host", start_sec=0.0, end_sec=3.0)
    hum_win = audio_diagnostics_report(project, "host", start_sec=4.5, end_sec=8.0)
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

    report = audio_diagnostics_report(project, "host")
    assert Path(report["spectrogram_png"]).is_file()


def test_audio_diagnostics_report_raises_without_media(tmp_path: Path):
    from podcast_mcp.edits.audio_quality import audio_diagnostics_report

    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE, speaker="Host")
    ]
    with pytest.raises(ValueError, match="no audio available"):
        audio_diagnostics_report(project, "host")


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
        audio_diagnostics_report(project, "host", start_sec=2.0, end_sec=1.0)


def test_diagnostics_dir_rejects_traversal(tmp_path: Path) -> None:
    from podcast_mcp.edits.audio_quality import diagnostics_dir

    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    with pytest.raises(ValueError, match="unsafe"):
        diagnostics_dir(project, "../etc")
    with pytest.raises(ValueError, match="unsafe"):
        diagnostics_dir(project, "host/../../tmp")


def test_audio_diagnostics_window_maps_offset_clip_to_source(tmp_path: Path) -> None:
    from podcast_mcp.edits.audio_quality import audio_diagnostics_report
    from podcast_mcp.edits.audition_eval import generate_tone, inject_hum_span

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
    clean = audio_diagnostics_report(project, "host", start_sec=0.0, end_sec=2.0, pngs=False)
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
