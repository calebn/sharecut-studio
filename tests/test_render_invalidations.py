"""Render invalidation cause journal tests."""

from __future__ import annotations

from podcast_mcp.engines.play_audit import write_stem_hash
from podcast_mcp.engines.render_invalidations import (
    clear_invalidations_for_tracks,
    reason_for_operation,
    record_after_audio_mutation,
    record_invalidation,
    replace_with_whole_track,
)
from podcast_mcp.engines.render_status import render_status_report
from podcast_mcp.models import (
    AppliedEditRecord,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
    save_project,
)


def _with_dialogue_track(proj_path, sample_wav):
    project = load_project(proj_path)
    if not project.tracks:
        project.timeline.tracks.append(
            Track(
                id="host",
                label="Host",
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=str(sample_wav), duration_sec=1.0),
            )
        )
        save_project(project, proj_path)
        project = load_project(proj_path)
    return project


def test_reason_for_operation_mapping() -> None:
    assert reason_for_operation("approve_edits") == "cut"
    assert reason_for_operation("set_effect_bypass") == "fx"
    assert reason_for_operation("set_envelope") == "envelope"
    assert reason_for_operation("set_gain") == "gain"
    assert reason_for_operation("set_mute") == "mute"
    assert reason_for_operation("split_at_time") == "clip"
    assert reason_for_operation(None) == "other"
    assert reason_for_operation("unknown_op") == "other"


def test_record_invalidation_defaults_and_unknown_reason(minimal_project, sample_wav) -> None:
    project = _with_dialogue_track(minimal_project, sample_wav)
    inv = record_invalidation(project, track_ids=[], reason="not-a-reason")
    assert inv.reason == "other"
    assert inv.track_ids == [project.tracks[0].id]


def test_clear_invalidations_empty_noop(minimal_project, sample_wav) -> None:
    project = _with_dialogue_track(minimal_project, sample_wav)
    tid = project.tracks[0].id
    record_invalidation(project, track_ids=[tid], reason="fx")
    assert clear_invalidations_for_tracks(project, []) == 0
    assert len(project.render.invalidations) == 1


def test_record_after_mutation_skips_inverted_edit_log_range(minimal_project, sample_wav) -> None:
    project = _with_dialogue_track(minimal_project, sample_wav)
    tid = project.tracks[0].id
    rec = AppliedEditRecord(
        id="alog_bad",
        applied_at="2026-01-01T00:00:00Z",
        operation="approve_edits",
        track_ids=[tid],
        timeline_start=12.0,
        timeline_end=10.0,
    )
    created = record_after_audio_mutation(
        project,
        changed_track_ids=[tid],
        operation="approve_edits",
        new_edit_log=[rec],
    )
    assert len(created) == 1
    assert created[0].timeline_start is None
    assert created[0].reason == "cut"


def test_record_after_mutation_prefers_edit_log_ranges(minimal_project, sample_wav) -> None:
    project = _with_dialogue_track(minimal_project, sample_wav)
    tid = project.tracks[0].id
    rec = AppliedEditRecord(
        id="alog_test",
        applied_at="2026-01-01T00:00:00Z",
        operation="approve_edits",
        track_ids=[tid],
        timeline_start=10.0,
        timeline_end=12.5,
    )
    created = record_after_audio_mutation(
        project,
        changed_track_ids=[tid],
        operation="approve_edits",
        new_edit_log=[rec],
    )
    assert len(created) == 1
    assert created[0].timeline_start == 10.0
    assert created[0].timeline_end == 12.5
    assert created[0].reason == "cut"
    assert len(project.render.invalidations) == 1


def test_record_after_mutation_journals_leftover_tracks(minimal_project, sample_wav) -> None:
    project = _with_dialogue_track(minimal_project, sample_wav)
    project.timeline.tracks.append(
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=str(sample_wav), duration_sec=1.0),
        )
    )
    host_id = project.tracks[0].id
    guest_id = "guest"
    rec = AppliedEditRecord(
        id="alog_host_only",
        applied_at="2026-01-01T00:00:00Z",
        operation="approve_edits",
        track_ids=[host_id],
        timeline_start=10.0,
        timeline_end=12.5,
    )
    created = record_after_audio_mutation(
        project,
        changed_track_ids=[host_id, guest_id],
        operation="approve_edits",
        new_edit_log=[rec],
    )
    assert len(created) == 2
    regional = next(c for c in created if c.timeline_start is not None)
    whole = next(c for c in created if c.timeline_start is None)
    assert regional.track_ids == [host_id]
    assert whole.track_ids == [guest_id]
    assert whole.reason == "cut"


def test_record_after_mutation_whole_track_for_fx(minimal_project, sample_wav) -> None:
    project = _with_dialogue_track(minimal_project, sample_wav)
    tid = project.tracks[0].id
    created = record_after_audio_mutation(
        project,
        changed_track_ids=[tid],
        operation="set_effect_bypass",
        new_edit_log=[],
    )
    assert len(created) == 1
    assert created[0].timeline_start is None
    assert created[0].reason == "fx"


def test_clear_invalidations_on_stem_hash(minimal_project, sample_wav) -> None:
    project = _with_dialogue_track(minimal_project, sample_wav)
    tid = project.tracks[0].id
    stem_dir = project.artifacts_dir() / "tracks"
    stem_dir.mkdir(parents=True, exist_ok=True)
    (stem_dir / f"{tid}.wav").write_bytes(sample_wav.read_bytes())
    record_invalidation(
        project,
        track_ids=[tid],
        reason="cut",
        timeline_start=1.0,
        timeline_end=2.0,
    )
    assert project.render.invalidations
    write_stem_hash(project, tid)
    assert project.render.invalidations == []


def test_replace_with_whole_track(minimal_project, sample_wav) -> None:
    project = _with_dialogue_track(minimal_project, sample_wav)
    tid = project.tracks[0].id
    record_invalidation(project, track_ids=[tid], reason="cut", timeline_start=0, timeline_end=1)
    replace_with_whole_track(project, [tid], reason="other")
    assert len(project.render.invalidations) == 1
    assert project.render.invalidations[0].timeline_start is None
    assert project.render.invalidations[0].reason == "other"


def test_render_status_includes_invalidations(minimal_project, sample_wav) -> None:
    project = _with_dialogue_track(minimal_project, sample_wav)
    tid = project.tracks[0].id
    record_invalidation(project, track_ids=[tid], reason="fx")
    report = render_status_report(project)
    assert "invalidations" in report
    assert report["invalidations"][0]["reason"] == "fx"
    assert report["invalidations"][0]["track_ids"] == [tid]


def test_clear_partial_track_ids(minimal_project, sample_wav) -> None:
    project = _with_dialogue_track(minimal_project, sample_wav)
    project.timeline.tracks.append(
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=str(sample_wav), duration_sec=1.0),
        )
    )
    ids = ["host", "guest"]
    # Ensure host id matches
    ids[0] = project.tracks[0].id
    record_invalidation(project, track_ids=ids, reason="fx")
    clear_invalidations_for_tracks(project, [ids[0]])
    assert len(project.render.invalidations) == 1
    assert project.render.invalidations[0].track_ids == [ids[1]]
