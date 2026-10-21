from __future__ import annotations

from unittest.mock import patch

import pytest

from pause_policy_public_helpers import room, voice, write_wav
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.clips_ops import clips_for_track, update_timeline_duration
from podcast_mcp.edits.cut_application import apply_auto_edits, apply_prefix_edits, approve_edits
from podcast_mcp.edits.decisions import (
    edit_impact_report,
    format_edit_impact_markdown,
    reject_edits,
    retire_unplayed_pending,
    unplayed_pending_ids,
    update_pending_edit,
)
from podcast_mcp.edits.edit_log import revert_applied_edit
from podcast_mcp.edits.range_edits import build_range_target, edit_selected_range
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.edits.timeline_ops import (
    _write_punch_delete,
    _write_punch_delete_clips,
    _write_ripple_delete_clips,
    plan_delete_clips,
    split_clips_at,
)
from podcast_mcp.models import (
    AppliedEditRecord,
    Clip,
    ClipJoinMode,
    CutIntent,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    save_project,
)
from podcast_mcp.models.episode import RangeInterval
from podcast_mcp.project.history.manager import snapshot_from_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService, HistoryService
from podcast_mcp.util.coded_error import CodedValueError
from ripple_helpers import ripple_cut, trim


def _write_quiet_media(project, *, silence_spans=()):
    for track in project.tracks:
        if track.media is None:
            continue
        samples = room(seconds=track.media.duration_sec)
        voice(samples, 0, 0.8)
        voice(samples, 9.2, 9.8)
        samples[16000:144000] = 0
        for start, end in silence_spans:
            samples[round(start * 16000) : round(end * 16000)] = 0
        write_wav(project.workspace_path() / track.media.path, samples)


def _project_with_clip(tmp_path) -> EpisodeProject:
    p = EpisodeProject.create("t", str(tmp_path))
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
    _write_quiet_media(p)
    return p


def test_approve_applies_ripple_and_removes_decision(tmp_path):
    proj = _project_with_clip(tmp_path)
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
    removed = approve_edits(proj, ["a"], defaults=load_defaults())
    assert removed == 1
    assert all(e.id != "a" for e in proj.edit_decisions)
    assert proj.timeline.duration_sec == 7.0 or len(proj.clips) >= 1
    n = apply_auto_edits(proj, defaults=load_defaults())
    assert n == 1


def test_approve_refuses_a_batch_naming_a_stale_mute_and_applies_nothing(tmp_path):
    proj = _project_with_clip(tmp_path)
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

    with pytest.raises(CodedValueError) as refused:
        approve_edits(proj, ["stale", "valid"], defaults=load_defaults())
    assert refused.value.code == "edit_span_not_played"
    assert "stale" in str(refused.value) and "valid" not in str(refused.value).split("(")[1]
    assert [decision.id for decision in proj.edit_decisions] == ["stale", "valid"]
    assert proj.editorial.edit_log == []


def test_approve_refuses_unmapped_remove_without_archiving_it(tmp_path):
    proj = _project_with_clip(tmp_path)
    original_clips = [clip.model_dump() for clip in proj.clips]
    proj.edit_decisions = [
        EditDecision(
            id="stale-remove",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=11.0,
            end=12.0,
            applied=False,
        )
    ]

    with pytest.raises(CodedValueError) as refused:
        approve_edits(proj, ["stale-remove"], defaults=load_defaults())
    assert refused.value.code == "edit_span_not_played"
    assert [clip.model_dump() for clip in proj.clips] == original_clips
    assert [decision.id for decision in proj.edit_decisions] == ["stale-remove"]
    assert proj.editorial.edit_log == []


