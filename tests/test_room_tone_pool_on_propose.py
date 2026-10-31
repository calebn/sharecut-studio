"""A project with no recorded room-tone pool gets one in the background at propose and approve (#2359)."""

from __future__ import annotations

import shutil
import threading
from pathlib import Path

import pytest

from pause_policy_public_helpers import workspace
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.engines import room_tone
from podcast_mcp.engines.room_tone import room_tone_span
from podcast_mcp.models import EpisodeProject, MediaAsset, Track, TrackRole
from podcast_mcp.services.document import EditService
from test_approve_guard_blocked_ripple import _blocked_filler
from test_room_tone import _host_audio, _noise, _project


def _join_pools() -> None:
    for thread in threading.enumerate():
        if thread.name.startswith("room-tone-pool-"):
            thread.join(60)


def _two_speakers(tmp_path: Path) -> EpisodeProject:
    return _project(tmp_path, host=_host_audio(), guest=_noise(-64.0, seed=2))


def _count_picks(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    real = room_tone._pick_sample
    calls = [0]

    def counted(*args, **kwargs):
        calls[0] += 1
        return real(*args, **kwargs)

    monkeypatch.setattr(room_tone, "_pick_sample", counted)
    return calls


def _span(project: EpisodeProject, track_id: str = "host"):
    return room_tone_span(
        project, track_id, near_sec=4.25, near_source_id=None, timeline_sec=4.25, duration_sec=0.3
    )


def test_every_dialogue_track_with_media_and_no_pool_is_queued_once(tmp_path: Path) -> None:
    project = _two_speakers(tmp_path)
    project.tracks.append(Track(id="empty", label="E", role=TrackRole.DIALOGUE, media=None))
    project.tracks.append(
        Track(
            id="music",
            label="M",
            role=TrackRole.MUSIC,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    )

    assert room_tone.schedule_missing_room_tone_pools(project) == 2
    _join_pools()
    assert room_tone.read_room_tone_pool(project, "host")
    assert room_tone.read_room_tone_pool(project, "guest") is not None
    assert room_tone.schedule_missing_room_tone_pools(project) == 0


def test_a_moved_project_records_the_pool_a_fresh_import_records(tmp_path: Path) -> None:
    fresh = _two_speakers(tmp_path / "fresh")
    expected = {t: room_tone.record_room_tone_pool(fresh, t) for t in ("host", "guest")}
    assert expected["host"]

    moved_dir = tmp_path / "elsewhere" / "lab"
    shutil.copytree(tmp_path / "fresh", moved_dir)
    moved = fresh.model_copy(deep=True)
    moved.meta.workspace_dir = str(moved_dir)
    room_tone._POOLS.clear()
    # The key holds the absolute path, so a pool recorded at the old path is not this one's.
    assert room_tone.read_room_tone_pool(moved, "host") is None

    assert room_tone.schedule_missing_room_tone_pools(moved) == 2
    _join_pools()

    assert {t: room_tone.read_room_tone_pool(moved, t) for t in ("host", "guest")} == expected


def test_approve_after_the_scheduled_pool_finished_picks_nothing_live(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _two_speakers(tmp_path)
    room_tone.schedule_missing_room_tone_pools(project)
    _join_pools()
    picks = _count_picks(monkeypatch)
    loads = [0]

    def refuse(*_args, **_kwargs):
        loads[0] += 1
        raise AssertionError("a pooled pick must not read a window")

    monkeypatch.setattr(room_tone, "load_mono_window", refuse)

    assert _span(project).__class__.__name__ == "OwnQuietSample"
    assert _span(project, "guest").__class__.__name__ in {"OwnQuietSample", "SampleAbsent"}
    assert picks == [0]
    assert loads == [0]


def test_a_pool_still_pending_is_not_read_half_built_and_approve_does_not_wait(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _two_speakers(tmp_path)
    started, release = threading.Event(), threading.Event()

    def slow(*_args, **_kwargs):
        started.set()
        release.wait(60)
        return None

    monkeypatch.setattr(room_tone, "record_room_tone_pool", slow)
    assert room_tone.schedule_missing_room_tone_pools(project) == 2
    assert started.wait(30)
    monkeypatch.undo()
    monkeypatch.setattr(room_tone, "record_room_tone_pool", slow)
    picks = _count_picks(monkeypatch)

    assert room_tone.read_room_tone_pool(project, "host") is None
    selected = _span(project)

    assert picks[0] >= 1  # live picks, exactly as with no pool
    assert selected.__class__.__name__ == "OwnQuietSample"
    # A second schedule while the first is pending queues nothing.
    assert room_tone.schedule_missing_room_tone_pools(project) == 0
    release.set()
    _join_pools()


def test_scheduling_never_raises_and_never_blocks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _two_speakers(tmp_path)

    def broken(*_args, **_kwargs):
        raise RuntimeError("no key")

    monkeypatch.setattr(room_tone, "_pool_key", broken)
    assert room_tone.schedule_missing_room_tone_pools(project) == 0

    monkeypatch.undo()
    release = threading.Event()
    monkeypatch.setattr(room_tone, "record_room_tone_pool", lambda *_a: release.wait(60))
    done = threading.Event()
    worker = threading.Thread(
        target=lambda: (room_tone.schedule_missing_room_tone_pools(project), done.set())
    )
    worker.start()
    assert done.wait(10), "scheduling waited for the pool"
    release.set()
    worker.join()
    _join_pools()


def test_propose_and_approve_both_schedule_the_missing_pools(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services.document import service_base as edit_module

    ws = workspace(_blocked_filler(tmp_path, monkeypatch)[0])
    seen: list[object] = []
    monkeypatch.setattr(
        edit_module, "schedule_missing_room_tone_pools", lambda project: seen.append(project) or 0
    )
    ws.project.edit_decisions = []

    EditService(ws).propose_tighten()
    assert seen == [ws.project]

    ids = [e.id for e in ws.project.edit_decisions]
    with pytest.raises(ScopeChangedAtApproval):  # the fixture's cut is held; the schedule ran first
        EditService(ws).approve(ids)
    assert seen == [ws.project, ws.project]


def test_a_failing_schedule_does_not_fail_propose_or_approve(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services.document import service_base as edit_module

    ws = workspace(_blocked_filler(tmp_path, monkeypatch)[0])

    def broken(*_args):
        raise OSError("disk gone")

    monkeypatch.setattr(room_tone, "schedule_room_tone_pool", broken)
    ws.project.edit_decisions = []
    proposal = EditService(ws).propose_tighten()
    assert proposal.decisions
    with pytest.raises(ScopeChangedAtApproval):
        EditService(ws).approve([d.id for d in proposal.decisions])
    assert edit_module.schedule_missing_room_tone_pools(ws.project) == 0
