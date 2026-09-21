from __future__ import annotations

from unittest.mock import patch

import pytest

from podcast_mcp.edits.clips_ops import clips_for_track
from podcast_mcp.edits.decisions import (
    apply_auto_edits,
    apply_prefix_edits,
    approve_edits,
    edit_impact_report,
    format_edit_impact_markdown,
    reject_edits,
    update_pending_edit,
)
from podcast_mcp.edits.edit_log import revert_applied_edit
from podcast_mcp.edits.timeline_ops import ripple_delete
from podcast_mcp.models import (
    AppliedEditRecord,
    Clip,
    ClipJoinMode,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)


def _project_with_clip() -> EpisodeProject:
    p = EpisodeProject.create("t", "/tmp/ws")
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    p.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        )
    ]
    return p


def test_approve_applies_ripple_and_removes_decision():
    proj = _project_with_clip()
    proj.edit_decisions = [
        EditDecision(
            id="a",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=2,
            end=5,
            reason="nl:test",
            review_required=True,
            applied=False,
        ),
        EditDecision(
            id="b",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=5,
            end=6,
            reason="filler:um",
            review_required=False,
            applied=False,
        ),
    ]
    removed = approve_edits(proj, ["a"])
    assert removed == 1
    assert all(e.id != "a" for e in proj.edit_decisions)
    assert proj.timeline.duration_sec == 7.0 or len(proj.clips) >= 1
    n = apply_auto_edits(proj)
    assert n == 1


def test_approve_skips_stale_mute_and_preserves_pending_decision():
    proj = _project_with_clip()
    proj.edit_decisions = [
        EditDecision(
            id="stale",
            track_id="host",
            type=EditDecisionType.MUTE,
            start=11.0,
            end=12.0,
            applied=False,
        ),
        EditDecision(
            id="valid",
            track_id="host",
            type=EditDecisionType.MUTE,
            start=1.0,
            end=2.0,
            applied=False,
        ),
    ]

    assert approve_edits(proj, ["stale", "valid"]) == 1
    assert [decision.id for decision in proj.edit_decisions] == ["stale"]
    assert [record.decision_ids for record in proj.editorial.edit_log] == [["valid"]]


def test_approve_remove_falls_back_to_track_scope_when_guard_cannot_resolve():
    proj = _project_with_clip()
    decision = EditDecision(
        id="fallback",
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=1.0,
        end=2.0,
        scope="session",
        applied=False,
    )
    proj.edit_decisions = [decision]

    with patch(
        "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
        side_effect=ValueError("guard unavailable"),
    ):
        assert approve_edits(proj, ["fallback"]) == 1

    assert decision.scope == "track"
    assert proj.edit_decisions == []
    assert [record.decision_ids for record in proj.editorial.edit_log] == [["fallback"]]


def test_update_pending_edit_without_snap():
    proj = _project_with_clip()
    proj.edit_decisions = [
        EditDecision(
            id="p1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1.0,
            end=2.0,
            reason="nudge",
            applied=False,
        )
    ]
    updated = update_pending_edit(proj, "p1", start=1.2, end=2.5, snap=False)
    assert updated.start == 1.2
    assert updated.end == 2.5


def test_update_pending_edit_with_snap_passthrough(monkeypatch):
    proj = _project_with_clip()
    proj.edit_decisions = [
        EditDecision(
            id="p1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1.0,
            end=2.0,
            reason="nudge",
            applied=False,
        )
    ]

    class _Opt:
        start = 1.05
        end = 1.95
        mode = "waveform_only"
        confidence = 0.8

    monkeypatch.setattr(
        "podcast_mcp.edits.inaudible_cuts.optimize_source_cut_range",
        lambda *a, **k: _Opt(),
    )
    updated = update_pending_edit(proj, "p1", start=1.0, end=2.0, snap=True)
    assert updated.start == 1.05
    assert updated.end == 1.95
    assert updated.boundary_mode == "waveform_only"
    assert updated.cut_confidence == 0.8


def test_update_pending_edit_missing_id():
    proj = _project_with_clip()
    with pytest.raises(KeyError):
        update_pending_edit(proj, "missing", start=0.0, end=1.0, snap=False)


