"""Long jobs merge their saves instead of overwriting concurrent edits (#426)."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from podcast_mcp.engines.play_audit import premix_is_stale, write_stem_hash
from podcast_mcp.models import MediaAsset, Track, TrackRole, load_project, save_project
from podcast_mcp.pipeline import runner as runner_mod
from podcast_mcp.pipeline import steps
from podcast_mcp.project_merge import ProjectMergeConflict
from podcast_mcp.services import EpisodeService, PipelineService, ProjectWorkspace
from podcast_mcp.services.workspace import MERGED_HISTORY_LABEL


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
