"""Unit tests for speaker recognition (standalone + bleed consumers)."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import numpy as np

from podcast_mcp.edits.speech_energy_guard import resolve_cut_scope
from podcast_mcp.edits.transcript_precorrect import _should_run_speaker
from podcast_mcp.engines.speaker_id import (
    MockSpeakerBackend,
    SpeakerIdConfig,
    SpeakerProfile,
    WindowScore,
    _bleed_windows,
    classify_track_role,
    compare_window,
    enroll_segment,
    extend_intervals_with_speaker_gaps,
    load_all_profiles,
    load_profile,
    profile_home_track,
    resolve_expected_speaker_count,
    run_speaker_attribution,
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
from podcast_mcp.transcript_context import SpeakerIdConfig as CtxSpeakerIdConfig
from podcast_mcp.transcript_context import TranscriptContext


def _two_track_project(tmp_path: Path, sample_wav: Path) -> EpisodeProject:
    raw = tmp_path / "raw"
    raw.mkdir()
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
                    suppressed=True,
                )
            ],
        ),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(
                    text="hello",
                    start=1.0,
                    end=1.5,
                    audibility_status="audible",
                )
            ],
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


def test_bleed_windows_includes_suppressed(tmp_path, sample_wav) -> None:
    proj = _two_track_project(tmp_path, sample_wav)
    cfg = SpeakerIdConfig(min_window_sec=0.2)
    windows = _bleed_windows(proj, cfg)
    assert len(windows) == 1
    assert windows[0][0] == "host"


def test_resolve_expected_speaker_count_user_and_inferred(tmp_path, sample_wav) -> None:
    proj = _two_track_project(tmp_path, sample_wav)
    cfg = SpeakerIdConfig(expected_speaker_count=2, speaker_count_source="user")
    count, source = resolve_expected_speaker_count(proj, cfg)
    assert count == 2
    assert source == "user"
    count2, source2 = resolve_expected_speaker_count(proj, SpeakerIdConfig())
    assert count2 == 2
    assert source2 == "inferred"


def test_classify_track_role_own_and_bleed() -> None:
    cfg = SpeakerIdConfig(min_margin=0.1)
    own = WindowScore(
        track_id="host",
        start_sec=0,
        end_sec=1,
        scores={"host": 0.9, "guest": 0.2},
        best_track_id="host",
        best_identity="host",
        margin=0.7,
    )
    role, _ = classify_track_role(own, "host", cfg)
    assert role == "own"
    bleed = WindowScore(
        track_id="host",
        start_sec=0,
        end_sec=1,
        scores={"host": 0.2, "guest": 0.9},
        best_track_id="guest",
        best_identity="guest",
        margin=0.7,
    )
    role2, match = classify_track_role(bleed, "host", cfg)
    assert role2 == "bleed"
    assert match == "guest"


def test_compare_window_roles(tmp_path, sample_wav) -> None:
    proj = _two_track_project(tmp_path, sample_wav)
    cfg = SpeakerIdConfig(min_margin=0.1)
    backend = MockSpeakerBackend()
    profiles = _profiles()

    def fake_score(project, track_id, start, end, cfg, backend, profiles=None):
        if track_id == "host":
            return WindowScore(
                track_id="host",
                start_sec=start,
                end_sec=end,
                scores={"host": 0.1, "guest": 0.9},
                best_track_id="guest",
                best_identity="guest",
                margin=0.8,
            )
        return WindowScore(
            track_id="guest",
            start_sec=start,
            end_sec=end,
            scores={"host": 0.1, "guest": 0.9},
            best_track_id="guest",
            best_identity="guest",
            margin=0.8,
        )

    with (
        patch("podcast_mcp.engines.speaker_id.score_window", side_effect=fake_score),
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value=profiles,
        ),
    ):
        out = compare_window(proj, 1.0, 1.5, cfg, backend)
    roles = {t["track_id"]: t["role"] for t in out["tracks"]}
    assert roles["host"] == "bleed"
    assert roles["guest"] == "own"
    assert out["owner_track_id"] == "guest"


def test_enroll_segment_writes_profile(tmp_path, sample_wav) -> None:
    proj = _two_track_project(tmp_path, sample_wav)
    cfg = SpeakerIdConfig(min_window_sec=0.2, min_enrollment_sec=1.0)
    prof = enroll_segment(
        proj,
        "person_a",
        "host",
        0.1,
        0.6,
        cfg,
        MockSpeakerBackend(),
        home_track_id="host",
    )
    assert prof is not None
    assert prof.speaker_id == "person_a"
    loaded = load_all_profiles(proj)
    assert "person_a" in loaded
    assert profile_home_track(loaded["person_a"]) == "host"


def test_should_run_speaker_auto_thresholds(tmp_path, sample_wav) -> None:
    proj = _two_track_project(tmp_path, sample_wav)
    ctx = TranscriptContext(
        speaker_id=CtxSpeakerIdConfig(mode="never"),
    )
    run, reason = _should_run_speaker(proj, ctx, [])
    assert not run
    assert "never" in reason

    ctx_auto = TranscriptContext(
        speaker_id=CtxSpeakerIdConfig(
            mode="auto",
            bleed_word_threshold=1,
            bleed_ratio_threshold=0.0,
        ),
    )
    run2, _ = _should_run_speaker(proj, ctx_auto, [])
    assert run2


def test_resolve_cut_scope_bleed_forces_track_local(tmp_path, sample_wav) -> None:
    proj = _two_track_project(tmp_path, sample_wav)
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value=_profiles(),
        ),
        patch(
            "podcast_mcp.engines.speaker_id.assess_speaker_cut_role",
            return_value={"role": "bleed", "match_home_track": "guest"},
        ),
    ):
        scope, guard = resolve_cut_scope(proj, "host", 1.0, 1.5)
    assert scope == "track"
    assert guard is None


def test_run_speaker_attribution_dry_run(tmp_path, sample_wav) -> None:
    proj = _two_track_project(tmp_path, sample_wav)
    ctx = TranscriptContext(speaker_id=CtxSpeakerIdConfig(min_margin=0.1))
    with (
        patch(
            "podcast_mcp.engines.speaker_id.enroll_track",
            side_effect=lambda p, tid, cfg, eng, **kw: _profiles().get(tid),
        ),
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
        report = run_speaker_attribution(proj, ctx, dry_run=True, backend=MockSpeakerBackend())
    assert report["attributions_would_change"] == 1
    assert report["attributions_changed"] == 0
    assert report["windows_scored"] == 1


def test_extend_intervals_merges_owner_gap(tmp_path, sample_wav) -> None:
    proj = _two_track_project(tmp_path, sample_wav)
    cfg = SpeakerIdConfig(min_margin=0.1, max_speaker_gap_sec=0.5)
    intervals = [(0.0, 1.0), (1.2, 2.0)]
    own_score = WindowScore(
        track_id="host",
        start_sec=0,
        end_sec=1,
        scores={"host": 0.9},
        best_track_id="host",
        best_identity="host",
        margin=0.5,
    )
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value=_profiles(),
        ),
        patch(
            "podcast_mcp.engines.speaker_id.score_window",
            return_value=own_score,
        ),
    ):
        merged = extend_intervals_with_speaker_gaps(
            proj, "host", intervals, cfg, MockSpeakerBackend()
        )
    assert len(merged) == 1
    assert merged[0] == (0.0, 2.0)


def test_label_window_dry_run(tmp_path, sample_wav) -> None:
    proj = _two_track_project(tmp_path, sample_wav)
    cfg = SpeakerIdConfig(min_margin=0.1)
    bleed_score = WindowScore(
        track_id="host",
        start_sec=1.0,
        end_sec=1.5,
        scores={"host": 0.1, "guest": 0.9},
        best_track_id="guest",
        best_identity="guest",
        margin=0.8,
    )
    with patch(
        "podcast_mcp.engines.speaker_id.score_window",
        return_value=bleed_score,
    ):
        from podcast_mcp.engines.speaker_id import label_window

        out = label_window(proj, "host", 1.0, 1.5, cfg, MockSpeakerBackend(), dry_run=True)
    assert out["labeled"] == 1
    assert out["role"] == "bleed"


def test_speaker_service_segment_enroll_label_and_count(tmp_path, sample_wav) -> None:
    from podcast_mcp.services import ProjectWorkspace, SpeakerService

    proj = _two_track_project(tmp_path, sample_wav)
    path = tmp_path / "episode.project.json"
    save_project(proj, path)
    ws = ProjectWorkspace.open(path)
    svc = SpeakerService(ws)
    ctx = TranscriptContext()

    with patch(
        "podcast_mcp.services.speaker.load_transcript_context",
        return_value=ctx,
    ):
        with patch(
            "podcast_mcp.services.speaker.enroll_segment",
            return_value=SpeakerProfile(
                speaker_id="person_a",
                track_id="host",
                embedding=[1.0],
                enrollment_sec=1.0,
                stem_hash="x",
            ),
        ):
            out = svc.enroll(
                speaker_id="person_a",
                track_id="host",
                start_sec=0.1,
                end_sec=0.5,
            )
        assert out["enrolled"] == ["person_a"]

        saved = svc.set_expected_speaker_count(2)
        assert saved["expected_speaker_count"] == 2

        with patch(
            "podcast_mcp.services.speaker.compare_window",
            return_value={"tracks": []},
        ):
            cmp = svc.compare_window(1.0, 1.5)
        assert "tracks" in cmp

        with patch(
            "podcast_mcp.services.speaker.label_window",
            return_value={"labeled": 1, "role": "own"},
        ):
            labeled = svc.label("host", 1.0, 1.5, dry_run=True)
        assert labeled["labeled"] == 1

        with (
            patch(
                "podcast_mcp.services.speaker.run_speaker_attribution",
                return_value={"ok": True},
            ),
            patch.object(ws, "mutate", return_value={"ok": True}),
        ):
            applied = svc.attribute(dry_run=False)
        assert applied["ok"] is True


def test_assess_speaker_cut_role_and_label_apply(tmp_path, sample_wav) -> None:
    from podcast_mcp.engines.speaker_id import (
        assess_speaker_cut_role,
        label_window,
    )

    proj = _two_track_project(tmp_path, sample_wav)
    cfg = SpeakerIdConfig(min_margin=0.1)
    profiles = _profiles()
    own = WindowScore(
        track_id="guest",
        start_sec=1.0,
        end_sec=1.5,
        scores={"guest": 0.95, "host": 0.1},
        best_track_id="guest",
        best_identity="guest",
        margin=0.85,
    )
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value=profiles,
        ),
        patch(
            "podcast_mcp.engines.speaker_id.score_window",
            return_value=own,
        ),
    ):
        role = assess_speaker_cut_role(proj, "guest", 1.0, 1.5, cfg)
    assert role is not None
    assert role["role"] == "own"

    with (
        patch(
            "podcast_mcp.engines.speaker_id.score_window",
            return_value=own,
        ),
        patch("podcast_mcp.edits.transcript_sync.rebuild_combined") as rebuild,
    ):
        out = label_window(proj, "guest", 1.0, 1.5, cfg, MockSpeakerBackend(), dry_run=False)
    assert out["labeled"] == 1
    rebuild.assert_called_once()


def test_resolve_expected_speaker_count_unknown(tmp_path) -> None:
    from podcast_mcp.models import EpisodeProject

    proj = EpisodeProject.create("empty", str(tmp_path))
    count, source = resolve_expected_speaker_count(proj, SpeakerIdConfig())
    assert count is None
    assert source == "unknown"


def test_load_profile_by_identity_scan(tmp_path, sample_wav) -> None:
    proj = _two_track_project(tmp_path, sample_wav)
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
    loaded = load_profile(proj, "alice")
    assert loaded is not None
    assert loaded.speaker_id == "alice"
    by_home = load_profile(proj, "host")
    assert by_home is not None
    assert by_home.speaker_id == "alice"


def test_load_profile_returns_none_when_stem_missing(tmp_path, sample_wav) -> None:
    proj = _two_track_project(tmp_path, sample_wav)
    (proj.workspace_path() / "raw" / "host.wav").unlink()
    assert load_profile(proj, "host") is None


def test_compare_window_bleed_match_home_track(tmp_path, sample_wav) -> None:
    proj = _two_track_project(tmp_path, sample_wav)
    cfg = SpeakerIdConfig(min_margin=0.1)

    def fake_score(project, track_id, start, end, cfg, backend, profiles=None):
        if track_id == "host":
            return WindowScore(
                track_id="host",
                start_sec=start,
                end_sec=end,
                scores={"host": 0.1, "guest": 0.9},
                best_track_id="guest",
                best_identity="guest",
                margin=0.8,
            )
        return WindowScore(
            track_id="guest",
            start_sec=start,
            end_sec=end,
            scores={"guest": 0.95, "host": 0.1},
            best_track_id="guest",
            best_identity="guest",
            margin=0.85,
        )

    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value=_profiles(),
        ),
        patch(
            "podcast_mcp.engines.speaker_id.score_window",
            side_effect=fake_score,
        ),
    ):
        out = compare_window(proj, 1.0, 1.5, cfg, MockSpeakerBackend())
    host = next(t for t in out["tracks"] if t["track_id"] == "host")
    assert host["role"] == "bleed"
    assert host["match_home_track"] == "guest"
    assert out["owner_track_id"] == "guest"


def test_resolve_expected_speaker_count_from_profiles(tmp_path) -> None:
    from podcast_mcp.models import EpisodeProject

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
    d.mkdir(parents=True, exist_ok=True)
    (d / "a_h.json").write_text(json.dumps(prof.to_dict()), encoding="utf-8")
    with patch(
        "podcast_mcp.engines.speaker_id._profile_stem_valid",
        return_value=True,
    ):
        count, source = resolve_expected_speaker_count(proj, SpeakerIdConfig())
    assert count == 1
    assert source == "inferred"


def test_resolve_expected_speaker_count_from_track_labels(tmp_path) -> None:
    from podcast_mcp.models import EpisodeProject, Track, TrackRole

    proj = EpisodeProject.create("labels", str(tmp_path))
    proj.tracks = [
        Track(id="a", label="Alice", speaker="Alice", role=TrackRole.DIALOGUE),
        Track(id="b", label="Bob", speaker="Bob", role=TrackRole.DIALOGUE),
    ]
    count, source = resolve_expected_speaker_count(proj, SpeakerIdConfig())
    assert count == 2
    assert source == "inferred"


def test_enroll_segment_invalid_window(tmp_path, sample_wav) -> None:
    proj = _two_track_project(tmp_path, sample_wav)
    cfg = SpeakerIdConfig(min_window_sec=0.5)
    assert (
        enroll_segment(
            proj,
            "a",
            "host",
            1.0,
            1.1,
            cfg,
            MockSpeakerBackend(),
        )
        is None
    )


def test_extend_intervals_gap_branches(tmp_path, sample_wav) -> None:
    proj = _two_track_project(tmp_path, sample_wav)
    cfg = SpeakerIdConfig(min_margin=0.1, max_speaker_gap_sec=0.1)
    intervals = [(0.0, 1.0), (1.5, 2.0)]
    with patch(
        "podcast_mcp.engines.speaker_id.load_all_profiles",
        return_value=_profiles(),
    ):
        merged = extend_intervals_with_speaker_gaps(
            proj, "host", intervals, cfg, MockSpeakerBackend()
        )
    assert merged == intervals

    bleed = WindowScore(
        track_id="host",
        start_sec=1.0,
        end_sec=1.2,
        scores={"host": 0.1, "guest": 0.9},
        best_track_id="guest",
        best_identity="guest",
        margin=0.8,
    )
    intervals2 = [(0.0, 1.0), (1.2, 2.0)]
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value=_profiles(),
        ),
        patch(
            "podcast_mcp.engines.speaker_id.score_window",
            return_value=bleed,
        ),
    ):
        merged2 = extend_intervals_with_speaker_gaps(
            proj, "host", intervals2, cfg, MockSpeakerBackend()
        )
    assert len(merged2) == 2


def test_label_window_errors_and_uncertain(tmp_path, sample_wav) -> None:
    from podcast_mcp.engines.speaker_id import label_window

    proj = _two_track_project(tmp_path, sample_wav)
    cfg = SpeakerIdConfig(min_margin=0.5)
    uncertain = WindowScore(
        track_id="host",
        start_sec=1.0,
        end_sec=1.5,
        scores={"host": 0.5, "guest": 0.51},
        best_track_id="guest",
        best_identity="guest",
        margin=0.01,
    )
    with patch("podcast_mcp.engines.speaker_id.score_window", return_value=None):
        assert "error" in label_window(proj, "host", 1.0, 1.5, cfg, MockSpeakerBackend())
    with patch(
        "podcast_mcp.engines.speaker_id.score_window",
        return_value=uncertain,
    ):
        out = label_window(proj, "host", 1.0, 1.5, cfg, MockSpeakerBackend(), dry_run=True)
    assert out["labeled"] == 0
    assert out["role"] == "uncertain"

    proj.transcripts = []
    own = WindowScore(
        track_id="host",
        start_sec=1.0,
        end_sec=1.5,
        scores={"host": 0.9},
        best_track_id="host",
        best_identity="host",
        margin=0.8,
    )
    with patch(
        "podcast_mcp.engines.speaker_id.score_window",
        return_value=own,
    ):
        bad = label_window(proj, "host", 1.0, 1.5, cfg, MockSpeakerBackend())
    assert bad.get("error") == "no transcript"


def test_extend_intervals_overlap_and_invalid_gap_source(tmp_path, sample_wav) -> None:
    from podcast_mcp.engines.session_timeline import SessionTimeline
    from podcast_mcp.util.timebase import TimelineSec

    proj = _two_track_project(tmp_path, sample_wav)
    cfg = SpeakerIdConfig(min_margin=0.1, max_speaker_gap_sec=0.5)
    with patch(
        "podcast_mcp.engines.speaker_id.load_all_profiles",
        return_value=_profiles(),
    ):
        merged = extend_intervals_with_speaker_gaps(
            proj,
            "host",
            [(0.0, 1.5), (1.0, 2.0)],
            cfg,
            MockSpeakerBackend(),
        )
    assert merged[0] == (0.0, 2.0)

    st = SessionTimeline(proj)
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value=_profiles(),
        ),
        patch.object(
            st,
            "timeline_to_source",
            return_value=TimelineSec(5.0),
        ),
        patch(
            "podcast_mcp.engines.session_timeline.SessionTimeline",
            return_value=st,
        ),
    ):
        out = extend_intervals_with_speaker_gaps(
            proj,
            "host",
            [(0.0, 1.0), (1.2, 2.0)],
            cfg,
            MockSpeakerBackend(),
        )
    assert len(out) == 2

    assert extend_intervals_with_speaker_gaps(
        proj,
        "host",
        [(0.0, 1.0)],
        SpeakerIdConfig(max_speaker_gap_sec=0),
        MockSpeakerBackend(),
    ) == [(0.0, 1.0)]


def test_run_speaker_skips_enroll_when_profile_exists(tmp_path, sample_wav) -> None:
    proj = _two_track_project(tmp_path, sample_wav)
    ctx = TranscriptContext(speaker_id=CtxSpeakerIdConfig(min_margin=0.5))
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value=_profiles(),
        ),
        patch(
            "podcast_mcp.engines.speaker_id.enroll_track",
        ) as enroll,
        patch(
            "podcast_mcp.engines.speaker_id._bleed_windows",
            return_value=[],
        ),
    ):
        report = run_speaker_attribution(proj, ctx, dry_run=True, backend=MockSpeakerBackend())
    enroll.assert_not_called()
    assert report["profiles"]


def test_assess_speaker_cut_role_none_without_profiles(tmp_path, sample_wav) -> None:
    from podcast_mcp.engines.speaker_id import assess_speaker_cut_role

    proj = _two_track_project(tmp_path, sample_wav)
    with patch(
        "podcast_mcp.engines.speaker_id.load_all_profiles",
        return_value={},
    ):
        assert assess_speaker_cut_role(proj, "host", 1.0, 1.5, SpeakerIdConfig()) is None


def test_label_window_bleed_apply(tmp_path, sample_wav) -> None:
    from podcast_mcp.engines.speaker_id import label_window

    proj = _two_track_project(tmp_path, sample_wav)
    cfg = SpeakerIdConfig(min_margin=0.1, auto_suppress=True)
    bleed = WindowScore(
        track_id="host",
        start_sec=1.0,
        end_sec=1.5,
        scores={"host": 0.1, "guest": 0.9},
        best_track_id="guest",
        best_identity="guest",
        margin=0.8,
    )
    with (
        patch(
            "podcast_mcp.engines.speaker_id.score_window",
            return_value=bleed,
        ),
        patch("podcast_mcp.edits.transcript_sync.rebuild_combined") as rebuild,
    ):
        out = label_window(proj, "host", 1.0, 1.5, cfg, MockSpeakerBackend(), dry_run=False)
    assert out["role"] == "bleed"
    assert out["labeled"] == 1
    rebuild.assert_called_once()
    word = proj.transcript_for_track("host").words[0]
    assert word.speaker_match_track == "guest"
    assert word.suppressed is True


def test_score_window_loads_dialogue_profiles_when_cache_empty(tmp_path, sample_wav) -> None:
    proj = _two_track_project(tmp_path, sample_wav)
    cfg = SpeakerIdConfig()
    backend = MockSpeakerBackend()
    prof = _profiles()["host"]
    cache_dir = proj.artifacts_dir() / "speaker_profiles"
    cache_dir.mkdir(parents=True, exist_ok=True)
    (cache_dir / "host_abc.json").write_text(json.dumps(prof.to_dict()), encoding="utf-8")
    with (
        patch(
            "podcast_mcp.engines.speaker_id._stem_hash",
            return_value="abc",
        ),
        patch(
            "podcast_mcp.engines.speaker_id.load_mono_window",
            return_value=np.ones(8000, dtype=np.float32),
        ),
    ):
        ws = score_window(proj, "host", 1.0, 1.5, cfg, backend)
    assert ws is not None


def test_compare_window_with_track_filter(tmp_path, sample_wav) -> None:
    proj = _two_track_project(tmp_path, sample_wav)
    with (
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
                scores={"host": 0.9},
                best_track_id="host",
                best_identity="host",
                margin=0.5,
            ),
        ) as score,
    ):
        out = compare_window(
            proj,
            1.0,
            1.5,
            SpeakerIdConfig(min_margin=0.1),
            MockSpeakerBackend(),
            track_ids=["host"],
        )
    score.assert_called_once()
    assert len(out["tracks"]) == 1


def test_set_expected_speaker_count_persists(minimal_project) -> None:
    from podcast_mcp.services import ProjectWorkspace, SpeakerService
    from podcast_mcp.transcript_context import load_transcript_context

    ws = ProjectWorkspace.open(minimal_project)
    SpeakerService(ws).set_expected_speaker_count(2, source="user")
    ctx = load_transcript_context(ws.project.workspace_path())
    assert ctx.speaker_id.expected_speaker_count == 2
    assert ctx.speaker_id.speaker_count_source == "user"


def test_compare_window_handles_missing_score(tmp_path, sample_wav) -> None:
    proj = _two_track_project(tmp_path, sample_wav)

    def fake_score(project, track_id, start, end, cfg, backend, profiles=None):
        if track_id == "host":
            return None
        return WindowScore(
            track_id="guest",
            start_sec=start,
            end_sec=end,
            scores={"guest": 0.9},
            best_track_id="guest",
            best_identity="guest",
            margin=0.5,
        )

    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value=_profiles(),
        ),
        patch(
            "podcast_mcp.engines.speaker_id.score_window",
            side_effect=fake_score,
        ),
    ):
        out = compare_window(
            proj,
            1.0,
            1.5,
            SpeakerIdConfig(min_margin=0.1),
            MockSpeakerBackend(),
        )
    host = next(t for t in out["tracks"] if t["track_id"] == "host")
    assert host["role"] == "uncertain"
    assert out["owner_track_id"] == "guest"


def test_extend_intervals_when_source_map_missing(tmp_path, sample_wav) -> None:

    proj = _two_track_project(tmp_path, sample_wav)
    cfg = SpeakerIdConfig(min_margin=0.1, max_speaker_gap_sec=0.5)

    def fake_src(tid, tl):
        return None

    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value=_profiles(),
        ),
        patch(
            "podcast_mcp.engines.session_timeline.SessionTimeline.timeline_to_source",
            side_effect=fake_src,
        ),
    ):
        out = extend_intervals_with_speaker_gaps(
            proj,
            "host",
            [(0.0, 1.0), (1.2, 2.0)],
            cfg,
            MockSpeakerBackend(),
        )
    assert len(out) == 2


def test_classify_track_role_uncertain() -> None:
    cfg = SpeakerIdConfig(min_margin=0.5)
    low = WindowScore(
        track_id="host",
        start_sec=0,
        end_sec=1,
        scores={"host": 0.5},
        best_track_id="host",
        margin=0.1,
    )
    role, match = classify_track_role(low, "host", cfg)
    assert role == "uncertain"
    assert match is None
    assert classify_track_role(None, "host", cfg) == ("uncertain", None)


def test_enroll_segment_missing_track(tmp_path, sample_wav) -> None:
    proj = _two_track_project(tmp_path, sample_wav)
    assert (
        enroll_segment(
            proj,
            "x",
            "missing",
            0.0,
            1.0,
            SpeakerIdConfig(),
            MockSpeakerBackend(),
        )
        is None
    )


def test_extend_intervals_when_gap_source_collapsed(tmp_path, sample_wav) -> None:
    from podcast_mcp.util.timebase import TimelineSec

    proj = _two_track_project(tmp_path, sample_wav)
    cfg = SpeakerIdConfig(min_margin=0.1, max_speaker_gap_sec=0.5)

    def same_src(tid, tl):
        return TimelineSec(5.0)

    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value=_profiles(),
        ),
        patch(
            "podcast_mcp.engines.session_timeline.SessionTimeline.timeline_to_source",
            side_effect=same_src,
        ),
    ):
        out = extend_intervals_with_speaker_gaps(
            proj,
            "host",
            [(0.0, 1.0), (1.2, 2.0)],
            cfg,
            MockSpeakerBackend(),
        )
    assert len(out) == 2


def test_resolve_speaker_backend_explicit_mock() -> None:
    from podcast_mcp.engines.speaker_id import resolve_speaker_backend

    assert resolve_speaker_backend("mock").name() == "mock"


def test_score_window_fallback_loads_track_cache(tmp_path, sample_wav) -> None:
    proj = _two_track_project(tmp_path, sample_wav)
    prof = _profiles()["host"]
    cache_dir = proj.artifacts_dir() / "speaker_profiles"
    cache_dir.mkdir(parents=True, exist_ok=True)
    (cache_dir / "host_abc.json").write_text(json.dumps(prof.to_dict()), encoding="utf-8")
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value={},
        ),
        patch(
            "podcast_mcp.engines.speaker_id._stem_hash",
            return_value="abc",
        ),
        patch(
            "podcast_mcp.engines.speaker_id.load_mono_window",
            return_value=np.ones(8000, dtype=np.float32),
        ),
    ):
        ws = score_window(
            proj,
            "host",
            1.0,
            1.5,
            SpeakerIdConfig(),
            MockSpeakerBackend(),
            profiles=None,
        )
    assert ws is not None


def test_label_window_own_apply(tmp_path, sample_wav) -> None:
    from podcast_mcp.engines.speaker_id import label_window

    proj = _two_track_project(tmp_path, sample_wav)
    cfg = SpeakerIdConfig(min_margin=0.1)
    own = WindowScore(
        track_id="guest",
        start_sec=1.0,
        end_sec=1.5,
        scores={"guest": 0.95},
        best_track_id="guest",
        best_identity="guest",
        margin=0.8,
    )
    with (
        patch(
            "podcast_mcp.engines.speaker_id.score_window",
            return_value=own,
        ),
        patch("podcast_mcp.edits.transcript_sync.rebuild_combined") as rebuild,
    ):
        out = label_window(proj, "guest", 1.0, 1.5, cfg, MockSpeakerBackend(), dry_run=False)
    assert out["role"] == "own"
    assert out["labeled"] == 1
    rebuild.assert_called_once()


def test_compare_window_picks_highest_own_margin(tmp_path, sample_wav) -> None:
    proj = _two_track_project(tmp_path, sample_wav)

    def fake_score(project, track_id, start, end, cfg, backend, profiles=None):
        if track_id == "host":
            return WindowScore(
                track_id="host",
                start_sec=start,
                end_sec=end,
                scores={"host": 0.7},
                best_track_id="host",
                best_identity="host",
                margin=0.5,
            )
        return WindowScore(
            track_id="guest",
            start_sec=start,
            end_sec=end,
            scores={"guest": 0.95},
            best_track_id="guest",
            best_identity="guest",
            margin=0.9,
        )

    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value=_profiles(),
        ),
        patch(
            "podcast_mcp.engines.speaker_id.score_window",
            side_effect=fake_score,
        ),
    ):
        out = compare_window(
            proj,
            1.0,
            1.5,
            SpeakerIdConfig(min_margin=0.1),
            MockSpeakerBackend(),
        )
    assert out["owner_track_id"] == "guest"
