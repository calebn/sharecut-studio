"""Tests for speaker verification bleed fixes (backend, gating, stems)."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

from podcast_mcp.engines.speaker_id import (
    MockSpeakerBackend,
    SpeakerIdConfig,
    SpeakerProfile,
    WindowScore,
    _decode_window_samples,
    _profile_stem_valid,
    _stem_hash,
    _stem_path_and_source,
    assess_speaker_cut_role,
    enroll_track,
    label_track_home_speaker,
    load_all_profiles,
    resolve_speaker_backend,
    speaker_doctor,
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
from podcast_mcp.services import ProjectWorkspace, SpeakerService


def _project(tmp_path: Path, sample_wav: Path) -> EpisodeProject:
    raw = tmp_path / "raw"
    raw.mkdir()
    for tid in ("host", "guest"):
        (raw / f"{tid}.wav").write_bytes(sample_wav.read_bytes())
    project_path = tmp_path / "episode.project.json"
    proj = EpisodeProject.create("bleed_fix", str(tmp_path))
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
                TranscriptWord(text="hello", start=1.0, end=2.0),
                TranscriptWord(text="um", start=2.5, end=3.0),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[TranscriptWord(text="hi", start=1.0, end=2.0)],
        ),
    ]
    save_project(proj, project_path)
    return load_project(project_path)


def _profiles() -> dict[str, SpeakerProfile]:
    host = SpeakerProfile(
        speaker_id="host",
        track_id="host",
        embedding=[1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        enrollment_sec=30.0,
        stem_hash="abc",
        home_track_id="host",
    )
    guest = SpeakerProfile(
        speaker_id="guest",
        track_id="guest",
        embedding=[0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        enrollment_sec=30.0,
        stem_hash="def",
        home_track_id="guest",
    )
    return {"host": host, "guest": guest}


def test_assess_speaker_cut_role_uses_resolved_backend_not_mock() -> None:
    with (
        patch(
            "podcast_mcp.engines.speaker_id.resolve_speaker_backend",
            return_value=MockSpeakerBackend(),
        ) as resolve,
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value=_profiles(),
        ),
        patch(
            "podcast_mcp.engines.speaker_id.score_window",
            return_value=WindowScore(
                track_id="host",
                start_sec=1.0,
                end_sec=1.5,
                scores={"host": 0.1, "guest": 0.9},
                best_track_id="guest",
                best_identity="guest",
                margin=0.8,
            ),
        ),
    ):
        from podcast_mcp.models import EpisodeProject

        proj = EpisodeProject.create("x", "/tmp")
        role = assess_speaker_cut_role(proj, "host", 1.0, 1.5, SpeakerIdConfig(min_margin=0.1))
    resolve.assert_called_once_with()
    assert role and role["role"] == "bleed"


def test_decode_window_samples_center_pads_short_span(tmp_path, sample_wav) -> None:
    wav = tmp_path / "t.wav"
    wav.write_bytes(sample_wav.read_bytes())
    cfg = SpeakerIdConfig(min_window_sec=0.3, sample_rate=8000)
    samples = _decode_window_samples(wav, 1.0, 1.1, cfg)
    assert samples.size == int(0.3 * cfg.sample_rate)


def test_stem_path_prefers_processed_stem(tmp_path, sample_wav) -> None:
    proj = _project(tmp_path, sample_wav)
    processed = proj.artifacts_dir() / "tracks"
    processed.mkdir(parents=True)
    stem = processed / "host.wav"
    stem.write_bytes(sample_wav.read_bytes())
    path, source = _stem_path_and_source(proj, "host")
    assert path == stem
    assert source == "processed"


def test_load_all_profiles_skips_stale_hash(tmp_path, sample_wav) -> None:
    proj = _project(tmp_path, sample_wav)
    prof = SpeakerProfile(
        speaker_id="host",
        track_id="host",
        embedding=[1.0],
        enrollment_sec=1.0,
        stem_hash="stale",
        home_track_id="host",
    )
    d = proj.artifacts_dir() / "speaker_profiles"
    d.mkdir(parents=True)
    (d / "host_stale.json").write_text(json.dumps(prof.to_dict()), encoding="utf-8")
    assert load_all_profiles(proj) == {}


def test_stem_hash_changes_when_file_changes(tmp_path, sample_wav) -> None:
    wav = tmp_path / "a.wav"
    wav.write_bytes(sample_wav.read_bytes())
    h1 = _stem_hash(wav)
    wav.write_bytes(sample_wav.read_bytes() + b"x")
    h2 = _stem_hash(wav)
    assert h1 != h2


def test_speaker_doctor_recommends_speechbrain_before_mock() -> None:
    sb = type("B", (), {"name": lambda self: "speechbrain-ecapa"})()
    rz = type("B", (), {"name": lambda self: "resemblyzer"})()
    with patch(
        "podcast_mcp.engines.speaker_id.resolve_speaker_backend",
        side_effect=[sb, rz, MockSpeakerBackend()],
    ):
        doc = speaker_doctor()
    assert doc["recommended"] == "speechbrain-ecapa"


def test_label_track_home_speaker_suppresses_bleed_windows(tmp_path, sample_wav) -> None:
    proj = _project(tmp_path, sample_wav)
    cfg = SpeakerIdConfig(
        min_margin=0.1,
        gate_window_sec=0.75,
        gate_hop_sec=0.25,
    )
    bleed = WindowScore(
        track_id="host",
        start_sec=2.5,
        end_sec=3.0,
        scores={"host": 0.1, "guest": 0.9},
        best_track_id="guest",
        best_identity="guest",
        margin=0.8,
    )
    own = WindowScore(
        track_id="host",
        start_sec=1.0,
        end_sec=2.0,
        scores={"host": 0.9, "guest": 0.1},
        best_track_id="host",
        best_identity="host",
        margin=0.8,
    )
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value=_profiles(),
        ),
        patch(
            "podcast_mcp.engines.speaker_id.score_window",
            side_effect=lambda _p, tid, s, e, *_a, **_k: bleed if e <= 3.1 else own,
        ),
    ):
        report = label_track_home_speaker(
            proj,
            cfg,
            MockSpeakerBackend(),
            dry_run=False,
        )
    assert report["words_suppressed"] >= 1
    um = next(w for w in proj.transcript_for_track("host").words if w.text == "um")
    assert um.suppressed is True
    assert um.speaker_match_track == "guest"


def test_gate_track_service_dry_run(tmp_path, sample_wav) -> None:
    _project(tmp_path, sample_wav)
    ws = ProjectWorkspace.open(tmp_path / "episode.project.json")
    with patch(
        "podcast_mcp.services.speaker.label_track_home_speaker",
        return_value={"dry_run": True, "words_would_suppress": 2, "words_suppressed": 0},
    ):
        out = SpeakerService(ws).gate_track(dry_run=True)
    assert out["words_would_suppress"] == 2


@pytest.mark.speaker
def test_ecapa_backend_available_when_torch_installed() -> None:
    pytest.importorskip("torch")
    pytest.importorskip("speechbrain")
    backend = resolve_speaker_backend("speechbrain")
    assert backend.name() == "speechbrain-ecapa"


def test_gate_track_service_apply_mutates(tmp_path, sample_wav) -> None:
    _project(tmp_path, sample_wav)
    ws = ProjectWorkspace.open(tmp_path / "episode.project.json")

    def _run_mutate(_before: str, _after: str, fn):
        return fn(ws.project)

    with (
        patch.object(ws, "mutate", side_effect=_run_mutate),
        patch(
            "podcast_mcp.services.speaker.label_track_home_speaker",
            return_value={"dry_run": False, "words_suppressed": 1},
        ),
    ):
        out = SpeakerService(ws).gate_track(dry_run=False)
    assert out["words_suppressed"] == 1


def test_attribute_apply_mutates(tmp_path, sample_wav) -> None:
    _project(tmp_path, sample_wav)
    ws = ProjectWorkspace.open(tmp_path / "episode.project.json")

    def _run_mutate(_before: str, _after: str, fn):
        return fn(ws.project)

    with (
        patch.object(ws, "mutate", side_effect=_run_mutate),
        patch(
            "podcast_mcp.services.speaker.run_speaker_attribution",
            return_value={"attributions_changed": 2},
        ),
    ):
        out = SpeakerService(ws).attribute(dry_run=False)
    assert out["attributions_changed"] == 2


def test_compare_pair_mcp_tool(tmp_path, sample_wav) -> None:
    from podcast_mcp.mcp.tools import speaker as mcp_speaker

    _project(tmp_path, sample_wav)
    path = str(tmp_path / "episode.project.json")
    with patch.object(
        SpeakerService,
        "compare_pair",
        return_value={"same_speaker_likely": False},
    ):
        out = json.loads(
            mcp_speaker.speaker_compare_pair_tool(path, "host", 0.0, 1.0, "guest", 0.0, 1.0)
        )
    assert out["same_speaker_likely"] is False


def test_score_returns_error_when_unscorable(tmp_path, sample_wav) -> None:
    proj = _project(tmp_path, sample_wav)
    ws = ProjectWorkspace.open(tmp_path / "episode.project.json")
    (proj.workspace_path() / "raw" / "host.wav").unlink()
    with patch(
        "podcast_mcp.services.speaker.score_window",
        return_value=None,
    ):
        out = SpeakerService(ws).score("host", 0.0, 1.0)
    assert out["error"] == "could not score window"


def test_load_profile_by_home_track_id(tmp_path, sample_wav) -> None:
    proj = _project(tmp_path, sample_wav)
    prof = SpeakerProfile(
        speaker_id="alice",
        track_id="host",
        embedding=[1.0, 0.0],
        enrollment_sec=1.0,
        stem_hash="zzz",
        home_track_id="host",
    )
    cache_dir = proj.artifacts_dir() / "speaker_profiles"
    cache_dir.mkdir(parents=True, exist_ok=True)
    (cache_dir / "alice_zzz.json").write_text(json.dumps(prof.to_dict()), encoding="utf-8")
    from podcast_mcp.engines.speaker_id import load_profile

    loaded = load_profile(proj, "host")
    assert loaded is not None
    assert loaded.speaker_id == "alice"


def test_enroll_track_sets_audio_source_processed(tmp_path, sample_wav) -> None:
    from podcast_mcp.engines.speaker_id import enroll_track

    proj = _project(tmp_path, sample_wav)
    processed = proj.artifacts_dir() / "tracks"
    processed.mkdir(parents=True)
    (processed / "host.wav").write_bytes(sample_wav.read_bytes())
    cfg = SpeakerIdConfig(min_enrollment_sec=0.1, min_enrollment_confidence=0.0)
    prof = enroll_track(proj, "host", cfg, MockSpeakerBackend())
    assert prof is not None
    assert prof.audio_source == "processed"


def test_bleed_mute_reports_speaker_extension_errors(tmp_path, sample_wav) -> None:
    from podcast_mcp.edits.transcript_bleed_mute import apply_transcript_bleed_mute
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

    raw = tmp_path / "raw"
    raw.mkdir()
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    proj = EpisodeProject.create("mute_err", str(tmp_path))
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    proj.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=2.0, timeline_start=0.0)
    ]
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="hi", start=0.0, end=0.5, suppressed=False)],
        )
    ]
    path = tmp_path / "episode.project.json"
    save_project(proj, path)
    proj = load_project(path)
    stems = proj.artifacts_dir() / "tracks"
    stems.mkdir(parents=True)
    (stems / "host.wav").write_bytes(sample_wav.read_bytes())
    from podcast_mcp.engines.play_audit import write_stem_hash

    write_stem_hash(proj, "host")
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value={
                "host": SpeakerProfile(
                    speaker_id="host",
                    track_id="host",
                    embedding=[1.0],
                    enrollment_sec=1.0,
                    stem_hash="x",
                    home_track_id="host",
                )
            },
        ),
        patch(
            "podcast_mcp.engines.speaker_id.extend_intervals_with_speaker_gaps",
            side_effect=RuntimeError("speaker boom"),
        ),
    ):
        out = apply_transcript_bleed_mute(proj, dry_run=True)
    assert out["speaker_errors"] is not None


def test_profile_stem_invalid_when_track_missing_media(tmp_path) -> None:
    proj = EpisodeProject.create("x", str(tmp_path))
    prof = SpeakerProfile(
        speaker_id="ghost",
        track_id="ghost",
        embedding=[1.0],
        enrollment_sec=1.0,
        stem_hash="h",
    )
    assert _profile_stem_valid(proj, prof) is False


def test_stem_path_missing_track_returns_none(tmp_path) -> None:
    proj = EpisodeProject.create("x", str(tmp_path))
    path, source = _stem_path_and_source(proj, "missing")
    assert path is None
    assert source is None


def test_enroll_track_all_words_filtered_returns_none(tmp_path, sample_wav) -> None:
    proj = _project(tmp_path, sample_wav)
    tr = proj.transcript_for_track("host")
    tr.words = [
        TranscriptWord(
            text="bleed",
            start=1.0,
            end=1.5,
            audibility_status="bleed",
            suppressed=True,
        )
    ]
    cfg = SpeakerIdConfig(min_enrollment_sec=0.5)
    assert enroll_track(proj, "host", cfg, MockSpeakerBackend()) is None


def test_decode_window_samples_full_span(tmp_path, sample_wav) -> None:
    wav = tmp_path / "t.wav"
    wav.write_bytes(sample_wav.read_bytes())
    cfg = SpeakerIdConfig(min_window_sec=0.3, sample_rate=8000)
    samples = _decode_window_samples(wav, 1.0, 1.5, cfg)
    assert samples.size == int(0.5 * cfg.sample_rate)


def test_label_track_home_speaker_dry_run_counts_would_suppress(tmp_path, sample_wav) -> None:
    proj = _project(tmp_path, sample_wav)
    cfg = SpeakerIdConfig(min_margin=0.1, gate_window_sec=0.75, gate_hop_sec=0.25)
    bleed = WindowScore(
        track_id="host",
        start_sec=2.5,
        end_sec=3.0,
        scores={"host": 0.1, "guest": 0.9},
        best_track_id="guest",
        best_identity="guest",
        margin=0.8,
    )
    own = WindowScore(
        track_id="host",
        start_sec=1.0,
        end_sec=2.0,
        scores={"host": 0.9, "guest": 0.1},
        best_track_id="host",
        best_identity="host",
        margin=0.8,
    )
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value=_profiles(),
        ),
        patch(
            "podcast_mcp.engines.speaker_id.score_window",
            side_effect=lambda _p, tid, s, e, *_a, **_k: bleed if e <= 3.1 else own,
        ),
    ):
        report = label_track_home_speaker(proj, cfg, MockSpeakerBackend(), dry_run=True)
    assert report["words_would_suppress"] >= 1
    assert report["words_suppressed"] == 0
    um = next(w for w in proj.transcript_for_track("host").words if w.text == "um")
    assert um.suppressed is False


def test_compare_pair_error_when_unscorable(tmp_path, sample_wav) -> None:
    _project(tmp_path, sample_wav)
    ws = ProjectWorkspace.open(tmp_path / "episode.project.json")
    with patch(
        "podcast_mcp.services.speaker.score_window",
        return_value=None,
    ):
        out = SpeakerService(ws).compare_pair("host", 0.0, 1.0, "guest", 0.0, 1.0)
    assert out["error"] == "could not score one or both windows"


def test_cosine_similarity_zero_norm_returns_zero() -> None:
    from podcast_mcp.engines.speaker_id import _cosine_similarity

    assert _cosine_similarity(np.zeros(3), np.ones(3)) == 0.0
    assert _cosine_similarity(np.zeros(3), np.zeros(3)) == 0.0


def test_mock_backend_empty_samples() -> None:
    backend = MockSpeakerBackend()
    emb = backend.embed(np.array([], dtype=np.float32), 16000)
    assert emb.shape == (8,)
    assert float(np.linalg.norm(emb)) == 0.0


def test_enroll_service_skips_tracks_without_transcript(tmp_path, sample_wav) -> None:
    proj = _project(tmp_path, sample_wav)
    proj.transcripts = [t for t in proj.transcripts if t.track_id == "host"]
    path = tmp_path / "episode.project.json"
    save_project(proj, path)
    ws = ProjectWorkspace.open(path)
    with patch(
        "podcast_mcp.services.speaker.enroll_track",
        side_effect=lambda p, tid, *_a, **_k: (
            SpeakerProfile(
                speaker_id=tid,
                track_id=tid,
                embedding=[1.0],
                enrollment_sec=1.0,
                stem_hash="x",
                home_track_id=tid,
            )
            if tid == "host"
            else None
        ),
    ):
        out = SpeakerService(ws).enroll()
    assert out["enrolled"] == ["host"]


def test_resolve_speaker_backend_unknown_raises() -> None:
    with pytest.raises(ImportError, match="unavailable"):
        resolve_speaker_backend("unknown-backend")


def test_enroll_track_no_transcript_returns_none(tmp_path, sample_wav) -> None:
    proj = _project(tmp_path, sample_wav)
    proj.transcripts = [t for t in proj.transcripts if t.track_id != "host"]
    cfg = SpeakerIdConfig(min_enrollment_sec=0.1)
    assert enroll_track(proj, "host", cfg, MockSpeakerBackend()) is None


def test_enroll_segment_via_service_returns_empty_when_invalid(tmp_path, sample_wav) -> None:
    _project(tmp_path, sample_wav)
    ws = ProjectWorkspace.open(tmp_path / "episode.project.json")
    out = SpeakerService(ws).enroll(
        speaker_id="alice",
        track_id="host",
        start_sec=1.0,
        end_sec=1.1,
    )
    assert out["enrolled"] == []


def test_stem_path_uses_raw_when_no_processed_stem(tmp_path, sample_wav) -> None:
    proj = _project(tmp_path, sample_wav)
    path, source = _stem_path_and_source(proj, "host")
    assert source == "raw"
    assert path is not None
    assert path.name == "host.wav"


def test_profile_to_dict_includes_audio_source() -> None:
    prof = SpeakerProfile(
        speaker_id="host",
        track_id="host",
        embedding=[1.0],
        enrollment_sec=1.0,
        stem_hash="h",
        audio_source="processed",
    )
    data = prof.to_dict()
    assert data["audio_source"] == "processed"


def test_resolve_expected_speaker_count_from_profiles_stale_skipped(
    tmp_path,
) -> None:
    from podcast_mcp.engines.speaker_id import resolve_expected_speaker_count

    proj = EpisodeProject.create("x", str(tmp_path))
    prof = SpeakerProfile(
        speaker_id="a",
        track_id="t1",
        embedding=[1.0],
        enrollment_sec=1.0,
        stem_hash="h",
        home_track_id="home_a",
    )
    d = proj.artifacts_dir() / "speaker_profiles"
    d.mkdir(parents=True)
    (d / "a_h.json").write_text(json.dumps(prof.to_dict()), encoding="utf-8")
    with patch(
        "podcast_mcp.engines.speaker_id._profile_stem_valid",
        return_value=True,
    ):
        count, source = resolve_expected_speaker_count(proj, SpeakerIdConfig())
    assert count == 1
    assert source == "inferred"
