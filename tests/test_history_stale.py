"""Stale marks for history moves (#424)."""

from __future__ import annotations

from podcast_mcp.engines.history_stale import AudioStateBefore, mark_history_move_stale
from podcast_mcp.engines.play_audit import stem_path, write_stem_hash
from podcast_mcp.engines.render_invalidations import record_invalidation
from podcast_mcp.models import Clip, EpisodeProject, Track, TrackRole


def _project(tmp_path, track_ids=("host",)):
    ws = tmp_path / "ws"
    (ws / "artifacts" / "tracks").mkdir(parents=True)
    project = EpisodeProject.create("hs", str(ws))
    for tid in track_ids:
        project.timeline.tracks.append(Track(id=tid, label=tid, role=TrackRole.DIALOGUE))
    project.timeline.clips = [
        Clip(id=f"c_{tid}", track_id=tid, source_start=0.0, source_end=2.0, timeline_start=0.0)
        for tid in track_ids
    ]
    return project


def test_a_matching_sidecar_without_its_wav_keeps_a_whole_track_marker(tmp_path) -> None:
    project = _project(tmp_path)
    write_stem_hash(project, "host")  # sidecar for source_end=2.0, no WAV beside it
    project.clips[0].source_end = 1.0
    before = AudioStateBefore.capture(project)
    project.clips[0].source_end = 2.0  # the move restores the hashed state

    mark_history_move_stale(project, before)

    assert not stem_path(project, "host").is_file()
    [inv] = project.render.invalidations
    assert inv.track_ids == ["host"]
    assert inv.timeline_start is None


def test_a_matching_sidecar_with_its_wav_drops_the_cause_journal(tmp_path, sample_wav) -> None:
    project = _project(tmp_path)
    stem_path(project, "host").write_bytes(sample_wav.read_bytes())
    write_stem_hash(project, "host")
    project.clips[0].source_end = 1.0
    record_invalidation(project, track_ids=["host"], reason="cut")
    before = AudioStateBefore.capture(project)
    project.clips[0].source_end = 2.0

    mark_history_move_stale(project, before)

    assert project.render.invalidations == []
    assert project.reconciliation_stale is True


def test_a_history_move_hashes_each_dialogue_track_once_per_state(tmp_path, monkeypatch) -> None:
    from podcast_mcp.engines import play_audit

    project = _project(tmp_path, ("host", "guest"))
    real = play_audit.track_render_hash
    calls: list[str] = []

    def counting(p, tid):
        calls.append(tid)
        return real(p, tid)

    monkeypatch.setattr(play_audit, "track_render_hash", counting)
    before = AudioStateBefore.capture(project)
    assert sorted(calls) == ["guest", "host"]
    mark_history_move_stale(project, before)
    assert sorted(calls) == ["guest", "guest", "host", "host"]
