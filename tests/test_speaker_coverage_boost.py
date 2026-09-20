from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import numpy as np

from podcast_mcp.edits.fillers import _cut_span_is_bleed_not_owner
from podcast_mcp.engines.speaker_id import (
    MockSpeakerBackend,
    SpeakerIdConfig,
    SpeakerProfile,
    WindowScore,
    assess_speaker_cut_role,
    label_window,
    score_window,
)
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)


def _two_track_project(tmp_path: Path, sample_wav: Path) -> EpisodeProject:
    raw = tmp_path / "raw"
    raw.mkdir(exist_ok=True)
    for tid in ("host", "guest"):
        (raw / f"{tid}.wav").write_bytes(sample_wav.read_bytes())
    project_path = tmp_path / "episode.project.json"
    proj = EpisodeProject.create("spk_test", str(tmp_path))
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/guest.wav"),
        ),
    ]
    proj.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        ),
        Clip(
            id="c2",
            track_id="guest",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        ),
    ]
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(
                    text="um",
                    start=1.0,
                    end=1.5,
                    audibility_status="bleed",
                )
            ],
        ),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text="hello", start=1.0, end=1.5, confidence=0.95),
            ],
        ),
    ]
    save_project(proj, project_path)
    return load_project(project_path)


def _profiles() -> dict[str, SpeakerProfile]:
    return {
        "host": SpeakerProfile(
            speaker_id="host",
            track_id="host",
            embedding=[1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            enrollment_sec=30.0,
            stem_hash="abc",
            home_track_id="host",
        ),
        "guest": SpeakerProfile(
            speaker_id="guest",
            track_id="guest",
            embedding=[0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            enrollment_sec=30.0,
            stem_hash="def",
            home_track_id="guest",
        ),
    }


def test_assess_speaker_cut_role_none_when_unscorable(tmp_path, sample_wav) -> None:
    proj = _two_track_project(tmp_path, sample_wav)
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value=_profiles(),
        ),
        patch(
            "podcast_mcp.engines.speaker_id.score_window",
            return_value=None,
        ),
    ):
        assert assess_speaker_cut_role(proj, "host", 1.0, 1.5, SpeakerIdConfig()) is None


def test_score_window_no_profiles_returns_none(tmp_path, sample_wav) -> None:
    proj = _two_track_project(tmp_path, sample_wav)
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value={},
        ),
        patch(
            "podcast_mcp.engines.speaker_id.load_profile",
            return_value=None,
        ),
        patch(
            "podcast_mcp.engines.speaker_id.load_mono_window",
            return_value=np.ones(8000, dtype=np.float32),
        ),
    ):
        assert (
            score_window(
                proj,
                "host",
                1.0,
                1.5,
                SpeakerIdConfig(),
                MockSpeakerBackend(),
            )
            is None
        )


def test_cut_span_not_bleed_when_match_is_same_track() -> None:
    project = EpisodeProject.create("x", "/tmp/x")
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="/tmp/x/host.wav"),
        )
    ]
    project.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        )
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(
                    text="hi",
                    start=1.0,
                    end=1.3,
                    speaker_match_track="host",
                )
            ],
        )
    ]
    assert _cut_span_is_bleed_not_owner(project, "host", 1.0, 1.3) is False


def test_label_window_skips_out_of_window_words(tmp_path, sample_wav) -> None:
    proj = _two_track_project(tmp_path, sample_wav)
    own = WindowScore(
        track_id="guest",
        start_sec=1.0,
        end_sec=1.2,
        scores={"guest": 0.95},
        best_track_id="guest",
        best_identity="guest",
        margin=0.8,
    )
    with patch(
        "podcast_mcp.engines.speaker_id.score_window",
        return_value=own,
    ):
        label_window(
            proj,
            "guest",
            1.0,
            1.2,
            SpeakerIdConfig(min_margin=0.1),
            MockSpeakerBackend(),
            dry_run=True,
        )


def test_extend_intervals_no_profiles_returns_input(tmp_path, sample_wav) -> None:
    from podcast_mcp.engines.speaker_id import extend_intervals_with_speaker_gaps

    proj = _two_track_project(tmp_path, sample_wav)
    intervals = [(0.0, 1.0), (1.2, 2.0)]
    with patch(
        "podcast_mcp.engines.speaker_id.load_all_profiles",
        return_value={},
    ):
        out = extend_intervals_with_speaker_gaps(
            proj,
            "host",
            intervals,
            SpeakerIdConfig(max_speaker_gap_sec=0.5),
            MockSpeakerBackend(),
        )
    assert out == intervals


def test_compare_window_empty_profiles(tmp_path, sample_wav) -> None:
    from podcast_mcp.engines.speaker_id import compare_window

    proj = _two_track_project(tmp_path, sample_wav)
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value={},
        ),
        patch(
            "podcast_mcp.engines.speaker_id.score_window",
            return_value=None,
        ),
    ):
        out = compare_window(
            proj,
            1.0,
            1.5,
            SpeakerIdConfig(),
            MockSpeakerBackend(),
        )
    assert out["profile_count"] == 0
    assert all(t["role"] == "uncertain" for t in out["tracks"])