def test_approve_remove_is_held_when_guard_cannot_resolve(tmp_path):
    proj = _project_with_clip(tmp_path)
    decision = EditDecision(
        id="fallback",
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=1.0,
        end=2.0,
        scope="session",
        applied=False,
    )
    mute = EditDecision(
        id="accepted-mute",
        track_id="host",
        type=EditDecisionType.MUTE,
        start=3.0,
        end=3.2,
        boundary_intent=CutIntent.HUMAN_BOUNDARIES,
        applied=False,
    )
    proj.edit_decisions = [mute, decision]
    before = proj.model_dump(mode="json")

    with (
        patch(
            "podcast_mcp.edits.cut_safety.assess_cross_track_speech",
            side_effect=ValueError("guard unavailable"),
        ),
        pytest.raises(ScopeChangedAtApproval, match="could not be checked") as held,
    ):
        approve_edits(proj, ["accepted-mute", "fallback"], defaults=load_defaults())

    assert held.value.ids == ("fallback",)
    assert decision.scope == "session"
    assert proj.model_dump(mode="json") == before
    assert proj.edit_decisions == [mute, decision]
    assert proj.editorial.edit_log == []


def test_update_pending_edit_without_snap(tmp_path):
    proj = _project_with_clip(tmp_path)
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
    updated = update_pending_edit(
        proj, "p1", start=1.2, end=2.5, snap=False, defaults=load_defaults()
    )
    assert updated.start == 1.2
    assert updated.end == 2.5


def test_manual_pending_edit_range_clears_optimizer_assessment(tmp_path):
    proj = _project_with_clip(tmp_path)
    proj.edit_decisions = [
        EditDecision(
            id="p1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1.0,
            end=2.0,
            boundary_mode="waveform_only",
            cut_confidence=0.8,
            reason="nudge",
            applied=False,
        )
    ]
    updated = update_pending_edit(
        proj, "p1", start=1.2, end=2.5, snap=False, defaults=load_defaults()
    )
    assert (updated.start, updated.end) == (1.2, 2.5)
    assert updated.boundary_mode is None
    assert updated.cut_confidence is None


def test_update_pending_edit_with_snap_passthrough(tmp_path, monkeypatch):
    proj = _project_with_clip(tmp_path)
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
        "podcast_mcp.edits.decisions.optimize_source_cut_range",
        lambda *a, **k: _Opt(),
    )
    updated = update_pending_edit(
        proj, "p1", start=1.0, end=2.0, snap=True, defaults=load_defaults()
    )
    assert updated.start == 1.05
    assert updated.end == 1.95
    assert updated.boundary_mode == "waveform_only"
    assert updated.cut_confidence == 0.8


def test_update_pending_edit_missing_id(tmp_path):
    proj = _project_with_clip(tmp_path)
    with pytest.raises(KeyError):
        update_pending_edit(
            proj, "missing", start=0.0, end=1.0, snap=False, defaults=load_defaults()
        )


def _saved_restore_workspace(project, tmp_path):
    project.meta.workspace_dir = str(tmp_path)
    _write_quiet_media(project)
    update_timeline_duration(project)
    return ProjectWorkspace.open(save_project(project))


def _assert_remove_restore_refused(project, record_id):
    before = project.model_dump(mode="json")
    with pytest.raises(ValueError) as refused:
        revert_applied_edit(project, record_id, defaults=load_defaults())
    assert getattr(refused.value, "code", None) == "local_restore_requires_history"
    assert str(refused.value) == (
        "This edit cannot be restored individually. Use History Undo to restore the whole action. "
        "History Undo also undoes the other edits in that action. "
        "You may need to undo later actions first."
    )
    assert project.model_dump(mode="json") == before


def _refuse_restore_then_undo(ws, original):
    before = ws.project.model_dump(mode="json")
    disk = ws.path.read_bytes()
    head = HistoryService(ws).status()["head_id"]
    with pytest.raises(ValueError) as refused:
        EditService(ws).revert_applied(ws.project.editorial.edit_log[-1].id)
    assert getattr(refused.value, "code", None) == "local_restore_requires_history"
    assert str(refused.value) == (
        "This edit cannot be restored individually. Use History Undo to restore the whole action. "
        "History Undo also undoes the other edits in that action. "
        "You may need to undo later actions first."
    )
    assert ws.project.model_dump(mode="json") == before
    assert ws.path.read_bytes() == disk
    assert HistoryService(ws).status()["head_id"] == head
    HistoryService(ws).undo(expected_head_id=head)
    assert snapshot_from_project(ws.project).model_dump(mode="json") == original