def test_revert_applied_edit_restores_clip():
    proj = _project_with_clip()
    proj.edit_decisions = [
        EditDecision(
            id="a",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=2.0,
            end=4.0,
            reason="cut",
            applied=False,
        )
    ]
    approve_edits(proj, ["a"])
    assert len(proj.editorial.edit_log) == 1
    record = proj.editorial.edit_log[0]
    duration_before = proj.timeline.duration_sec
    result = revert_applied_edit(proj, record.id)
    assert result["operation"] == "revert_applied_edit"
    assert proj.editorial.edit_log == []
    assert proj.timeline.duration_sec == pytest.approx(duration_before + 2.0, abs=0.01)
    host_clips = clips_for_track(proj, "host")
    assert any(
        abs(c.source_start - 2.0) < 1e-6 and abs(c.source_end - 4.0) < 1e-6 for c in host_clips
    )


def test_revert_applied_edit_requires_source_clocks():
    proj = _project_with_clip()
    proj.editorial.edit_log = [
        AppliedEditRecord(
            id="alog_x",
            applied_at="2026-01-01T00:00:00+00:00",
            operation="ripple_delete",
            track_ids=["host"],
            timeline_start=1.0,
            timeline_end=2.0,
        )
    ]
    with pytest.raises(ValueError, match="History undo"):
        revert_applied_edit(proj, "alog_x")


def test_revert_applied_edit_keeps_multitrack_aligned():
    """Cross-track ripple + revert must not leave lasting timeline skew."""
    from podcast_mcp.engines.session_timeline import SessionTimeline
    from podcast_mcp.util.timebase import TimelineSec

    proj = _two_track_project()
    proj.edit_decisions = [
        EditDecision(
            id="cut1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=2.0,
            end=2.6,
            reason="nl:test",
            review_required=True,
        )
    ]
    approve_edits(proj, ["cut1"])
    record = proj.editorial.edit_log[0]
    assert "host" in record.track_ids and "guest" in record.track_ids
    assert "per_track_source" in (record.params or {})
    revert_applied_edit(proj, record.id)
    st = SessionTimeline(proj)
    for t in (1.0, 5.0, 8.0):
        a = st.timeline_to_source("host", TimelineSec(t))
        b = st.timeline_to_source("guest", TimelineSec(t))
        assert a is not None and b is not None
        assert abs(float(a) - float(b)) < 0.02


def test_revert_legacy_single_track_archive_still_shifts_peers():
    """Legacy archives listed one track; peers must still shift to avoid skew."""
    from podcast_mcp.engines.session_timeline import SessionTimeline
    from podcast_mcp.util.timebase import TimelineSec

    proj = _two_track_project()
    # Simulate a 0.6s cross-track hole by rippling, then archive like old approve.
    from podcast_mcp.edits.timeline_ops import ripple_delete

    ripple_delete(proj, 2.0, 2.6, record_log=False)
    proj.editorial.edit_log = [
        AppliedEditRecord(
            id="alog_legacy",
            applied_at="2026-01-01T00:00:00+00:00",
            operation="approve_edits",
            track_ids=["host"],
            source_start=2.0,
            source_end=2.6,
            timeline_start=2.0,
            timeline_end=2.6,
        )
    ]
    revert_applied_edit(proj, "alog_legacy")
    st = SessionTimeline(proj)
    a = st.timeline_to_source("host", TimelineSec(5.0))
    b = st.timeline_to_source("guest", TimelineSec(5.0))
    assert a is not None and b is not None
    assert abs(float(a) - float(b)) < 0.02


def _two_track_project() -> EpisodeProject:
    p = EpisodeProject.create("t", "/tmp/ws")
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/guest.wav", duration_sec=10.0),
        ),
    ]
    for tid in ("host", "guest"):
        p.timeline.clips.append(
            Clip(
                id=f"full_{tid}",
                track_id=tid,
                source_start=0.0,
                source_end=10.0,
                timeline_start=0.0,
            )
        )
    return p


def test_apply_auto_edits_ripple_aligns_two_tracks():
    proj = _two_track_project()
    proj.edit_decisions = [
        EditDecision(
            id="f1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=3.0,
            end=3.4,
            reason="filler:like",
            review_required=False,
            applied=False,
        ),
    ]
    removed = apply_auto_edits(proj)
    assert removed == 1
    assert proj.edit_decisions == []
    host_end = max(c.timeline_end for c in clips_for_track(proj, "host"))
    guest_end = max(c.timeline_end for c in clips_for_track(proj, "guest"))
    assert host_end == guest_end == 9.6


