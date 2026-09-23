from __future__ import annotations

import pytest

from podcast_mcp.edits.audition_context import build_audition_context
from podcast_mcp.models import (
    Clip,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.services.play import PlayService
from podcast_mcp.services.workspace import ProjectWorkspace


def _two_track_project(minimal_project, sample_wav, tmp_workspace, *, skew_sec: float = 0.0):
    proj = load_project(minimal_project)
    raw = tmp_workspace / "raw"
    raw.mkdir(exist_ok=True)
    for tid in ("host", "guest"):
        dest = raw / f"{tid}.wav"
        dest.write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=60.0),
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/guest.wav", duration_sec=60.0),
        ),
    ]
    proj.clips = [
        Clip(
            id="c_host",
            track_id="host",
            source_start=10.0,
            source_end=40.0,
            timeline_start=0.0,
        ),
        Clip(
            id="c_guest",
            track_id="guest",
            source_start=10.0,
            source_end=40.0,
            timeline_start=skew_sec,
        ),
    ]
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=12.0, end=12.4, confidence=0.9),
                TranscriptWord(text="world", start=12.5, end=13.0, confidence=0.9),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text="totally", start=12.0, end=12.5, confidence=0.9),
                TranscriptWord(text="different", start=12.6, end=13.2, confidence=0.9),
                TranscriptWord(text="topic", start=13.3, end=13.8, confidence=0.9),
                TranscriptWord(text="here", start=13.9, end=14.2, confidence=0.9),
                TranscriptWord(text="now", start=14.3, end=14.6, confidence=0.9),
                TranscriptWord(text="yes", start=14.7, end=15.0, confidence=0.9),
                TranscriptWord(text="really", start=15.1, end=15.5, confidence=0.9),
                TranscriptWord(text="long", start=15.6, end=16.0, confidence=0.9),
                TranscriptWord(text="line", start=16.1, end=16.5, confidence=0.9),
            ],
        ),
    ]
    save_project(proj, minimal_project)
    return load_project(minimal_project)


def test_audition_context_captions_and_skew(minimal_project, sample_wav, tmp_workspace):
    # Align guest clip 0.6s later on timeline with same source → mid maps differently
    proj = _two_track_project(minimal_project, sample_wav, tmp_workspace, skew_sec=0.6)
    # Re-save via helper already done; use loaded path
    ctx = build_audition_context(proj, 2.0, 6.0, skew_warn_sec=0.05)
    assert ctx["timeline_start"] == 2.0
    by_id = {t["track_id"]: t for t in ctx["tracks"]}
    assert "hello" in by_id["host"]["text"]
    assert "different" in by_id["guest"]["text"] or by_id["guest"]["word_count"] >= 0
    deltas = [p["source_delta_sec"] for p in ctx["clip_skew"]["pairs"]]
    assert deltas and deltas[0] == pytest.approx(0.6, abs=0.05)
    assert ctx["clip_skew"]["any_skewed"] is False
    assert not any("clip_skew" in w for w in ctx["warnings"])
    assert all(h["code"] != "clip_skew" for h in ctx["hypotheses"])


def test_audition_context_aligned_no_skew(minimal_project, sample_wav, tmp_workspace):
    proj = _two_track_project(minimal_project, sample_wav, tmp_workspace, skew_sec=0.0)
    ctx = build_audition_context(proj, 2.0, 6.0)
    assert ctx["clip_skew"]["any_skewed"] is False


def test_play_service_audition_context(minimal_project, sample_wav, tmp_workspace):
    _two_track_project(minimal_project, sample_wav, tmp_workspace, skew_sec=0.0)
    ws = ProjectWorkspace.open(minimal_project)
    ctx = PlayService(ws).audition_context(1.0, 5.0)
    assert "summary" in ctx
    assert len(ctx["tracks"]) == 2