def test_remove_restore_refuses_and_history_undo_restores_clip(tmp_path):
    proj = _project_with_clip(tmp_path)
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
    ws = _saved_restore_workspace(proj, tmp_path)
    original = snapshot_from_project(ws.project).model_dump(mode="json")
    assert EditService(ws).approve(["a"]) == 1
    assert [(c.source_start, c.source_end) for c in ws.project.clips] == [(0, 2), (4, 10)]
    _refuse_restore_then_undo(ws, original)
    assert [(c.id, c.source_start, c.source_end, c.timeline_start) for c in ws.project.clips] == [
        ("c1", 0, 10, 0)
    ]


def test_remove_restore_requires_history_without_source_clocks(tmp_path):
    proj = _project_with_clip(tmp_path)
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
    _assert_remove_restore_refused(proj, "alog_x")


def test_remove_restore_refuses_and_history_undo_keeps_multitrack_aligned(tmp_path):
    proj = _two_track_project(tmp_path)
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
    ws = _saved_restore_workspace(proj, tmp_path)
    original = snapshot_from_project(ws.project).model_dump(mode="json")
    assert EditService(ws).approve(["cut1"]) == 1
    record = ws.project.editorial.edit_log[0]
    assert record.track_ids == ["host", "guest"]
    assert "per_track_source" in record.params
    _refuse_restore_then_undo(ws, original)
    assert [
        (c.track_id, c.source_start, c.source_end, c.timeline_start) for c in ws.project.clips
    ] == [("host", 0, 10, 0), ("guest", 0, 10, 0)]


def test_single_track_archive_cannot_authorize_peer_clip_restore(tmp_path):
    proj = _two_track_project(tmp_path)
    ripple_cut(proj, 2.0, 2.6, record_log=False)
    proj.editorial.edit_log = [
        AppliedEditRecord(
            id="alog_single",
            applied_at="2026-01-01T00:00:00+00:00",
            operation="approve_edits",
            track_ids=["host"],
            source_start=2.0,
            source_end=2.6,
            timeline_start=2.0,
            timeline_end=2.6,
        )
    ]
    _assert_remove_restore_refused(proj, "alog_single")


def _two_track_project(tmp_path) -> EpisodeProject:
    p = EpisodeProject.create("t", str(tmp_path))
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
    _write_quiet_media(p)
    return p


def test_approve_split_records_split_source_by_track(tmp_path):
    proj = _two_track_project(tmp_path)
    proj.edit_decisions = [
        EditDecision(
            id="s1",
            track_id="host",
            type=EditDecisionType.SPLIT,
            start=4.0,
            end=4.0,
            track_ids=["host", "guest"],
            reason="blade",
        )
    ]
    approve_edits(proj, ["s1"], defaults=load_defaults())
    from podcast_mcp.edits.edit_log import list_applied_edits

    records = list_applied_edits(proj)
    record = next(r for r in records if r.operation == "approve_split")
    assert record.params["split_source_by_track"] == {
        "host": pytest.approx(4.0),
        "guest": pytest.approx(4.0),
    }


def test_apply_auto_edits_ripple_aligns_two_tracks(tmp_path):
    proj = _two_track_project(tmp_path)
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
    removed = apply_auto_edits(proj, defaults=load_defaults())
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


def _approve_two_track_project(tmp_path) -> EpisodeProject:
    p = EpisodeProject.create("approve", str(tmp_path))
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
    _write_quiet_media(p)
    return p


def _clip_ends(project: EpisodeProject) -> dict[str, float]:
    return {
        tid: max(c.timeline_end for c in clips_for_track(project, tid)) for tid in ("host", "guest")
    }


def _word_snapshot(project: EpisodeProject) -> dict[str, list[tuple[float, float, str]]]:
    return {tr.track_id: [(w.start, w.end, w.text) for w in tr.words] for tr in project.transcripts}