def test_resolve_expected_count_from_track_labels_only(tmp_path) -> None:
    from podcast_mcp.engines.speaker_id import resolve_expected_speaker_count

    proj = EpisodeProject.create("labels", str(tmp_path))
    proj.tracks = [
        Track(id="a", label="Alice", role=TrackRole.DIALOGUE),
        Track(id="b", label="Bob", role=TrackRole.DIALOGUE),
    ]
    count, source = resolve_expected_speaker_count(proj, SpeakerIdConfig())
    assert count == 2
    assert source == "inferred"


def test_resolve_speaker_backend_prefer_mock_flag() -> None:
    from podcast_mcp.engines.speaker_id import resolve_speaker_backend

    assert resolve_speaker_backend(prefer_mock=True).name() == "mock"


def test_window_score_to_dict_includes_identity() -> None:
    ws = WindowScore(
        track_id="host",
        start_sec=0.0,
        end_sec=1.0,
        scores={"host": 0.9},
        best_track_id="host",
        best_identity="host",
        margin=0.9,
    )
    assert ws.to_dict()["best_identity"] == "host"


def test_cut_span_not_bleed_when_speaker_role_own() -> None:
    project = EpisodeProject.create("x", "/tmp/x")
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="/tmp/x/host.wav"),
        )
    ]
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value={"host": object()},
        ),
        patch(
            "podcast_mcp.engines.speaker_id.assess_speaker_cut_role",
            return_value={"role": "own"},
        ),
    ):
        assert _cut_span_is_bleed_not_owner(project, "host", 1.0, 1.3) is False


def test_cut_span_bleed_from_speaker_match_metadata() -> None:
    project = EpisodeProject.create("x", "/tmp/x")
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="/tmp/x/host.wav"),
        )
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(
                    text="um",
                    start=1.0,
                    end=1.3,
                    speaker_match_track="guest",
                )
            ],
        )
    ]
    assert _cut_span_is_bleed_not_owner(project, "host", 1.0, 1.3) is True


def test_speech_energy_on_conflict_invalid_defaults_to_track_local() -> None:
    from podcast_mcp.edits.speech_energy_guard import speech_energy_on_conflict

    assert (
        speech_energy_on_conflict({"speech_energy_guard": {"on_conflict": "bogus"}})
        == "track_local"
    )


def test_label_track_home_speaker_short_region_breaks(tmp_path, sample_wav) -> None:
    from podcast_mcp.engines.speaker_id import label_track_home_speaker

    raw = tmp_path / "raw"
    raw.mkdir()
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    proj = EpisodeProject.create("short", str(tmp_path))
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="x", start=0.0, end=0.1)],
        )
    ]
    profiles = {
        "host": SpeakerProfile(
            speaker_id="host",
            track_id="host",
            embedding=[1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            enrollment_sec=1.0,
            stem_hash="x",
            home_track_id="host",
        )
    }
    cfg = SpeakerIdConfig(
        min_margin=0.1,
        min_window_sec=0.3,
        gate_window_sec=0.75,
        gate_hop_sec=0.25,
    )
    with patch(
        "podcast_mcp.engines.speaker_id.load_all_profiles",
        return_value=profiles,
    ):
        report = label_track_home_speaker(proj, cfg, MockSpeakerBackend(), dry_run=True)
    assert report["words_would_suppress"] == 0


def test_cut_span_bleed_guard_logs_on_speaker_error() -> None:
    project = EpisodeProject.create("x", "/tmp/x")
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="/tmp/x/host.wav"),
        )
    ]
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value={"host": object()},
        ),
        patch(
            "podcast_mcp.engines.speaker_id.assess_speaker_cut_role",
            side_effect=RuntimeError("boom"),
        ),
    ):
        assert _cut_span_is_bleed_not_owner(project, "host", 1.0, 1.3) is False


def test_speech_regions_merges_and_skips_invalid_words(tmp_path, sample_wav) -> None:
    from podcast_mcp.engines.speaker_id import _speech_regions

    raw = tmp_path / "raw"
    raw.mkdir()
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    proj = EpisodeProject.create("regions", str(tmp_path))
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="a", start=0.0, end=0.0, suppressed=False),
                TranscriptWord(text="b", start=0.0, end=0.5, suppressed=False),
                TranscriptWord(text="c", start=0.52, end=1.0, suppressed=False),
                TranscriptWord(text="d", start=2.0, end=2.5, suppressed=False),
                TranscriptWord(text="e", start=2.5, end=3.0, suppressed=True),
            ],
        )
    ]
    regions = _speech_regions(proj, "host")
    assert regions == [(0.0, 1.0), (2.0, 2.5)]