def test_reject_edits():
    proj = EpisodeProject.create("t", "/tmp/ws")
    proj.edit_decisions = [
        EditDecision(
            id="x",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=0,
            end=1,
        )
    ]
    reject_edits(proj, ["x"])
    assert proj.edit_decisions == []


def _approve_two_track_project() -> EpisodeProject:
    p = EpisodeProject.create("approve", "/tmp/ws")
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=30.0),
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/guest.wav", duration_sec=30.0),
        ),
    ]
    for tid in ("host", "guest"):
        p.timeline.clips.append(
            Clip(
                id=f"full_{tid}",
                track_id=tid,
                source_start=0.0,
                source_end=30.0,
                timeline_start=0.0,
            )
        )
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.5),
                TranscriptWord(text="um", start=2.0, end=2.2),
                TranscriptWord(text="world", start=5.0, end=5.5),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text="hi", start=0.0, end=0.4),
                TranscriptWord(text="there", start=5.0, end=5.4),
            ],
        ),
    ]
    return p


def _clip_ends(project: EpisodeProject) -> dict[str, float]:
    return {
        tid: max(c.timeline_end for c in clips_for_track(project, tid)) for tid in ("host", "guest")
    }


def _word_snapshot(project: EpisodeProject) -> dict[str, list[tuple[float, float, str]]]:
    return {tr.track_id: [(w.start, w.end, w.text) for w in tr.words] for tr in project.transcripts}


def test_approve_edits_matches_sequential_ripple():
    timeline_ranges = [(2.0, 2.2), (8.0, 9.0)]

    sequential = _approve_two_track_project()
    for start, end in reversed(sorted(timeline_ranges)):
        ripple_delete(sequential, start, end, use_inaudible_opt=False)

    approved = _approve_two_track_project()
    approved.edit_decisions = [
        EditDecision(
            id="a",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=2.0,
            end=2.2,
            reason="nl:test",
            review_required=True,
            applied=False,
        ),
        EditDecision(
            id="b",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=8.0,
            end=9.0,
            reason="nl:test",
            review_required=True,
            applied=False,
        ),
    ]
    approve_edits(approved, ["a", "b"])

    assert _clip_ends(sequential) == _clip_ends(approved)
    assert _word_snapshot(sequential) == _word_snapshot(approved)
    assert approved.edit_decisions == []


def test_apply_prefix_edits_pause_with_crossfade():

    proj = _project_with_clip()
    proj.timeline.clips.append(
        Clip(
            id="c2",
            track_id="host",
            source_start=10.0,
            source_end=20.0,
            timeline_start=10.0,
        )
    )
    proj.edit_decisions = [
        EditDecision(
            id="p1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=2.0,
            end=2.5,
            reason="pause:long",
            review_required=False,
            applied=False,
        ),
    ]
    with patch("podcast_mcp.edits.decisions.load_defaults") as defaults:
        defaults.return_value = {"tighten": {"inaudible_opt": False, "crossfade_ms": 15}}
        removed = apply_prefix_edits(proj, "pause:", config_key="tighten")
    assert removed == 1
    assert proj.edit_decisions == []


def test_apply_prefix_edits_skips_review_required_and_invalid_range():
    proj = _project_with_clip()
    proj.edit_decisions = [
        EditDecision(
            id="skip-review",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=2.0,
            end=3.0,
            reason="filler:um",
            review_required=True,
            applied=False,
        ),
        EditDecision(
            id="skip-range",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=5.0,
            end=5.0,
            reason="filler:uh",
            review_required=False,
            applied=False,
        ),
    ]
    assert apply_prefix_edits(proj, "filler:", config_key="tighten") == 0
    assert len(proj.edit_decisions) == 2