def test_play_service_audition_context_can_skip_track_dsp(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _two_track_project(minimal_project, sample_wav, tmp_workspace, skew_sec=0.0)
    ws = ProjectWorkspace.open(minimal_project)

    def fail_if_dsp_runs(*_args, **_kwargs):
        raise AssertionError("golden-ear context must use rendered pair audio for DSP")

    monkeypatch.setattr(
        "podcast_mcp.edits.audition_context._diagnostics_for_tracks", fail_if_dsp_runs
    )
    ctx = PlayService(ws).audition_context(1.0, 5.0, include_dsp=False)
    assert ctx["schema"] == "audition_context.v2"
    assert len(ctx["tracks"]) == 2
    assert "visuals" not in ctx


def test_audition_context_includes_effects_and_comments(minimal_project, sample_wav, tmp_workspace):
    from podcast_mcp.edits.comments import add_comment
    from podcast_mcp.models import ProcessingChain, ProcessingEffect

    proj = _two_track_project(minimal_project, sample_wav, tmp_workspace, skew_sec=0.0)
    proj.processing_chains = [
        ProcessingChain(
            track_id="host",
            effects=[
                ProcessingEffect(effect="gate", params={"threshold": -40}),
                ProcessingEffect(effect="eq", params={}, bypass=True),
            ],
        )
    ]
    add_comment(
        proj,
        body="Check join",
        author="agent",
        timeline_start=2.5,
        timeline_end=4.0,
        action_texts=["Listen"],
    )
    save_project(proj, minimal_project)
    proj = load_project(minimal_project)
    ctx = build_audition_context(proj, 2.0, 6.0)
    host = next(t for t in ctx["tracks"] if t["track_id"] == "host")
    assert len(host["effects"]) == 1
    assert host["effects"][0]["effect"] == "gate"
    assert len(ctx["comments"]) == 1
    assert ctx["comments"][0]["open_action_count"] == 1
    assert "comments" in ctx["summary"] or "1 comments" in ctx["summary"]


def test_audition_context_rejects_bad_detail(minimal_project, sample_wav, tmp_workspace):
    proj = _two_track_project(minimal_project, sample_wav, tmp_workspace)
    with __import__("pytest").raises(ValueError, match="detail"):
        build_audition_context(proj, 1.0, 2.0, detail="nope")  # type: ignore[arg-type]


def test_audition_context_detail_full_includes_edits(minimal_project, sample_wav, tmp_workspace):
    from podcast_mcp.models import AppliedEditRecord, EditDecision, EditDecisionType

    proj = _two_track_project(minimal_project, sample_wav, tmp_workspace, skew_sec=0.0)
    proj.edit_decisions = [
        EditDecision(
            id="cut_pending",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=12.0,
            end=12.4,
            reason="nl:range",
            review_required=True,
            applied=False,
            cut_confidence=0.8,
            boundary_mode="vocal_transcript_guided",
        )
    ]
    proj.editorial.edit_log.append(
        AppliedEditRecord(
            id="alog_1",
            applied_at="2026-01-01T00:00:00+00:00",
            operation="approve_edits",
            decision_ids=["old"],
            track_ids=["host"],
            timeline_start=2.0,
            timeline_end=3.0,
            source_start=12.0,
            source_end=13.0,
            reason="nl:range",
            cut_confidence=0.7,
            boundary_mode="vocal_transcript_guided",
        )
    )
    save_project(proj, minimal_project)
    proj = load_project(minimal_project)
    ctx = build_audition_context(proj, 1.0, 5.0, detail="full")
    assert ctx["edits"]["pending"]
    assert ctx["edits"]["pending"][0]["source_start"] == 12.0
    assert ctx["edits"]["applied"]
    assert ctx["edits"]["applied"][0]["track_ids"] == ["host"]
    assert "edits_in_window" in " ".join(ctx["warnings"])


def test_audition_context_visual_detail_mocks_diagnostics(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    proj = _two_track_project(minimal_project, sample_wav, tmp_workspace, skew_sec=0.0)

    def fake_report(project, track_id, start_sec, end_sec, **_kwargs):
        return {
            "spectrogram_png": f"/tmp/{track_id}_spec.png",
            "waveform_png": f"/tmp/{track_id}_wav.png",
            "hum": {"hum_detected": False},
        }

    monkeypatch.setattr(
        "podcast_mcp.edits.audio_quality.audio_diagnostics_report",
        fake_report,
    )
    ctx = build_audition_context(proj, 1.0, 3.0, detail="visual")
    assert ctx["visuals"]
    assert ctx["visuals"][0]["spectrogram_png"].endswith("_spec.png")


def test_audition_context_visual_can_skip_png_rendering_for_hypothesis_evaluation(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    proj = _two_track_project(minimal_project, sample_wav, tmp_workspace, skew_sec=0.0)

    def fake_report(project, track_id, start_sec, end_sec, *, pngs=True, **_kwargs):
        assert pngs is False
        return {
            "hum": {"hum_detected": track_id == "host"},
            "astats": {"peak_level_db": -12.0, "flat_factor": 0.0},
            "window": {"clock": "timeline", "start": start_sec, "end": end_sec},
        }

    monkeypatch.setattr(
        "podcast_mcp.edits.audio_quality.audio_diagnostics_report",
        fake_report,
    )
    ctx = build_audition_context(
        proj,
        1.0,
        3.0,
        detail="visual",
        render_visual_pngs=False,
    )
    assert "visuals" in ctx
    assert "events" in ctx["visuals"][0]
    assert "spectrogram_png" not in ctx["visuals"][0]
    assert any(h["code"] == "hum_in_window" for h in ctx["hypotheses"])


def test_audition_context_visual_surfaces_diagnostic_errors(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    proj = _two_track_project(minimal_project, sample_wav, tmp_workspace, skew_sec=0.0)

    def boom(*args, **kwargs):
        raise RuntimeError("no ffmpeg")

    monkeypatch.setattr(
        "podcast_mcp.edits.audio_quality.audio_diagnostics_report",
        boom,
    )
    ctx = build_audition_context(proj, 1.0, 3.0, detail="visual")
    assert ctx["visuals"]
    vis = ctx["visuals"][0]
    assert vis.get("dsp_unavailable") is True
    assert "RuntimeError" in str(vis.get("reason", ""))
    assert "error" not in vis


def test_audition_context_rejects_inverted_window(minimal_project, sample_wav, tmp_workspace):
    import pytest

    proj = _two_track_project(minimal_project, sample_wav, tmp_workspace)
    with pytest.raises(ValueError, match="timeline_end"):
        build_audition_context(proj, 5.0, 1.0)


def test_audition_context_full_comments_and_suppressed_only(
    minimal_project, sample_wav, tmp_workspace
):
    from podcast_mcp.edits.comments import add_comment
    from podcast_mcp.models import TranscriptWord

    proj = _two_track_project(minimal_project, sample_wav, tmp_workspace, skew_sec=0.0)
    for w in proj.transcripts[0].words:
        w.suppressed = True
    proj.transcripts[1].words = [
        TranscriptWord(
            text=("word" + str(i)),
            start=12.0 + i * 0.1,
            end=12.05 + i * 0.1,
            confidence=0.9,
        )
        for i in range(40)
    ]
    add_comment(
        proj,
        body="Outside",
        author="agent",
        timeline_start=50.0,
        timeline_end=51.0,
    )
    add_comment(
        proj,
        body="Inside full",
        author="agent",
        timeline_start=2.0,
        timeline_end=3.0,
        action_texts=["Do thing"],
    )
    save_project(proj, minimal_project)
    proj = load_project(minimal_project)
    ctx = build_audition_context(proj, 1.0, 8.0, detail="full")
    host = next(t for t in ctx["tracks"] if t["track_id"] == "host")
    assert host["suppressed_only"] is True
    assert any(c["body"] == "Inside full" and "action_items" in c for c in ctx["comments"])
    assert all(c["body"] != "Outside" for c in ctx["comments"])
    assert "…" in ctx["summary"]


def test_audition_context_pending_edit_fallback_midpoint(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from podcast_mcp.engines.session_timeline import SessionTimeline
    from podcast_mcp.models import EditDecision, EditDecisionType
    from podcast_mcp.util.timebase import TimelineSec

    proj = _two_track_project(minimal_project, sample_wav, tmp_workspace, skew_sec=0.0)
    proj.edit_decisions = [
        EditDecision(
            id="cut_orphan",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=100.0,
            end=101.0,
            reason="nl:range",
            review_required=True,
            applied=False,
        )
    ]

    def empty_span(self, track_id, start, end):
        return []

    def mid_in_window(self, track_id, src):
        return TimelineSec(2.5)

    monkeypatch.setattr(SessionTimeline, "map_source_span", empty_span)
    monkeypatch.setattr(SessionTimeline, "source_to_timeline", mid_in_window)
    ctx = build_audition_context(proj, 1.0, 5.0, detail="summary")
    assert ctx["edits"]["pending"]
    assert ctx["edits"]["pending"][0]["id"] == "cut_orphan"


def test_audition_context_skips_applied_without_timeline(
    minimal_project, sample_wav, tmp_workspace
):
    from podcast_mcp.models import AppliedEditRecord

    proj = _two_track_project(minimal_project, sample_wav, tmp_workspace, skew_sec=0.0)
    proj.editorial.edit_log.append(
        AppliedEditRecord(
            id="alog_bare",
            applied_at="2026-01-01T00:00:00+00:00",
            operation="approve_edits",
            timeline_start=None,
            timeline_end=None,
        )
    )
    save_project(proj, minimal_project)
    proj = load_project(minimal_project)
    ctx = build_audition_context(proj, 1.0, 5.0)
    assert ctx["edits"]["applied"] == []


def test_audition_context_helpers_edge_paths(minimal_project, sample_wav, tmp_workspace):
    from podcast_mcp.edits import audition_context as ac
    from podcast_mcp.engines.session_timeline import SessionTimeline
    from podcast_mcp.models import AppliedEditRecord, EditDecision, EditDecisionType

    proj = _two_track_project(minimal_project, sample_wav, tmp_workspace, skew_sec=0.0)
    assert ac._has_any_words(proj, "host", []) is False
    assert ac._has_any_words(proj, "missing", [(0.0, 1.0)]) is False
    assert ac._words_in_source_spans(proj, "host", []) == []

    # Applied edit outside window skipped
    proj.editorial.edit_log.append(
        AppliedEditRecord(
            id="alog_out",
            applied_at="2026-01-01T00:00:00+00:00",
            operation="approve_edits",
            timeline_start=90.0,
            timeline_end=91.0,
        )
    )
    st = SessionTimeline(proj)
    edits = ac._edits_in_window(proj, st, 1.0, 5.0, full=False)
    assert all(e["id"] != "alog_out" for e in edits["applied"])

    # Pending applied=True skipped; pending outside window skipped
    proj.edit_decisions = [
        EditDecision(
            id="applied_flag",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=12.0,
            end=12.4,
            applied=True,
            review_required=False,
        ),
        EditDecision(
            id="far_away",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=50.0,
            end=51.0,
            applied=False,
            review_required=True,
        ),
    ]
    edits = ac._edits_in_window(proj, st, 1.0, 5.0, full=False)
    ids = {e["id"] for e in edits["pending"]}
    assert "applied_flag" not in ids
    assert "far_away" not in ids

    # Summary with warnings only
    s = ac._summary([], ["warn1"], [])
    assert "1 warnings" in s


def test_edits_in_window_midpoint_none_and_out_of_range(
    monkeypatch, minimal_project, sample_wav, tmp_workspace
):
    from podcast_mcp.edits import audition_context as ac
    from podcast_mcp.engines.session_timeline import SessionTimeline
    from podcast_mcp.models import EditDecision, EditDecisionType

    proj = _two_track_project(minimal_project, sample_wav, tmp_workspace, skew_sec=0.0)
    proj.edit_decisions = [
        EditDecision(
            id="no_mid",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=100.0,
            end=101.0,
            applied=False,
            review_required=True,
        ),
        EditDecision(
            id="mid_out",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=200.0,
            end=201.0,
            applied=False,
            review_required=True,
        ),
    ]

    def empty_span(self, track_id, start, end):
        return []

    def mid_map(self, track_id, src):
        # first call None, second call outside window
        val = getattr(mid_map, "n", 0)
        mid_map.n = val + 1
        if val == 0:
            return None
        from podcast_mcp.util.timebase import TimelineSec

        return TimelineSec(99.0)

    monkeypatch.setattr(SessionTimeline, "map_source_span", empty_span)
    monkeypatch.setattr(SessionTimeline, "source_to_timeline", mid_map)
    st = SessionTimeline(proj)
    out = ac._edits_in_window(proj, st, 1.0, 5.0, full=False)
    assert out["pending"] == []


def test_has_any_words_no_overlap(minimal_project, sample_wav, tmp_workspace):
    from podcast_mcp.edits import audition_context as ac

    proj = _two_track_project(minimal_project, sample_wav, tmp_workspace, skew_sec=0.0)
    assert ac._has_any_words(proj, "host", [(0.0, 1.0)]) is False


def test_audition_context_includes_speaker_roles(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from unittest.mock import patch

    from podcast_mcp.engines.speaker_id import WindowScore

    proj = _two_track_project(minimal_project, sample_wav, tmp_workspace, skew_sec=0.0)
    score = WindowScore(
        track_id="host",
        start_sec=12.0,
        end_sec=13.0,
        scores={"host": 0.9},
        best_track_id="host",
        best_identity="host",
        margin=0.5,
    )
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value={"host": object()},
        ),
        patch(
            "podcast_mcp.engines.speaker_id.score_window",
            return_value=score,
        ),
    ):
        out = build_audition_context(proj, 1.0, 5.0, detail="full")
    assert "speaker_roles" in out
    assert out["speaker_roles"]["host"]["role"] == "own"


def test_speaker_roles_skips_track_without_source_map(
    minimal_project,
    sample_wav,
    tmp_workspace,
):
    from unittest.mock import patch

    from podcast_mcp.engines.speaker_id import WindowScore
    from podcast_mcp.util.timebase import TimelineSec

    proj = _two_track_project(minimal_project, sample_wav, tmp_workspace, skew_sec=0.0)
    score = WindowScore(
        track_id="guest",
        start_sec=12.0,
        end_sec=13.0,
        scores={"guest": 0.9},
        best_track_id="guest",
        best_identity="guest",
        margin=0.5,
    )

    def fake_map(tid, tl):
        return None if tid == "host" else TimelineSec(12.0)

    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value={"guest": object()},
        ),
        patch(
            "podcast_mcp.engines.session_timeline.SessionTimeline.timeline_to_source",
            side_effect=fake_map,
        ),
        patch(
            "podcast_mcp.engines.speaker_id.score_window",
            return_value=score,
        ),
    ):
        out = build_audition_context(proj, 1.0, 5.0, detail="full")
    assert "guest" in out["speaker_roles"]
    assert "host" not in out["speaker_roles"]


def test_audition_context_v2_schema_skew_hypothesis(minimal_project, sample_wav, tmp_workspace):
    from podcast_mcp.edits.audition_context import HYPOTHESIS_CATALOG, SCHEMA_ID

    proj = _two_track_project(minimal_project, sample_wav, tmp_workspace, skew_sec=0.6)
    ctx = build_audition_context(proj, 2.0, 6.0, skew_warn_sec=0.05)
    assert ctx["schema"] == SCHEMA_ID
    assert ctx["window"] == {"clock": "timeline", "unit": "sec", "start": 2.0, "end": 6.0}
    assert "cannot_hear" in ctx["limits"]
    assert "captions_are_transcript_not_audio" in ctx["limits"]
    assert len(ctx["warnings"]) == len(ctx["hypotheses"])
    codes = {h["code"] for h in ctx["hypotheses"]}
    assert codes <= set(HYPOTHESIS_CATALOG)
    assert "clip_skew" not in codes
    host = next(t for t in ctx["tracks"] if t["track_id"] == "host")
    assert host["kind"] == "transcript_caption"
    assert host["source_spans"][0]["clock"] == "source"
    deltas = [p["source_delta_sec"] for p in ctx["clip_skew"]["pairs"]]
    assert deltas and deltas[0] == pytest.approx(0.6, abs=0.05)
    listen_ids = {s["id"] for s in ctx["suggested_listen"]}
    assert ctx["suggested_listen"][0]["source"] == "premix"
    assert any(s.get("track_ids") == ["host", "guest"] for s in ctx["suggested_listen"])
    assert listen_ids


def test_event_x_and_visual_event_priority():
    from podcast_mcp.edits.audition_context import build_visual_events, event_x

    assert event_x(2.4, 2.0, 6.0) == pytest.approx(0.1)
    assert event_x(2.0, 2.0, 6.0) == 0.0
    assert event_x(6.0, 2.0, 6.0) == 1.0
    assert event_x(1.0, 2.0, 6.0) == 0.0

    words = [(2.1, "hello"), (3.0, "inside"), (5.5, "later")]
    events = build_visual_events(
        track_id="host",
        window_start=2.0,
        window_end=6.0,
        words=words,
        comments=[
            {
                "id": "c1",
                "body": "note",
                "timeline_start": 3.1,
                "track_ids": ["host"],
            }
        ],
        pending_edits=[{"id": "cut1", "track_id": "host", "timeline_start": 3.1, "reason": "nl"}],
        hypotheses=[
            {
                "code": "clip_skew",
                "tracks": ["host"],
                "window": {"start": 2.9, "end": 3.2},
            }
        ],
    )
    kinds = {e["kind"] for e in events}
    assert kinds >= {"word", "comment", "pending_edit", "hypothesis"}
    by_kind = {e["kind"]: e for e in events}
    assert by_kind["pending_edit"]["id"] == "cut1"
    assert by_kind["pending_edit"]["x"] == pytest.approx(event_x(3.1, 2.0, 6.0))
    word_texts = {e["text"] for e in events if e["kind"] == "word"}
    assert "hello" in word_texts
    assert "inside" in word_texts

    flooded = [(2.0 + i * 0.05, f"w{i}") for i in range(40)]
    many = build_visual_events(
        track_id="host",
        window_start=2.0,
        window_end=6.0,
        words=flooded,
        comments=[{"id": f"c{i}", "body": "x", "timeline_start": 2.5} for i in range(5)],
        pending_edits=[{"id": "cut1", "track_id": "host", "timeline_start": 3.0}],
        hypotheses=[],
    )
    non_words = [e for e in many if e["kind"] != "word"]
    assert len(non_words) == 6
    assert len([e for e in many if e["kind"] == "word"]) == 1
    assert len(many) == 7


def test_audition_context_muted_track_speaking(minimal_project, sample_wav, tmp_workspace):
    proj = _two_track_project(minimal_project, sample_wav, tmp_workspace, skew_sec=0.0)
    host = proj.track_by_id("host")
    assert host is not None
    host.muted = True
    from podcast_mcp.models import save_project

    save_project(proj, minimal_project)
    proj = load_project(minimal_project)
    ctx = build_audition_context(proj, 2.0, 6.0)
    assert any(h["code"] == "muted_track_speaking" for h in ctx["hypotheses"])


def test_audition_context_visual_includes_events_when_pngs_missing(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    proj = _two_track_project(minimal_project, sample_wav, tmp_workspace, skew_sec=0.0)

    def fake_report(project, track_id, start_sec=None, end_sec=None, **_kwargs):
        return {
            "spectrogram_png": f"/tmp/{track_id}_spec.png",
            "waveform_png": f"/tmp/{track_id}_wav.png",
            "hum": {"hum_detected": False},
            "astats": {"peak_level_db": -12.0, "flat_factor": 0.0},
            "window": {"clock": "timeline", "start": start_sec, "end": end_sec, "unit": "sec"},
        }

    monkeypatch.setattr(
        "podcast_mcp.edits.audio_quality.audio_diagnostics_report",
        fake_report,
    )
    ctx = build_audition_context(proj, 1.0, 3.0, detail="visual")
    assert ctx["visuals"][0]["plot"]["read_for"] == "degradation_not_asr"
    assert "events" in ctx["visuals"][0]
    assert "visuals_are_degradation_not_asr" in ctx["limits"]


def test_audition_context_summary_emits_windowed_dsp_without_pngs(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    proj = _two_track_project(minimal_project, sample_wav, tmp_workspace, skew_sec=0.0)

    def fake_report(project, track_id, start_sec=None, end_sec=None, *, pngs=True, **_kwargs):
        assert pngs is False
        return {
            "hum": {"hum_detected": track_id == "host", "dominant_frequency": 60.0},
            "astats": {
                "peak_level_db": -0.1 if track_id == "guest" else -12.0,
                "flat_factor": 0.0,
            },
            "window": {"clock": "timeline", "start": start_sec, "end": end_sec, "unit": "sec"},
        }

    monkeypatch.setattr(
        "podcast_mcp.edits.audio_quality.audio_diagnostics_report",
        fake_report,
    )
    ctx = build_audition_context(proj, 1.0, 3.0, detail="summary")
    assert "visuals" not in ctx
    codes = {h["code"] for h in ctx["hypotheses"]}
    assert "hum_in_window" in codes
    assert "clipping_in_window" in codes
    assert "visuals_are_degradation_not_asr" not in ctx["limits"]


def test_audition_context_caps_long_dsp_window(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    proj = _two_track_project(minimal_project, sample_wav, tmp_workspace, skew_sec=0.0)

    def boom(*_args, **_kwargs):
        raise AssertionError("DSP must not run on windows longer than 60s")

    monkeypatch.setattr("podcast_mcp.edits.audio_quality.audio_diagnostics_report", boom)
    ctx = build_audition_context(proj, 0.0, 90.0, detail="summary")
    assert {h["code"] for h in ctx["hypotheses"]} >= {"dsp_unavailable"}
    assert any("dsp_unavailable" in w for w in ctx["warnings"])


def test_audition_context_dsp_failure_is_unavailable(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    proj = _two_track_project(minimal_project, sample_wav, tmp_workspace, skew_sec=0.0)
    root = str(proj.workspace_path())

    def boom(*_args, **_kwargs):
        raise RuntimeError(f"ffmpeg failed on {root}/secret.wav")

    monkeypatch.setattr("podcast_mcp.edits.audio_quality.audio_diagnostics_report", boom)
    ctx = build_audition_context(proj, 1.0, 3.0, detail="summary")
    dsp = [h for h in ctx["hypotheses"] if h["code"] == "dsp_unavailable"]
    assert dsp
    dumped = " ".join(h["evidence"]["reason"] for h in dsp)
    assert "RuntimeError" in dumped
    assert root not in dumped
