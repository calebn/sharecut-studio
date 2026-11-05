"""A project's room-tone pools are recorded side by side, to the pools one at a time gives."""

from __future__ import annotations

import os
import threading
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines import room_tone
from podcast_mcp.models import EpisodeProject, MediaAsset, Track, TrackRole
from test_room_tone import DURATION_SEC, _host_audio, _noise, _write_wav
from test_room_tone import _project as _room_project
from test_room_tone_pool_on_open import _join_pools, _two_speakers

pytestmark = pytest.mark.usefixtures("real_room_tone_scheduling")


def _three_speakers(tmp_path: Path) -> EpisodeProject:
    project = _two_speakers(tmp_path)
    _write_wav(tmp_path / "raw" / "guest2.wav", _noise(-62.0, seed=3))
    project.tracks.append(
        Track(
            id="guest2",
            label="Guest2",
            role=TrackRole.DIALOGUE,
            speaker="Guest2",
            media=MediaAsset(path="raw/guest2.wav", duration_sec=DURATION_SEC),
        )
    )
    return project


def _slow_decode(monkeypatch: pytest.MonkeyPatch) -> list[Path]:
    """Every recording decode for a floor, held until a second decode starts, so two decodes overlap."""
    calls: list[Path] = []
    real = room_tone.held_mono_full
    overlapped = threading.Event()
    lock = threading.Lock()

    def slow(path: Path, **kwargs):
        with lock:
            calls.append(path)
            if len(calls) > 1:
                overlapped.set()
        overlapped.wait(timeout=0.5)
        return real(path, **kwargs)

    monkeypatch.setattr(room_tone, "held_mono_full", slow)
    return calls


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
    assert expected["host"]

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
    calls = _slow_decode(monkeypatch)
    room_tone.ensure_room_tone_pools(live, ["host", "guest"])

    assert sorted(p.name for p in calls) == ["guest.wav", "host.wav"]


def test_each_recording_is_measured_once_by_the_background_thread(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    live = _two_speakers(tmp_path)
    room_tone._track_floor.cache_clear()
    calls = _slow_decode(monkeypatch)
    assert room_tone.schedule_room_tone_pools(live) == 2
    _join_pools()

    assert sorted(p.name for p in calls) == ["guest.wav", "host.wav"]


def test_recorded_pools_are_read_without_measuring_any_floor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    live = _two_speakers(tmp_path)
    room_tone.ensure_room_tone_pools(live, ["host", "guest"])
    room_tone._track_floor.cache_clear()
    calls = _slow_decode(monkeypatch)

    room_tone.ensure_room_tone_pools(live, ["host", "guest"])

    assert calls == []


def test_two_missing_pools_of_three_are_recorded_with_each_floor_measured_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    live = _three_speakers(tmp_path)
    room_tone.record_room_tone_pool(live, "host")
    room_tone._track_floor.cache_clear()
    calls = _slow_decode(monkeypatch)

    room_tone.ensure_room_tone_pools(live, ["host", "guest", "guest2"])

    assert sorted(p.name for p in calls) == ["guest.wav", "guest2.wav", "host.wav"]


def test_two_missing_pools_have_their_floors_measured_together_first(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    live = _two_speakers(tmp_path)
    warmed: list[EpisodeProject] = []
    real = room_tone._warm_floors

    def warm(project: EpisodeProject) -> None:
        warmed.append(project)
        real(project)

    monkeypatch.setattr(room_tone, "_warm_floors", warm)
    room_tone.ensure_room_tone_pools(live, ["host", "guest"])

    assert len(warmed) == 1


def test_a_request_during_the_background_recording_does_not_measure_the_floors_again(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    live = _two_speakers(tmp_path)
    room_tone._track_floor.cache_clear()
    calls = _slow_decode(monkeypatch)

    assert room_tone.schedule_room_tone_pools(live) == 2
    room_tone.ensure_room_tone_pools(live, ["host", "guest"])
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
    monkeypatch.setattr(Path, "stat", real_stat)

    assert sorted(p.name for p in tmp_path.glob("*.json")) == ["2.json", "3.json"]


def test_a_noise_only_project_still_records_empty_pools_together(tmp_path: Path) -> None:
    silence = np.zeros(len(_host_audio()))
    live = _room_project(tmp_path, host=silence, guest=silence)
    room_tone.ensure_room_tone_pools(live, ["host", "guest"])

    assert room_tone.read_room_tone_pool(live, "host") == ()
    assert room_tone.read_room_tone_pool(live, "guest") == ()


def test_a_track_whose_pool_key_cannot_be_read_does_not_raise_from_ensure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    live = _two_speakers(tmp_path)

    def broken(*args, **kwargs):
        raise RuntimeError("probe failed")

    monkeypatch.setattr(room_tone, "_pool_key", broken)
    room_tone.ensure_room_tone_pools(live, ["host", "guest"])


def test_two_threads_asking_for_one_cold_floor_decode_the_file_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "cold.wav"
    _write_wav(path, _noise(-62.0, seed=5))
    room_tone._track_floor.cache_clear()
    calls = _slow_decode(monkeypatch)
    start = threading.Barrier(2)
    reads: list[room_tone.FloorRead] = []

    def ask() -> None:
        start.wait()
        reads.append(room_tone.track_floor(path))

    threads = [threading.Thread(target=ask) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(calls) == 1
    assert len(reads) == 2 and reads[0] == reads[1]
    assert not room_tone._FLOOR_FLIGHTS