def test_approve_edits_matches_sequential_ripple(tmp_path):
    timeline_ranges = [(2.0, 2.2), (8.0, 9.0)]

    sequential = _approve_two_track_project(tmp_path)
    _write_quiet_media(sequential, silence_spans=[(7.0, 10.0)])
    for start, end in reversed(sorted(timeline_ranges)):
        ripple_cut(sequential, start, end, use_inaudible_opt=False)

    approved = _approve_two_track_project(tmp_path)
    _write_quiet_media(approved, silence_spans=[(7.0, 10.0)])
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
    approve_edits(approved, ["a", "b"], defaults=load_defaults())

    assert _clip_ends(sequential) == _clip_ends(approved)
    assert _word_snapshot(sequential) == _word_snapshot(approved)
    assert approved.edit_decisions == []


def test_apply_prefix_edits_filler_with_crossfade(tmp_path):

    proj = _project_with_clip(tmp_path)
    proj.tracks[0].media.duration_sec = 20
    _write_quiet_media(proj)
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
            reason="filler:long",
            crossfade_ms=30,
            review_required=False,
            applied=False,
        ),
    ]
    removed = apply_prefix_edits(
        proj,
        "filler:",
        config_key="tighten",
        defaults={"tighten": {"inaudible_opt": False, "crossfade_ms": 30}},
    )
    assert removed == 1
    assert proj.edit_decisions == []
    assert proj.editorial.edit_log[-1].params["crossfade_ms"] == 30

    clips = sorted(proj.clips, key=lambda clip: clip.timeline_start)
    assert clips[0].fade_out_ms >= 15
    assert clips[1].fade_in_ms >= 15
    assert clips[1].join_in_mode is ClipJoinMode.FADE


@pytest.mark.parametrize("boundary_mode", [None, "vocal_transcript_guided"])
@pytest.mark.parametrize("config_key,prefix", [("tighten", "filler:"), ("focus", "focus:")])
def test_apply_prefix_edits_archives_the_settled_cut_range(
    tmp_path, boundary_mode, config_key, prefix
):
    proj = _project_with_clip(tmp_path)
    proj.edit_decisions = [
        EditDecision(
            id="p1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=2.0,
            end=2.5,
            reason=f"{prefix}long",
            boundary_mode=boundary_mode,
            review_required=False,
            applied=False,
        )
    ]
    ws = _saved_restore_workspace(proj, tmp_path)
    proj = ws.project
    original = snapshot_from_project(proj).model_dump(mode="json")
    optimized = type("R", (), {"start": 2.0, "end": 2.56, "mode": "vocal_transcript_guided"})()
    with (
        patch(
            "podcast_mcp.edits.timeline_ops.optimize_timeline_cut_range",
            side_effect=lambda project, track, start, end, force_enabled: (
                optimized if force_enabled else type("R", (), {"start": start, "end": end})()
            ),
        ) as optimize,
    ):
        cfg = {config_key: {"inaudible_opt": True}}
        assert (
            ws.mutate(
                "before apply prefix",
                "after apply prefix",
                lambda p: apply_prefix_edits(p, prefix, config_key=config_key, defaults=cfg),
            )
            == 1
        )
    optimize.assert_not_called()
    record = proj.editorial.edit_log[-1]
    assert record.timeline_start == pytest.approx(2.0)
    assert record.timeline_end == pytest.approx(2.5)
    pre, post = record.params["per_track_source"]["host"]
    assert post - pre == pytest.approx(record.timeline_end - record.timeline_start)
    _refuse_restore_then_undo(ws, original)
    assert proj.timeline.duration_sec == pytest.approx(10.0)


def test_apply_prefix_edits_pads_at_the_held_join(tmp_path):
    """Application pads the finalized join even when an optimizer would suggest another."""
    proj = _project_with_clip(tmp_path)
    proj.edit_decisions = [
        EditDecision(
            id="p1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=2.0,
            end=2.5,
            reason="filler:long",
            review_required=False,
            applied=False,
            replace_gap_sec=0.3,
        )
    ]
    optimized = type("R", (), {"start": 1.7, "end": 2.5, "mode": "vocal_transcript_guided"})()
    with (
        patch("podcast_mcp.edits.cut_application.filler_pad_mode", return_value="silence"),
        patch("podcast_mcp.edits.cut_application.recommend_post_pad_fade_in_ms", return_value=0),
        patch(
            "podcast_mcp.edits.timeline_ops.optimize_timeline_cut_range",
            return_value=optimized,
        ),
    ):
        cfg = {"tighten": {"inaudible_opt": True}}
        assert apply_prefix_edits(proj, "filler:", config_key="tighten", defaults=cfg) == 1
    host = clips_for_track(proj, "host")
    assert len(host) == 2
    assert host[0].timeline_end == pytest.approx(2.0)
    assert host[1].timeline_start == pytest.approx(2.0 + 0.3)
    assert host[1].source_start == pytest.approx(2.5)
    assert proj.editorial.edit_log[-1].timeline_start == pytest.approx(2.0)