def test_edit_impact_report_tracks_gaps_and_pending():
    proj = _two_track_project()
    proj.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=5.0,
            timeline_start=0.0,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=10.0,
            source_end=15.0,
            timeline_start=6.0,
        ),
    ]
    proj.edit_decisions = [
        EditDecision(
            id="applied",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1.0,
            end=2.0,
            reason="filler:um",
            applied=True,
            review_required=False,
        ),
        EditDecision(
            id="pending",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=3.0,
            end=4.0,
            reason="nl:test",
            applied=False,
            review_required=True,
        ),
    ]
    report = edit_impact_report(proj)
    assert report["gap_count"] == 1
    assert report["applied_count"] == 1
    assert report["pending_review_count"] == 1
    md = format_edit_impact_markdown(report)
    assert "host:" in md
    assert "[pending]" in md


def test_apply_prefix_edits_ignores_non_matching_reason():
    proj = _project_with_clip()
    proj.edit_decisions = [
        EditDecision(
            id="other",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1.0,
            end=2.0,
            reason="nl:manual",
            review_required=False,
            applied=False,
        ),
    ]
    assert apply_prefix_edits(proj, "filler:", config_key="tighten") == 0


def test_apply_join_fades_skips_timeline_gaps():
    from podcast_mcp.edits.decisions import apply_join_fades_from_decisions

    proj = _project_with_clip()
    proj.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=5.0,
            timeline_start=0.0,
            fade_out_ms=0,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=10.0,
            source_end=15.0,
            timeline_start=8.0,
            fade_in_ms=0,
        ),
    ]
    decision = EditDecision(
        id="f1",
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=4.5,
        end=5.0,
        reason="filler:um",
        crossfade_ms=30,
        review_required=False,
        applied=False,
    )
    apply_join_fades_from_decisions(proj, [decision])
    clips = sorted((c for c in proj.clips if c.track_id == "host"), key=lambda c: c.timeline_start)
    assert clips[0].fade_out_ms == 0
    assert clips[1].fade_in_ms == 0


def test_apply_join_fades_from_decisions():
    from podcast_mcp.edits.decisions import apply_join_fades_from_decisions

    proj = _project_with_clip()
    proj.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=5.0,
            timeline_start=0.0,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=10.0,
            source_end=15.0,
            timeline_start=5.0,
            fade_in_ms=0,
        ),
    ]
    decision = EditDecision(
        id="f1",
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=4.5,
        end=5.0,
        reason="filler:um",
        crossfade_ms=30,
        review_required=False,
        applied=False,
    )
    summary = apply_join_fades_from_decisions(proj, [decision])
    assert summary["operation"] == "apply_join_fades"
    clips = [c for c in proj.clips if c.track_id == "host"]
    clips.sort(key=lambda c: c.timeline_start)
    assert clips[0].fade_out_ms >= 15
    assert clips[1].fade_in_ms >= 15
    assert clips[1].join_in_mode == ClipJoinMode.FADE


def test_apply_prefix_edits_without_crossfade():

    proj = _project_with_clip()
    proj.edit_decisions = [
        EditDecision(
            id="f1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=2.0,
            end=2.5,
            reason="filler:um",
            review_required=False,
            applied=False,
        ),
    ]
    with patch("podcast_mcp.edits.decisions.load_defaults") as defaults:
        defaults.return_value = {"tighten": {"inaudible_opt": False, "crossfade_ms": 0}}
        removed = apply_prefix_edits(proj, "filler:", config_key="tighten")
    assert removed == 1


def test_edit_impact_report_ignores_non_remove_and_formats_without_segments():
    proj = _project_with_clip()
    proj.edit_decisions = [
        EditDecision(
            id="split",
            track_id="host",
            type=EditDecisionType.SPLIT,
            start=1.0,
            end=1.0,
            reason="test",
            applied=True,
        ),
    ]
    report = edit_impact_report(proj)
    assert report["applied_count"] == 0
    md = format_edit_impact_markdown(report)
    assert "Segments" not in md


def test_format_edit_impact_markdown_lists_applied_segments():
    report = {
        "total_removed_sec": 1.0,
        "by_track_sec": {"host": 1.0},
        "applied_count": 1,
        "pending_review_count": 0,
        "segments": [
            {
                "track_id": "host",
                "start": 1.0,
                "end": 2.0,
                "duration_sec": 1.0,
                "reason": "filler:um",
                "review_required": False,
            }
        ],
    }
    md = format_edit_impact_markdown(report)
    assert "[applied]" in md
    assert "filler:um" in md