def test_label_track_home_speaker_skips_missing_transcript(tmp_path, sample_wav) -> None:
    from podcast_mcp.engines.speaker_id import label_track_home_speaker

    raw = tmp_path / "raw"
    raw.mkdir()
    for tid in ("host", "guest"):
        (raw / f"{tid}.wav").write_bytes(sample_wav.read_bytes())
    proj = EpisodeProject.create("skip", str(tmp_path))
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/guest.wav"),
        ),
    ]
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="hi", start=0.0, end=1.0)],
        )
    ]
    profiles = {
        "host": SpeakerProfile(
            speaker_id="host",
            track_id="host",
            embedding=[1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            enrollment_sec=1.0,
            stem_hash="x",
            home_track_id="host",
        ),
        "guest": SpeakerProfile(
            speaker_id="guest",
            track_id="guest",
            embedding=[0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            enrollment_sec=1.0,
            stem_hash="y",
            home_track_id="guest",
        ),
    }
    cfg = SpeakerIdConfig(min_margin=0.1)
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value=profiles,
        ),
        patch(
            "podcast_mcp.engines.speaker_id.score_window",
            return_value=None,
        ),
    ):
        report = label_track_home_speaker(
            proj,
            cfg,
            MockSpeakerBackend(),
            track_ids=["host", "guest"],
            dry_run=True,
        )
    assert report["tracks"]


def test_label_track_home_speaker_no_profiles(tmp_path) -> None:
    from podcast_mcp.engines.speaker_id import label_track_home_speaker

    proj = EpisodeProject.create("x", str(tmp_path))
    out = label_track_home_speaker(proj, SpeakerIdConfig(), MockSpeakerBackend(), dry_run=True)
    assert out["error"] == "no profiles"


def test_label_track_home_speaker_count_warning(tmp_path, sample_wav) -> None:
    from podcast_mcp.engines.speaker_id import label_track_home_speaker

    raw = tmp_path / "raw"
    raw.mkdir()
    for tid in ("host", "guest"):
        (raw / f"{tid}.wav").write_bytes(sample_wav.read_bytes())
    proj = EpisodeProject.create("warn", str(tmp_path))
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/guest.wav"),
        ),
    ]
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="hi", start=0.0, end=1.0)],
        ),
        Transcript(
            track_id="guest",
            words=[TranscriptWord(text="yo", start=0.0, end=1.0)],
        ),
    ]
    profiles = {
        "host": SpeakerProfile(
            speaker_id="host",
            track_id="host",
            embedding=[1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            enrollment_sec=1.0,
            stem_hash="x",
            home_track_id="host",
        ),
        "guest": SpeakerProfile(
            speaker_id="guest",
            track_id="guest",
            embedding=[0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            enrollment_sec=1.0,
            stem_hash="y",
            home_track_id="guest",
        ),
    }

    def _score(_p, tid, *_a, **_k):
        return WindowScore(
            track_id=tid,
            start_sec=0.0,
            end_sec=1.0,
            scores={tid: 0.9},
            best_track_id=tid,
            best_identity=tid,
            margin=0.8,
        )

    cfg = SpeakerIdConfig(
        expected_speaker_count=1,
        gate_window_sec=0.75,
        gate_hop_sec=0.25,
        min_margin=0.1,
    )
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value=profiles,
        ),
        patch(
            "podcast_mcp.engines.speaker_id.score_window",
            side_effect=_score,
        ),
    ):
        out = label_track_home_speaker(proj, cfg, MockSpeakerBackend(), dry_run=True)
    assert out["speaker_count_warning"] is not None


def test_label_track_home_speaker_ignores_uncertain_windows(tmp_path, sample_wav) -> None:
    from podcast_mcp.engines.speaker_id import label_track_home_speaker

    raw = tmp_path / "raw"
    raw.mkdir()
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    proj = EpisodeProject.create("unc", str(tmp_path))
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="hi", start=0.0, end=1.0)],
        )
    ]
    profiles = {
        "host": SpeakerProfile(
            speaker_id="host",
            track_id="host",
            embedding=[1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            enrollment_sec=1.0,
            stem_hash="x",
            home_track_id="host",
        )
    }
    uncertain = WindowScore(
        track_id="host",
        start_sec=0.0,
        end_sec=1.0,
        scores={"host": 0.5, "guest": 0.52},
        best_track_id="guest",
        best_identity="guest",
        margin=0.02,
    )
    cfg = SpeakerIdConfig(min_margin=0.15, gate_window_sec=0.75, gate_hop_sec=0.25)
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value=profiles,
        ),
        patch(
            "podcast_mcp.engines.speaker_id.score_window",
            return_value=uncertain,
        ),
    ):
        report = label_track_home_speaker(proj, cfg, MockSpeakerBackend(), dry_run=True)
    assert report["words_would_suppress"] == 0


def test_mcp_speaker_gate_track_tool(tmp_path, sample_wav) -> None:
    from podcast_mcp.mcp.tools import speaker as mcp_speaker

    raw = tmp_path / "raw"
    raw.mkdir()
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    path = tmp_path / "episode.project.json"
    proj = EpisodeProject.create("gate", str(tmp_path))
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    save_project(proj, path)
    with patch(
        "podcast_mcp.services.speaker.label_track_home_speaker",
        return_value={"dry_run": True, "words_would_suppress": 0},
    ):
        out = json.loads(mcp_speaker.speaker_gate_track_tool(str(path), dry_run=True))
    assert out["dry_run"] is True