def test_apply_prefix_edits_skips_review_required_and_invalid_range(tmp_path):
    proj = _project_with_clip(tmp_path)
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
    assert apply_prefix_edits(proj, "filler:", config_key="tighten", defaults=load_defaults()) == 0
    assert len(proj.edit_decisions) == 2


def test_edit_impact_report_tracks_gaps_and_pending(tmp_path):
    proj = _two_track_project(tmp_path)
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


def test_apply_prefix_edits_ignores_non_matching_reason(tmp_path):
    proj = _project_with_clip(tmp_path)
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
    assert apply_prefix_edits(proj, "filler:", config_key="tighten", defaults=load_defaults()) == 0


def test_apply_join_fades_skips_timeline_gaps(tmp_path):
    from podcast_mcp.edits.cut_application import _write_join_fades

    proj = _project_with_clip(tmp_path)
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
    _write_join_fades(proj, [decision], defaults=load_defaults())
    clips = sorted((c for c in proj.clips if c.track_id == "host"), key=lambda c: c.timeline_start)
    assert clips[0].fade_out_ms == 0
    assert clips[1].fade_in_ms == 0


def test_apply_prefix_edits_without_crossfade(tmp_path):

    proj = _project_with_clip(tmp_path)
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
    cfg = {"tighten": {"inaudible_opt": False, "crossfade_ms": 0}}
    removed = apply_prefix_edits(proj, "filler:", config_key="tighten", defaults=cfg)
    assert removed == 1


def test_edit_impact_report_ignores_non_remove_and_formats_without_segments(tmp_path):
    proj = _project_with_clip(tmp_path)
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


def test_join_rules_follow_shared_gap_tolerance(tmp_path, monkeypatch):
    """Edit-time join fades and the gap summary read JOIN_GAP_TOLERANCE_SEC, not a literal."""
    import podcast_mcp.edits.clips_ops as clips_ops
    from podcast_mcp.edits.cut_application import _write_join_fades

    proj = _project_with_clip(tmp_path)
    proj.timeline.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=5.0, timeline_start=0.0),
        Clip(id="c2", track_id="host", source_start=10.0, source_end=15.0, timeline_start=6.0),
    ]
    assert edit_impact_report(proj)["gap_count"] == 1

    monkeypatch.setattr(clips_ops, "JOIN_GAP_TOLERANCE_SEC", 1.5)

    assert edit_impact_report(proj)["gap_count"] == 0
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
    _write_join_fades(proj, [decision], defaults=load_defaults())
    right = next(c for c in proj.clips if c.id == "c2")
    assert right.fade_in_ms == 30


def _pending(decision_id: str, edit_type: EditDecisionType, start: float, end: float):
    return EditDecision(
        id=decision_id,
        track_id="host",
        type=edit_type,
        start=start,
        end=end,
        reason="nl:test",
        review_required=True,
        applied=False,
    )


def _impact(project: EpisodeProject) -> dict:
    report = edit_impact_report(project)
    return {
        "total": report["total_removed_sec"],
        "by_track": report["by_track_sec"],
        "applied": report["applied_count"],
        "pending": report["pending_review_count"],
    }


def test_impact_counts_approved_session_cut_once_and_per_track(tmp_path):
    proj = _approve_two_track_project(tmp_path)
    proj.edit_decisions = [_pending("a", EditDecisionType.REMOVE, 2.0, 4.0)]
    assert _impact(proj) == {"total": 0.0, "by_track": {}, "applied": 0, "pending": 1}
    approve_edits(proj, ["a"], defaults=load_defaults())
    assert proj.edit_decisions == []
    assert _impact(proj) == {
        "total": 2.0,
        "by_track": {"host": 2.0, "guest": 2.0},
        "applied": 1,
        "pending": 0,
    }
    [segment] = edit_impact_report(proj)["segments"]
    assert segment["id"] == proj.editorial.edit_log[0].id
    assert (segment["start"], segment["end"], segment["duration_sec"]) == (2.0, 4.0, 2.0)
    assert segment["applied"] is True


