"""Long jobs merge their saves instead of overwriting concurrent edits (#426)."""

from __future__ import annotations

import json
import threading
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from podcast_mcp.engines.play_audit import premix_is_stale, write_stem_hash
from podcast_mcp.gui.jobs import _gui_fail_message
from podcast_mcp.history import HistoryManager
from podcast_mcp.models import MediaAsset, Track, TrackRole, load_project, save_project
from podcast_mcp.pipeline import runner as runner_mod
from podcast_mcp.pipeline import steps
from podcast_mcp.project_merge import HISTORY_CURSOR_CONFLICT, ProjectMergeConflict
from podcast_mcp.project_store import history_index_path, history_snapshot_ids
from podcast_mcp.services import (
    EpisodeService,
    HistoryRerenderError,
    HistoryService,
    PipelineService,
    ProjectWorkspace,
)
from podcast_mcp.services import history as history_service_mod
from podcast_mcp.services import workspace as workspace_mod
from podcast_mcp.services.workspace import MERGED_HISTORY_LABEL
from podcast_mcp.util.atomic_json import load_json_object


def _two_tracks(minimal_project: Path) -> ProjectWorkspace:
    proj = load_project(minimal_project)
    proj.tracks = [
        Track(
            id=tid,
            label=tid,
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
        for tid in ("host", "guest")
    ]
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def _other_sets_volume(minimal_project: Path, track_id: str = "host", db: float = -6.0) -> None:
    EpisodeService(ProjectWorkspace.open(minimal_project)).set_track_volume(track_id, db)


def test_save_merged_keeps_an_edit_committed_after_checkpoint(minimal_project):
    ws = _two_tracks(minimal_project)
    ws.checkpoint()
    _other_sets_volume(minimal_project)
    ws.project.track_by_id("host").gain_db = 2.0
    ws.save_merged()
    for host in (ws.project.track_by_id("host"), load_project(minimal_project).track_by_id("host")):
        assert host.fader_db == -6.0
        assert host.gain_db == 2.0
    assert ws.project.history.entries[-1].label == MERGED_HISTORY_LABEL


def test_save_merged_keeps_unsaved_edits_made_before_checkpoint(minimal_project):
    ws = _two_tracks(minimal_project)
    ws.project.track_by_id("guest").gain_db = 5.0
    ws.checkpoint()
    _other_sets_volume(minimal_project)
    ws.save_merged()
    for project in (ws.project, load_project(minimal_project)):
        assert project.track_by_id("guest").gain_db == 5.0
        assert project.track_by_id("host").fader_db == -6.0


def test_checkpoint_drops_unsaved_edits_when_another_writer_committed_first(minimal_project):
    ws = _two_tracks(minimal_project)
    ws.project.track_by_id("guest").gain_db = 5.0
    _other_sets_volume(minimal_project)
    ws.checkpoint()
    ws.save_merged()
    saved = load_project(minimal_project)
    assert saved.track_by_id("guest").gain_db == 0.0
    assert saved.track_by_id("host").fader_db == -6.0


def test_checkpoint_bases_the_merge_on_the_read_it_checked(minimal_project, monkeypatch):
    ws = _two_tracks(minimal_project)
    real_load = ws._store.load
    calls: list[int] = []

    def racing_load():
        if not calls:
            calls.append(1)
            # Another writer commits after checkpoint() sampled the file signature.
            _other_sets_volume(minimal_project)
        return real_load()

    monkeypatch.setattr(ws._store, "load", racing_load)
    ws.checkpoint()
    ws.save_merged()
    assert load_project(minimal_project).track_by_id("host").fader_db == -6.0


def test_save_merged_without_other_writers_adds_no_merge_entry(minimal_project):
    ws = _two_tracks(minimal_project)
    ws.checkpoint()
    ws.project.track_by_id("host").gain_db = 2.0
    ws.save_merged()
    saved = load_project(minimal_project)
    assert saved.track_by_id("host").gain_db == 2.0
    assert all(e.label != MERGED_HISTORY_LABEL for e in saved.history.entries)


def test_save_merged_conflict_saves_nothing(minimal_project):
    ws = _two_tracks(minimal_project)
    ws.checkpoint()
    other = ProjectWorkspace.open(minimal_project)
    other.mutate("b", "a", lambda p: setattr(p.track_by_id("host"), "gain_db", 5.0))
    ws.project.track_by_id("host").gain_db = 2.0
    with pytest.raises(ProjectMergeConflict):
        ws.save_merged()
    assert load_project(minimal_project).track_by_id("host").gain_db == 5.0


def test_save_merged_requires_checkpoint(minimal_project):
    ws = _two_tracks(minimal_project)
    with pytest.raises(RuntimeError, match="checkpoint"):
        ws.save_merged()


def test_pipeline_step_keeps_a_volume_saved_mid_step(minimal_project, monkeypatch):
    ws = _two_tracks(minimal_project)

    def step(project, _defaults):
        project.track_by_id("guest").gain_db = 1.5
        _other_sets_volume(minimal_project)
        return "done"

    monkeypatch.setitem(runner_mod._STEP_MAP, "merge_transcript", step)
    PipelineService(ws).run(only_step="merge_transcript")
    saved = load_project(minimal_project)
    assert saved.track_by_id("host").fader_db == -6.0
    assert saved.track_by_id("guest").gain_db == 1.5
    assert saved.last_completed_step == "merge_transcript"
    log = saved.pipeline_runs[-1].steps[0]
    assert log.status == "ok"
    assert log.finished_at
    labels = [e.label for e in saved.history.entries]
    assert {"before pipeline run", "after merge_transcript", MERGED_HISTORY_LABEL} <= set(labels)
    assert load_json_object(history_index_path(saved)) == saved.history.model_dump(mode="json")


def test_pipeline_mix_keeps_a_mid_mix_volume_and_reports_the_premix_stale(minimal_project):
    ws = _two_tracks(minimal_project)
    tracks_dir = ws.project.artifacts_dir() / "tracks"
    tracks_dir.mkdir(parents=True, exist_ok=True)
    rendered = {t.id: str(tracks_dir / f"{t.id}.wav") for t in ws.project.tracks}
    (ws.project.artifacts_dir() / "track_outputs.json").write_text(json.dumps(rendered))
    for track_id, path in rendered.items():
        Path(path).write_bytes(b"RIFF")
        write_stem_hash(ws.project, track_id)
    ws.save()

    def mix(_inputs, out):
        _other_sets_volume(minimal_project)
        out.write_bytes(b"RIFFMIX")
        return out

    eng = MagicMock()
    eng.mix_tracks.side_effect = mix
    with patch.object(steps, "ffmpeg", return_value=eng):
        PipelineService(ws).run(only_step="mix_with_music")
    saved = load_project(minimal_project)
    assert saved.track_by_id("host").fader_db == -6.0
    assert premix_is_stale(saved) is True


def test_render_preview_renders_the_saved_project(minimal_project):
    ws = _two_tracks(minimal_project)
    EpisodeService(ProjectWorkspace.open(minimal_project)).set_track_mute("guest", True)
    seen: list[bool] = []

    def fake(project, progress=None):
        seen.append(project.track_by_id("guest").muted)
        return {"ok": True, "path": None, "edit_count": 0}

    with patch("podcast_mcp.services.pipeline.rerender_preview", fake):
        PipelineService(ws).render_preview()
    assert seen == [True]
    assert load_project(minimal_project).track_by_id("guest").muted is True


def test_play_premix_rerender_keeps_an_edit_saved_mid_render(minimal_project):
    from podcast_mcp.services.play import PlayService

    ws = _two_tracks(minimal_project)
    svc = PlayService(ws)

    def fake(project, progress=None):
        _other_sets_volume(minimal_project)
        premix = project.artifacts_dir() / "premix.wav"
        premix.parent.mkdir(parents=True, exist_ok=True)
        premix.write_bytes(b"RIFF")
        return {"ok": True}

    with patch("podcast_mcp.services.play.rerender_preview", fake):
        svc._ensure_premix(rerender=True)
    assert load_project(minimal_project).track_by_id("host").fader_db == -6.0
    assert svc.project is ws.project


def test_mutate_reload_first_discards_unsaved_edits(minimal_project):
    ws = _two_tracks(minimal_project)
    _other_sets_volume(minimal_project)
    ws.project.track_by_id("guest").gain_db = 5.0
    ws.mutate("before", "after", lambda _p: None, reload_first=True)
    assert ws.project.track_by_id("guest").gain_db == 0.0
    assert ws.project.track_by_id("host").fader_db == -6.0


def test_export_audio_keeps_an_edit_saved_during_export(minimal_project, tmp_path):
    ws = _two_tracks(minimal_project)

    def master(_project, _defaults):
        _other_sets_volume(minimal_project)
        return tmp_path / "mastered.wav"

    with (
        patch("podcast_mcp.services.pipeline.pipeline_steps.ensure_current_master", master),
        patch("podcast_mcp.export.audio.export_episode_audio", return_value=[]),
        patch("podcast_mcp.services.pipeline.ffmpeg", return_value=MagicMock()),
    ):
        PipelineService(ws).export_audio([{"ext": "mp3"}])
    assert load_project(minimal_project).track_by_id("host").fader_db == -6.0


def _index_matches_file(minimal_project: Path) -> None:
    saved = load_project(minimal_project)
    assert load_json_object(history_index_path(saved)) == saved.history.model_dump(mode="json")


def _snapshots(ws: ProjectWorkspace) -> set[str]:
    return history_snapshot_ids(history_index_path(ws.project))


def test_pipeline_step_conflict_leaves_history_index_matching_the_file(
    minimal_project, monkeypatch
):
    ws = _two_tracks(minimal_project)
    snaps_at_step: set[str] = set()

    def step(project, _defaults):
        snaps_at_step.update(_snapshots(ws))
        project.track_by_id("host").gain_db = 2.0
        other = ProjectWorkspace.open(minimal_project)
        other.mutate("b", "a", lambda p: setattr(p.track_by_id("host"), "gain_db", 5.0))
        return "done"

    monkeypatch.setitem(runner_mod._STEP_MAP, "merge_transcript", step)
    with pytest.raises(ProjectMergeConflict):
        PipelineService(ws).run(only_step="merge_transcript")
    _index_matches_file(minimal_project)
    saved = load_project(minimal_project)
    assert "after merge_transcript" not in [e.label for e in saved.history.entries]
    assert "after merge_transcript" not in [e.label for e in ws.project.history.entries]
    referenced = {Path(e.snapshot_file).stem for e in saved.history.entries}
    assert _snapshots(ws) - snaps_at_step <= referenced


def test_save_merged_commit_failure_adopts_nothing(minimal_project, monkeypatch):
    ws = _two_tracks(minimal_project)
    ws.checkpoint()
    _other_sets_volume(minimal_project)
    ws.project.track_by_id("host").gain_db = 2.0
    index_path = history_index_path(ws.project)
    index_before = load_json_object(index_path)
    history_before = ws.project.history.model_copy(deep=True)
    snaps_before = _snapshots(ws)

    def boom(*_a, **_k):
        raise OSError("disk full")

    monkeypatch.setattr(ws._store, "commit", boom)
    with pytest.raises(OSError):
        ws.save_merged(history_label="after step")
    assert load_json_object(index_path) == index_before
    assert ws.project.history == history_before
    assert _snapshots(ws) == snaps_before
    assert ws.project.track_by_id("host").fader_db == 0.0
    monkeypatch.undo()
    ws.save_merged()
    saved = load_project(minimal_project)
    assert saved.track_by_id("host").fader_db == -6.0
    assert saved.track_by_id("host").gain_db == 2.0


def test_save_merged_adopts_the_file_when_only_the_cache_write_failed(minimal_project, monkeypatch):
    ws = _two_tracks(minimal_project)
    ws.checkpoint()
    _other_sets_volume(minimal_project)
    ws.project.track_by_id("host").gain_db = 2.0

    def boom(*_a, **_k):
        raise OSError("cache")

    monkeypatch.setattr(ws._store, "_mirror_transcript_cache", boom)
    with pytest.raises(OSError):
        ws.save_merged()
    assert ws.project.track_by_id("host").fader_db == -6.0
    _index_matches_file(minimal_project)


def test_save_merged_conflicts_when_another_writer_undid_during_the_job(minimal_project):
    ws = _two_tracks(minimal_project)
    _other_sets_volume(minimal_project)
    ws.checkpoint()
    other = ProjectWorkspace.open(minimal_project)
    HistoryManager(other.path).undo(other.project)
    ws.project.track_by_id("guest").gain_db = 1.0
    with pytest.raises(ProjectMergeConflict, match=r"history\.lineage"):
        ws.save_merged(history_label="after step")
    _index_matches_file(minimal_project)


def test_save_merged_raises_the_commit_error_when_rollback_fails(minimal_project, monkeypatch):
    ws = _two_tracks(minimal_project)
    ws.checkpoint()
    ws.project.track_by_id("host").gain_db = 2.0

    def commit_boom(*_a, **_k):
        raise OSError("disk full")

    def rollback_boom(*_a, **_k):
        raise OSError("rollback failed")

    monkeypatch.setattr(ws._store, "commit", commit_boom)
    monkeypatch.setattr(workspace_mod, "rollback_history", rollback_boom)
    with pytest.raises(OSError, match="disk full"):
        ws.save_merged(history_label="after step")
    assert "after step" not in [e.label for e in ws.project.history.entries]


def test_save_merged_removes_a_snapshot_left_by_a_failed_record(minimal_project, monkeypatch):
    ws = _two_tracks(minimal_project)
    ws.checkpoint()
    ws.project.track_by_id("host").gain_db = 2.0
    index_path = history_index_path(ws.project)
    index_before = load_json_object(index_path)
    snaps_before = _snapshots(ws)

    def boom(*_a, **_k):
        raise OSError("index write failed")

    monkeypatch.setattr(HistoryManager, "_save_index", boom)
    with pytest.raises(OSError, match="index write failed"):
        ws.save_merged(history_label="after step")
    assert _snapshots(ws) == snaps_before
    assert load_json_object(index_path) == index_before


def test_save_merged_rewrites_a_corrupt_history_index(minimal_project):
    ws = _two_tracks(minimal_project)
    _other_sets_volume(minimal_project)
    ws.checkpoint()
    history_index_path(ws.project).write_text("{", encoding="utf-8")
    ws.project.track_by_id("guest").gain_db = 1.0
    ws.save_merged(history_label="after step")
    _index_matches_file(minimal_project)


def test_save_merged_conflict_restores_a_corrupt_index_from_the_file(minimal_project):
    ws = _two_tracks(minimal_project)
    _other_sets_volume(minimal_project)
    ws.checkpoint()
    ws.project.track_by_id("host").fader_db = 3.0
    _other_sets_volume(minimal_project, db=-9.0)
    history_index_path(ws.project).write_text("{", encoding="utf-8")
    with pytest.raises(ProjectMergeConflict):
        ws.save_merged(history_label="after step")
    _index_matches_file(minimal_project)


def test_save_merged_invalid_merge_rolls_back_history(minimal_project, monkeypatch):
    ws = _two_tracks(minimal_project)
    ws.checkpoint()
    _other_sets_volume(minimal_project)
    ws.project.track_by_id("host").gain_db = 2.0
    index_path = history_index_path(ws.project)
    index_before = load_json_object(index_path)
    history_before = ws.project.history.model_copy(deep=True)
    snaps_before = _snapshots(ws)
    monkeypatch.setattr(
        workspace_mod,
        "merge_project_data",
        lambda _base, _ours, theirs, **_advice: {**theirs, "history": 5},
    )
    with pytest.raises(ProjectMergeConflict, match="merged project is invalid"):
        ws.save_merged(history_label="after step")
    assert load_json_object(index_path) == index_before
    assert ws.project.history == history_before
    assert _snapshots(ws) == snaps_before


def test_pipeline_run_reports_an_undo_before_the_first_step(minimal_project, monkeypatch):
    ws = _two_tracks(minimal_project)
    _other_sets_volume(minimal_project)
    real_checkpoint = ws.checkpoint

    def checkpoint_then_undo():
        project = real_checkpoint()
        project.track_by_id("guest").gain_db = 1.0  # the run's own unsaved change
        other = ProjectWorkspace.open(minimal_project)
        HistoryManager(other.path).undo(other.project)
        return project

    ran: list[str] = []

    def step(_project, _defaults):
        ran.append("merge_transcript")
        return "done"

    monkeypatch.setattr(ws, "checkpoint", checkpoint_then_undo)
    monkeypatch.setitem(runner_mod._STEP_MAP, "merge_transcript", step)
    with pytest.raises(ProjectMergeConflict, match="undo or redo") as exc:
        PipelineService(ws).run(only_step="merge_transcript")
    assert "history.lineage" in exc.value.paths
    assert ran == []
    assert "re-run it" in (_gui_fail_message(str(exc.value)) or "")
    _index_matches_file(minimal_project)


def test_save_merged_keeps_snapshots_when_the_file_cannot_be_statted(minimal_project, monkeypatch):
    ws = _two_tracks(minimal_project)
    ws.checkpoint()
    ws.project.track_by_id("host").gain_db = 2.0
    history_before = ws.project.history.model_copy(deep=True)
    real_revision = workspace_mod.project_file_revision
    calls = {"n": 0}

    def revision(project):
        calls["n"] += 1
        if calls["n"] > 1:
            raise PermissionError("stat denied")
        return real_revision(project)

    def cache_boom(*_a, **_k):
        raise OSError("cache")

    monkeypatch.setattr(workspace_mod, "project_file_revision", revision)
    monkeypatch.setattr(ws._store, "_mirror_transcript_cache", cache_boom)
    with pytest.raises(OSError, match="cache"):
        ws.save_merged(history_label="after step")
    assert ws.project.history == history_before
    saved = load_project(minimal_project)
    assert "after step" in [e.label for e in saved.history.entries]
    for entry in saved.history.entries:
        assert (saved.workspace_path() / entry.snapshot_file).is_file()
    _index_matches_file(minimal_project)


def test_pipeline_step_commit_failure_does_not_mark_the_step_done(minimal_project, monkeypatch):
    ws = _two_tracks(minimal_project)
    before = ws.project.last_completed_step

    def boom(*_a, **_k):
        raise OSError("disk full")

    def step(_project, _defaults):
        monkeypatch.setattr(ws._store, "commit", boom)
        return "done"

    monkeypatch.setitem(runner_mod._STEP_MAP, "merge_transcript", step)
    with pytest.raises(OSError, match="disk full"):
        PipelineService(ws).run(only_step="merge_transcript")
    assert ws.project.last_completed_step == before
    assert load_project(minimal_project).last_completed_step == before


def _with_undoable_gain(minimal_project: Path) -> ProjectWorkspace:
    ws = _two_tracks(minimal_project)
    ws.mutate(
        "before gain",
        "after gain",
        lambda proj: setattr(proj.track_by_id("guest"), "gain_db", 3.0),
    )
    return ws


def _move_history_with_rerender(ws: ProjectWorkspace, move: str) -> dict:
    svc = HistoryService(ws)
    if move == "undo":
        return svc.undo(rerender=True)
    if move == "redo":
        svc.undo()
        return svc.redo(rerender=True)
    return svc.goto(0, rerender=True)


@pytest.mark.parametrize(("move", "guest_gain"), [("undo", 0.0), ("redo", 3.0), ("goto", 0.0)])
def test_history_move_rerender_keeps_an_edit_saved_mid_render(minimal_project, move, guest_gain):
    ws = _with_undoable_gain(minimal_project)

    def fake_render(project):
        project.track_by_id("guest").fader_db = -2.0  # the render's own change
        _other_sets_volume(minimal_project)

    with patch("podcast_mcp.services.history.rerender_preview", fake_render):
        out = _move_history_with_rerender(ws, move)

    saved = load_project(minimal_project)
    for proj in (ws.project, saved):
        assert proj.track_by_id("host").fader_db == -6.0
        assert proj.track_by_id("guest").gain_db == guest_gain
    assert saved.reconciliation_stale is True
    assert saved.history.entries[-1].label == MERGED_HISTORY_LABEL
    assert out["cursor"] == saved.history.cursor
    assert "preview" in out
    _index_matches_file(minimal_project)


@pytest.mark.parametrize(("move", "guest_gain"), [("undo", 0.0), ("redo", 3.0), ("goto", 0.0)])
def test_history_move_rerender_conflict_keeps_the_move_and_says_not_to_repeat_it(
    minimal_project, move, guest_gain
):
    ws = _with_undoable_gain(minimal_project)

    def fake_render(project):
        project.track_by_id("host").fader_db = -3.0
        _other_sets_volume(minimal_project)

    with patch("podcast_mcp.services.history.rerender_preview", fake_render):
        with pytest.raises(
            ProjectMergeConflict, match=f"the {move} is saved; .*instead of repeating the {move}"
        ) as exc:
            _move_history_with_rerender(ws, move)

    assert "timeline.tracks[host].fader_db" in exc.value.paths
    assert "re-run it" not in str(exc.value)
    saved = load_project(minimal_project)
    assert saved.track_by_id("guest").gain_db == guest_gain
    assert saved.track_by_id("host").fader_db == -6.0
    _index_matches_file(minimal_project)


@pytest.mark.parametrize(("move", "guest_gain"), [("undo", 0.0), ("redo", 3.0), ("goto", 0.0)])
def test_history_move_render_failure_keeps_the_move_and_says_not_to_repeat_it(
    minimal_project, move, guest_gain
):
    ws = _with_undoable_gain(minimal_project)

    def failing_render(_project):
        raise OSError("ffmpeg failed")

    with patch("podcast_mcp.services.history.rerender_preview", failing_render):
        with pytest.raises(HistoryRerenderError, match=f"instead of repeating the {move}") as exc:
            _move_history_with_rerender(ws, move)

    assert "ffmpeg failed" in str(exc.value)
    assert isinstance(exc.value.__cause__, OSError)
    saved = load_project(minimal_project)
    assert saved.track_by_id("guest").gain_db == guest_gain
    assert saved.reconciliation_stale is True


def test_history_move_rerender_cursor_clash_says_to_check_history_status(
    minimal_project, monkeypatch
):
    ws = _with_undoable_gain(minimal_project)

    def cursor_clash(_base, _ours, _theirs, **advice):
        raise ProjectMergeConflict([HISTORY_CURSOR_CONFLICT], **advice)

    monkeypatch.setattr(workspace_mod, "merge_project_data", cursor_clash)

    def fake_render(_project):
        _other_sets_volume(minimal_project)  # the file moves, so save_merged merges

    with patch("podcast_mcp.services.history.rerender_preview", fake_render):
        with pytest.raises(ProjectMergeConflict, match="check history_status") as exc:
            HistoryService(ws).undo(rerender=True)

    assert "is saved" not in str(exc.value)
    assert str(exc.value).startswith("an undo or redo changed the project")


def test_history_move_saves_its_stale_marks_before_another_commit(minimal_project):
    ws = _with_undoable_gain(minimal_project)
    other = threading.Thread(target=_other_sets_volume, args=(minimal_project,))
    real_mark = history_service_mod.mark_reconciliation_stale

    def mark_while_another_request_commits(project):
        other.start()
        other.join(timeout=0.2)
        assert other.is_alive(), "the other commit must wait until the move is saved"
        real_mark(project)

    with patch.object(
        history_service_mod, "mark_reconciliation_stale", mark_while_another_request_commits
    ):
        HistoryService(ws).undo()
    other.join(timeout=5)
    assert not other.is_alive()
    saved = load_project(minimal_project)
    assert saved.track_by_id("guest").gain_db == 0.0
    assert saved.track_by_id("host").fader_db == -6.0
    _index_matches_file(minimal_project)
