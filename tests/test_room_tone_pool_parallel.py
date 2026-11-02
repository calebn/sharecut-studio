"""A project's room-tone pools are recorded side by side, to the same pools as one at a time."""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines import room_tone
from podcast_mcp.models import EpisodeProject
from test_room_tone import _host_audio, _noise
from test_room_tone import _project as _room_project

pytestmark = pytest.mark.usefixtures("real_room_tone_scheduling")


def _two_speakers(tmp_path: Path) -> EpisodeProject:
    return _room_project(tmp_path, host=_host_audio(), guest=_noise(-64.0, seed=2))


def _join_pools() -> None:
    for thread in threading.enumerate():
        if thread.name.startswith("room-tone-pool-"):
            thread.join(60)


def _sequential_pools(project: EpisodeProject) -> dict[str, tuple[room_tone.Sample, ...] | None]:
    return {t.id: room_tone._record_room_tone_pool(project, t.id) for t in project.tracks}


def test_ensure_records_the_pools_a_track_at_a_time_would(tmp_path: Path) -> None:
    reference = _two_speakers(tmp_path / "ref")
    expected = _sequential_pools(reference)
    assert expected["host"]

    room_tone._track_floor.cache_clear()
    live = _two_speakers(tmp_path / "live")
    room_tone.ensure_room_tone_pools(live, ["host", "guest"])

    assert {t.id: room_tone.read_room_tone_pool(live, t.id) for t in live.tracks} == expected


def test_the_background_thread_records_the_pools_a_track_at_a_time_would(tmp_path: Path) -> None:
    reference = _two_speakers(tmp_path / "ref")
    expected = _sequential_pools(reference)

    room_tone._track_floor.cache_clear()
    live = _two_speakers(tmp_path / "live")
    assert room_tone.schedule_room_tone_pools(live) == 2
    _join_pools()

    assert {t.id: room_tone.read_room_tone_pool(live, t.id) for t in live.tracks} == expected


def test_each_recording_is_measured_once_when_the_pools_are_recorded_together(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    live = _two_speakers(tmp_path)
    room_tone._track_floor.cache_clear()
    calls: list[Path] = []
    real = room_tone.held_mono_full

    def slow(path: Path, **kwargs):
        calls.append(path)
        time.sleep(0.4)
        return real(path, **kwargs)

    monkeypatch.setattr(room_tone, "held_mono_full", slow)
    room_tone.ensure_room_tone_pools(live, ["host", "guest"])

    assert sorted(p.name for p in calls) == ["guest.wav", "host.wav"]


def test_each_recording_is_measured_once_by_the_background_thread(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    live = _two_speakers(tmp_path)
    room_tone._track_floor.cache_clear()
    calls: list[Path] = []
    real = room_tone.held_mono_full

    def slow(path: Path, **kwargs):
        calls.append(path)
        time.sleep(0.4)
        return real(path, **kwargs)

    monkeypatch.setattr(room_tone, "held_mono_full", slow)
    assert room_tone.schedule_room_tone_pools(live) == 2
    _join_pools()

    assert sorted(p.name for p in calls) == ["guest.wav", "host.wav"]


def test_the_tracks_of_the_background_thread_are_recorded_at_the_same_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    live = _two_speakers(tmp_path)
    meeting = threading.Barrier(2, timeout=20)
    real = room_tone._no_foreign_voice

    def meet(project: EpisodeProject, track_id: str):
        meeting.wait()
        return real(project, track_id)

    monkeypatch.setattr(room_tone, "_no_foreign_voice", meet)
    assert room_tone.schedule_room_tone_pools(live) == 2
    _join_pools()

    assert not meeting.broken
    assert all(room_tone.read_room_tone_pool(live, t.id) is not None for t in live.tracks)


def test_one_track_failing_leaves_the_other_recorded_and_both_released(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    live = _two_speakers(tmp_path)
    real = room_tone._no_foreign_voice

    def broken(project: EpisodeProject, track_id: str):
        if track_id == "guest":
            raise RuntimeError("unreadable")
        return real(project, track_id)

    monkeypatch.setattr(room_tone, "_no_foreign_voice", broken)
    assert room_tone.schedule_room_tone_pools(live) == 2
    _join_pools()

    assert room_tone.read_room_tone_pool(live, "host") is not None
    assert room_tone.read_room_tone_pool(live, "guest") is None
    assert not room_tone._PENDING_POOLS


def test_pool_records_pruned_while_another_thread_removes_one_are_skipped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(room_tone, "_POOL_RECORDS_KEPT", 2)
    for index in range(4):
        path = tmp_path / f"{index}.json"
        path.write_text("{}")
        stamp = 1_000_000 + index

        os.utime(path, (stamp, stamp))
    gone = tmp_path / "1.json"
    real_stat = Path.stat

    def racing(self: Path, *args, **kwargs):
        if self == gone:
            gone.unlink(missing_ok=True)
        return real_stat(self, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", racing)
    room_tone._prune_pool_records(tmp_path)
    monkeypatch.undo()

    assert sorted(p.name for p in tmp_path.glob("*.json")) == ["2.json", "3.json"]


def test_a_noise_only_project_still_records_empty_pools_together(tmp_path: Path) -> None:
    live = _room_project(
        tmp_path,
        host=np.zeros(len(_host_audio())),
        guest=np.zeros(len(_host_audio())),
    )
    room_tone.ensure_room_tone_pools(live, ["host", "guest"])

    assert room_tone.read_room_tone_pool(live, "host") == ()
    assert room_tone.read_room_tone_pool(live, "guest") == ()