def test_impact_counts_approved_mute_as_applied_but_removes_no_time(tmp_path):
    proj = _project_with_clip(tmp_path)
    proj.edit_decisions = [
        _pending("m", EditDecisionType.MUTE, 2.0, 3.0),
        _pending("r", EditDecisionType.REMOVE, 6.0, 7.5),
    ]
    approve_edits(proj, ["m", "r"], defaults=load_defaults())
    assert _impact(proj) == {
        "total": 1.5,
        "by_track": {"host": 1.5},
        "applied": 2,
        "pending": 0,
    }


def test_impact_keeps_counting_applied_decisions_left_in_edit_decisions(tmp_path):
    proj = _project_with_clip(tmp_path)
    proj.edit_decisions = [
        EditDecision(
            id="kept_cut",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1.0,
            end=3.0,
            applied=True,
        ),
        EditDecision(
            id="kept_mute",
            track_id="host",
            type=EditDecisionType.MUTE,
            start=4.0,
            end=9.0,
            applied=True,
        ),
    ]
    assert _impact(proj) == {
        "total": 2.0,
        "by_track": {"host": 2.0},
        "applied": 2,
        "pending": 0,
    }


@pytest.mark.parametrize(
    ("action", "expected_total", "expected_by_track"),
    [("cut", 3.0, {"host": 3.0, "guest": 3.0}), ("mute", 0.0, {})],
)
def test_impact_uses_exact_range_intervals_once_across_tracks(
    tmp_path, action, expected_total, expected_by_track
):
    proj = _approve_two_track_project(tmp_path)
    intervals = [RangeInterval(start=1.0, end=2.0), RangeInterval(start=10.0, end=12.0)]
    selection = build_range_target(proj, intervals, ["host", "guest"])
    edit_selected_range(
        proj,
        selection,
        action,
        propose=True,
        reason="host:range",
        action_id="range_action",
        defaults=load_defaults(),
    )
    assert _impact(proj)["pending"] == 1
    approve_edits(
        proj,
        ["range_action"],
        application_intent=CutIntent.HUMAN_BOUNDARIES,
        defaults=load_defaults(),
    )
    assert _impact(proj) == {
        "total": expected_total,
        "by_track": expected_by_track,
        "applied": 1,
        "pending": 0,
    }


def test_impact_counts_timeline_ripple_once_and_punch_on_its_track_only(tmp_path):
    proj = _approve_two_track_project(tmp_path)
    ripple_cut(proj, 2.0, 5.0, use_inaudible_opt=False)
    assert _impact(proj) == {
        "total": 3.0,
        "by_track": {"host": 3.0, "guest": 3.0},
        "applied": 1,
        "pending": 0,
    }
    _write_punch_delete(
        proj,
        "guest",
        10.0,
        11.0,
        defaults=load_defaults(),
    )
    assert _impact(proj) == {
        "total": 4.0,
        "by_track": {"host": 3.0, "guest": 4.0},
        "applied": 2,
        "pending": 0,
    }


@pytest.mark.parametrize(
    ("ripple", "expected_by_track"),
    [(True, {"host": 10.0, "guest": 10.0}), (False, {"host": 10.0})],
)
def test_impact_counts_deleted_clips(tmp_path, ripple, expected_by_track):
    proj = _approve_two_track_project(tmp_path)
    split_clips_at(proj, 10.0, ["host"], defaults=load_defaults())
    split_clips_at(proj, 20.0, ["host"], defaults=load_defaults())
    middle = next(c for c in clips_for_track(proj, "host") if c.source_start == 10.0)
    if ripple:
        _write_ripple_delete_clips(
            proj, [middle.id], plan_delete_clips(proj, [middle.id]), defaults=load_defaults()
        )
    else:
        _write_punch_delete_clips(proj, [middle.id], defaults=load_defaults())
    assert _impact(proj) == {
        "total": 10.0,
        "by_track": expected_by_track,
        "applied": 1,
        "pending": 0,
    }


def test_impact_ignores_structural_edits(tmp_path):
    proj = _approve_two_track_project(tmp_path)
    split_clips_at(proj, 10.0, ["host", "guest"], defaults=load_defaults())
    clip = clips_for_track(proj, "host")[0]
    trim(proj, clip.id, "out", clip.source_end - 1.0)
    assert [r.operation for r in proj.editorial.edit_log] == ["split_clips_at", "trim_clip_edge"]
    assert _impact(proj) == {"total": 0.0, "by_track": {}, "applied": 0, "pending": 0}


def test_impact_drops_a_cut_after_guarded_history_undo(tmp_path):
    proj = _approve_two_track_project(tmp_path)
    proj.edit_decisions = [_pending("a", EditDecisionType.REMOVE, 2.0, 4.0)]
    ws = _saved_restore_workspace(proj, tmp_path)
    original = snapshot_from_project(ws.project).model_dump(mode="json")
    assert EditService(ws).approve(["a"]) == 1
    _refuse_restore_then_undo(ws, original)
    assert _impact(ws.project) == {"total": 0.0, "by_track": {}, "applied": 0, "pending": 1}


def test_unplayed_pending_ids_flags_only_spans_no_clip_plays(tmp_path):
    proj = _project_with_clip(tmp_path)
    proj.timeline.clips[0].source_end = 6.0
    proj.edit_decisions = [
        _pending("played", EditDecisionType.REMOVE, 1.0, 2.0),
        _pending("cut-remove", EditDecisionType.REMOVE, 7.0, 8.0),
        _pending("cut-mute", EditDecisionType.MUTE, 7.2, 7.5),
        _pending("split", EditDecisionType.SPLIT, 7.0, 7.0),
        _pending("done", EditDecisionType.REMOVE, 7.0, 8.0).model_copy(update={"applied": True}),
    ]
    assert unplayed_pending_ids(proj) == ["cut-remove", "cut-mute"]
    assert unplayed_pending_ids(proj, {"cut-mute", "played", "done"}) == ["cut-mute"]
    assert retire_unplayed_pending(proj) == 2
    assert [e.id for e in proj.edit_decisions] == ["played", "split", "done"]


def test_audio_mutation_retires_proposals_in_the_cut_range(tmp_path):
    proj = _project_with_clip(tmp_path)
    proj.edit_decisions = [
        _pending("kept", EditDecisionType.REMOVE, 1.0, 2.0),
        _pending("gone", EditDecisionType.REMOVE, 7.0, 8.0),
    ]
    ws = _saved_restore_workspace(proj, tmp_path)

    ws.mutate(
        "before cut",
        "cut 6-9",
        lambda p: ripple_cut(p, 6.0, 9.0, use_inaudible_opt=False),
    )

    assert [e.id for e in ws.project.edit_decisions] == ["kept"]


def test_a_mutation_that_leaves_audio_alone_keeps_every_proposal(tmp_path):
    proj = _project_with_clip(tmp_path)
    proj.edit_decisions = [_pending("kept", EditDecisionType.REMOVE, 7.0, 8.0)]
    ws = _saved_restore_workspace(proj, tmp_path)

    ws.mutate(
        "before", "after", lambda p: p.timeline.__setattr__("duration_sec", p.timeline.duration_sec)
    )

    assert [e.id for e in ws.project.edit_decisions] == ["kept"]


def test_apply_prefix_edits_leaves_an_unplayed_proposal_alone(tmp_path):
    proj = _project_with_clip(tmp_path)
    proj.timeline.clips[0].source_end = 6.0
    proj.edit_decisions = [
        EditDecision(
            id="cut",
            track_id="host",
            type=EditDecisionType.MUTE,
            start=7.0,
            end=8.0,
            reason="filler:um",
            review_required=False,
        )
    ]
    assert apply_prefix_edits(proj, "filler:", config_key="tighten", defaults=load_defaults()) == 0
    assert proj.editorial.edit_log == []
    assert proj.clips[0].mute_regions == []
