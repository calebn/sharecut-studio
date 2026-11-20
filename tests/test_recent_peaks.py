"""Real peaks on Home's Recent cards, folded from waveform pyramids already on disk."""

from __future__ import annotations

import json
import logging
import os
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines import waveform_media, waveform_pyramid
from podcast_mcp.engines.ffmpeg import AudioProbe
from podcast_mcp.engines.waveform_pyramid import (
    PyramidLevel,
    PyramidMeta,
    write_synthetic_pyramid,
)
from podcast_mcp.models import load_project
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import recent_peaks
from podcast_mcp.services.app import recent_projects as recent
from podcast_mcp.services.app.workspace import ProjectWorkspace
from podcast_mcp.services.collaboration import review_peaks
from podcast_mcp.util import peak_bins
from podcast_mcp.util.fingerprint import file_stamp

RATE = 8000
SECONDS = 100


class _Probe:
    def __init__(self) -> None:
        self.several = False
        self.failures = 0
        self.calls: list[Path] = []

    def __call__(self, path: Path) -> AudioProbe | None:
        self.calls.append(path)
        if self.failures:
            self.failures -= 1
            return None
        return AudioProbe(
            duration_sec=float(SECONDS),
            sample_rate=RATE,
            channels=1,
            audio_start_sec=0.0,
            rebases_audio_reads=False,
            audio_stream_count=2 if self.several else 1,
        )

    def fail(self, times: int = 10**6) -> None:
        self.failures = times

    def heal(self) -> None:
        self.failures = 0


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture(autouse=True)
def probe(monkeypatch) -> _Probe:
    stub = _Probe()
    monkeypatch.setattr(recent_peaks, "probe_media", stub)
    monkeypatch.setattr(waveform_media, "probe_media", stub)
    return stub


@pytest.fixture(autouse=True)
def clock(monkeypatch) -> _Clock:
    fake = _Clock()
    monkeypatch.setattr(recent_peaks, "_clock", fake)
    return fake


def _make(tmp_path: Path, name: str = "ep") -> Path:
    with write_grant(WriteGrantKind.DISPATCHER):
        return ProjectWorkspace.create(tmp_path / name, name=name).path


def _edit(path: Path, edit) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    edit(data)
    path.write_text(json.dumps(data), encoding="utf-8")


def _clip(cid="c1", track="t", start=0.0, end=float(SECONDS), at=0.0, **extra) -> dict:
    return {
        "id": cid,
        "track_id": track,
        "source_start": start,
        "source_end": end,
        "timeline_start": at,
        **extra,
    }


def _layout(project: Path, clips: list[dict], *, duration=float(SECONDS), sources=()) -> None:
    media = project.parent / "raw"
    media.mkdir(exist_ok=True)
    (media / "t.wav").write_bytes(b"not decoded")
    for sid in sources:
        (media / f"{sid}.wav").write_bytes(b"not decoded")

    def edit(data: dict) -> None:
        data["timeline"]["tracks"] = [{"id": "t", "label": "t", "media": {"path": "raw/t.wav"}}]
        data["timeline"]["clips"] = clips
        data["timeline"]["duration_sec"] = duration
        data["sources"] = [{"id": sid, "path": f"raw/{sid}.wav"} for sid in sources]

    _edit(project, edit)


def _pyramid(project: Path, ref: str, *, seed=1, seconds=SECONDS, silent=False) -> Path:
    loaded = load_project(project)
    entry = waveform_media.resolve_media_refs(loaded, [ref]).refs[ref]
    target = waveform_media.pyramid_target(loaded.artifacts_dir(), ref, entry)
    target.out.parent.mkdir(parents=True, exist_ok=True)
    return write_synthetic_pyramid(
        target.out, sample_rate=RATE, total_frames=RATE * seconds, seed=seed, silent=silent
    )


def _peaks(project: Path) -> list[float]:
    recent.record_recent(project)
    return recent.recent_project_cards()[0]["peaks"]


def test_ready_pyramid_gives_a_normalized_column_list(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t")
    peaks = _peaks(project)
    assert len(peaks) == recent_peaks.COLUMNS
    assert max(peaks) == 1.0
    assert all(0.0 <= v <= 1.0 for v in peaks)
    assert len(set(peaks)) > 5


def test_a_clip_covering_half_the_timeline_leaves_the_rest_flat(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip(end=50.0)])
    _pyramid(project, "track:t")
    peaks = _peaks(project)
    half = recent_peaks.COLUMNS // 2
    assert max(peaks[:half]) > 0.0
    assert peaks[half + 1 :] == [0.0] * (recent_peaks.COLUMNS - half - 1)


def test_a_clip_shifted_on_the_timeline_lands_in_later_columns(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip(end=50.0, at=50.0)])
    _pyramid(project, "track:t")
    peaks = _peaks(project)
    half = recent_peaks.COLUMNS // 2
    assert peaks[: half - 1] == [0.0] * (half - 1)
    assert max(peaks[half:]) > 0.0


def test_a_clip_past_the_media_end_clamps_instead_of_going_flat(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip(end=float(SECONDS))])
    _pyramid(project, "track:t", seconds=40)
    peaks = _peaks(project)
    assert len(peaks) == recent_peaks.COLUMNS
    assert max(peaks) > 0.0
    assert peaks[-1] == 0.0


def test_a_timed_clip_still_folds(tmp_path):
    project = _make(tmp_path)
    timing = {"steps": [{"at": 50.0, "delta_sec": 2.0}]}
    _layout(project, [_clip(timing=timing)], duration=float(SECONDS + 2))
    _pyramid(project, "track:t")
    assert len(_peaks(project)) == recent_peaks.COLUMNS


def test_two_tracks_fill_their_own_stretches_of_the_timeline(tmp_path):
    project = _make(tmp_path)

    def edit(data: dict) -> None:
        data["timeline"]["tracks"] = [
            {"id": "t", "label": "t", "media": {"path": "raw/t.wav"}},
            {"id": "u", "label": "u", "media": {"path": "raw/u.wav"}},
        ]
        data["timeline"]["clips"] = [_clip(end=50.0), _clip("c2", "u", end=50.0, at=50.0)]
        data["timeline"]["duration_sec"] = float(SECONDS)

    (project.parent / "raw").mkdir(exist_ok=True)
    for name in ("t", "u"):
        (project.parent / "raw" / f"{name}.wav").write_bytes(b"x")
    _edit(project, edit)
    _pyramid(project, "track:t", seed=1)
    _pyramid(project, "track:u", seed=2)
    both = _peaks(project)
    half = recent_peaks.COLUMNS // 2
    assert max(both[: half - 1]) > 0.0
    assert max(both[half + 1 :]) > 0.0


def test_a_source_clip_reads_the_source_pyramid_not_the_track_one(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip(source_id="s1")], sources=("s1",))
    _pyramid(project, "track:t")
    assert _peaks(project) == []
    _pyramid(project, "source:s1")
    assert len(_peaks(project)) == recent_peaks.COLUMNS


def test_a_track_with_no_media_but_a_source_clip_draws(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip(source_id="s1")], sources=("s1",))
    _edit(project, lambda d: d["timeline"]["tracks"][0].pop("media"))
    _pyramid(project, "source:s1")
    assert len(_peaks(project)) == recent_peaks.COLUMNS


def test_an_unused_track_without_a_pyramid_does_not_flatten_the_card(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    (project.parent / "raw" / "idle.wav").write_bytes(b"x")
    _edit(
        project,
        lambda d: d["timeline"]["tracks"].append(
            {"id": "idle", "label": "idle", "media": {"path": "raw/idle.wav"}}
        ),
    )
    _pyramid(project, "track:t")
    assert len(_peaks(project)) == recent_peaks.COLUMNS


def _no_pyramid(project: Path) -> None:
    return None


def _corrupt(project: Path) -> None:
    path = _pyramid(project, "track:t")
    path.write_bytes(b"WFPK" + b"\0" * 10)


def _silent(project: Path) -> None:
    _pyramid(project, "track:t", silent=True)


def _zero_frames(project: Path) -> None:
    _pyramid(project, "track:t", seconds=0)


@pytest.mark.parametrize(
    ("clips", "duration", "prepare"),
    [
        pytest.param([_clip()], float(SECONDS), _no_pyramid, id="missing-pyramid"),
        pytest.param([_clip()], 0.0, lambda p: _pyramid(p, "track:t"), id="zero-duration"),
        pytest.param([_clip()], None, lambda p: _pyramid(p, "track:t"), id="no-duration"),
        pytest.param([], float(SECONDS), lambda p: _pyramid(p, "track:t"), id="no-clips"),
        pytest.param([_clip()], float(SECONDS), _corrupt, id="corrupt-pyramid"),
        pytest.param([_clip()], float(SECONDS), _silent, id="silent-pyramid"),
        pytest.param([_clip()], float(SECONDS), _zero_frames, id="empty-pyramid"),
        pytest.param(
            [_clip(source_id="gone")], float(SECONDS), lambda p: _pyramid(p, "track:t"), id="source"
        ),
        pytest.param(
            [_clip(track="nope")], float(SECONDS), lambda p: _pyramid(p, "track:t"), id="track"
        ),
        pytest.param(
            [_clip(end=0.0)], float(SECONDS), lambda p: _pyramid(p, "track:t"), id="zero-width"
        ),
    ],
)
def test_flat_fallbacks_give_an_empty_list(tmp_path, clips, duration, prepare):
    project = _make(tmp_path)
    _layout(project, clips, duration=duration)
    prepare(project)
    peaks = _peaks(project)
    assert peaks == []
    assert recent.recent_project_cards()[0]["chip"]["text"] != "Needs attention"


def test_non_finite_clip_times_give_an_empty_list(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t")
    text = project.read_text(encoding="utf-8").replace('"source_end": 100.0', '"source_end": NaN')
    project.write_text(text, encoding="utf-8")
    recent.record_recent(project)
    card = recent.recent_project_cards()[0]
    assert card["peaks"] == []
    assert card["chip"]["text"] != "Needs attention"


def test_a_pyramid_that_appears_later_refreshes_the_cached_card(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    assert _peaks(project) == []
    _pyramid(project, "track:t")
    assert len(recent.recent_project_cards()[0]["peaks"]) == recent_peaks.COLUMNS


def test_a_rebuilt_pyramid_replaces_the_cached_peaks(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t", seed=1)
    first = _peaks(project)
    _pyramid(project, "track:t", seed=9)
    assert recent.recent_project_cards()[0]["peaks"] != first


def test_replaced_media_stops_using_the_old_pyramid(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t")
    assert _peaks(project)
    media = project.parent / "raw" / "t.wav"
    media.write_bytes(b"different media bytes")
    assert recent.recent_project_cards()[0]["peaks"] == []


def test_an_edit_to_the_project_replans_the_fold(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t")
    full = _peaks(project)
    _edit(project, lambda d: d["timeline"]["clips"][0].update(source_end=50.0))
    assert recent.recent_project_cards()[0]["peaks"] != full


def test_an_unchanged_project_is_planned_once(tmp_path, monkeypatch):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t")
    calls = []
    real = recent_peaks.load_project
    monkeypatch.setattr(recent_peaks, "load_project", lambda p: calls.append(p) or real(p))
    _peaks(project)
    recent.recent_project_cards()
    assert len(calls) == 1


def test_a_peaks_fault_leaves_the_rest_of_the_card(tmp_path, monkeypatch):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t")
    monkeypatch.setattr(recent_peaks, "read_meta", lambda p: (_ for _ in ()).throw(RuntimeError))
    recent.record_recent(project)
    card = recent.recent_project_cards()[0]
    assert card["peaks"] == []
    assert card["chip"]["text"] == "Edited"
    assert card["duration_sec"] == float(SECONDS)


def test_a_forgotten_project_drops_its_cached_peaks(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t")
    _peaks(project)
    assert recent._PEAKS
    recent.forget_recent(project)
    recent.recent_project_cards()
    assert not recent._PEAKS


def test_bin_peaks_lives_in_util_and_review_peaks_reexports_it():
    assert review_peaks.bin_peaks is peak_bins.bin_peaks


COLUMNS = recent_peaks.COLUMNS
BIN_SEC = 0.032


def _cells(*cells: tuple[int, int, int]) -> np.ndarray:
    bins = np.zeros((max(c[0] for c in cells) + 1, 3), dtype="<i2")
    for index, low, high in cells:
        bins[index] = (low, high, 0)
    return bins


def _craft(monkeypatch, by_pyramid: dict[Path, np.ndarray], *, sliced: bool = False) -> None:
    by_name = {path.name: bins for path, bins in by_pyramid.items()}

    def read(path, meta, level, start, count):
        bins = by_name[path.name]
        return (bins[start : start + count] if sliced else bins).tobytes()

    monkeypatch.setattr(recent_peaks, "read_bins", read)


def _lit(peaks: list[float]) -> dict[int, float]:
    return {i: v for i, v in enumerate(peaks) if v}


def _meta(rate: int, spps: list[int]) -> PyramidMeta:
    levels = tuple(PyramidLevel(spp=spp, bins=1, data_offset=0) for spp in spps)
    return PyramidMeta(
        version=1,
        header_bytes=0,
        sample_rate=rate,
        channels=1,
        total_frames=rate,
        base_spp=spps[0],
        level_factor=2,
        bins_per_tile=1,
        levels=levels,
    )


@pytest.mark.parametrize(
    ("column_sec", "level"),
    [(0.5, 0), (1.0, 0), (1.9, 0), (2.0, 1), (3.9, 1), (4.0, 2), (40.0, 2)],
)
def test_the_level_is_the_coarsest_whose_bin_fits_the_column(column_sec, level):
    meta = _meta(64, [64, 128, 256])
    assert recent_peaks._level_for(meta, column_sec) == level


@pytest.mark.parametrize(("duration", "level"), [(100.0, 1), (3.0, 0)])
def test_the_chosen_level_is_the_only_one_read(tmp_path, monkeypatch, duration, level):
    project = _make(tmp_path)
    _layout(project, [_clip(end=duration)], duration=duration)
    _pyramid(project, "track:t")
    seen: list[int] = []
    real = recent_peaks.read_bins

    def spy(path, meta, chosen, start, count):
        seen.append(chosen)
        return real(path, meta, chosen, start, count)

    monkeypatch.setattr(recent_peaks, "read_bins", spy)
    assert _peaks(project)
    assert seen == [level]


@pytest.mark.parametrize(
    ("cells", "expected"),
    [
        pytest.param([(0, -1000, 10), (40, -500, 20)], {0: 1.0, 1: 0.5}, id="min-larger-than-max"),
        pytest.param([(0, -10, 1000), (40, -20, 500)], {0: 1.0, 1: 0.5}, id="max-larger-than-min"),
        pytest.param([(0, -32768, 0), (40, 0, 16384)], {0: 1.0, 1: 0.5}, id="int16-minimum"),
        pytest.param([(0, 0, 20000), (1, 0, 10000), (40, 0, 15000)], {0: 1.0, 1: 0.75}, id="max"),
        pytest.param([(0, 0, 10000), (1, 0, 20000), (40, 0, 15000)], {0: 1.0, 1: 0.75}, id="max2"),
    ],
)
def test_a_column_takes_the_largest_absolute_extreme_of_its_bins(
    tmp_path, monkeypatch, cells, expected
):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    path = _pyramid(project, "track:t")
    _craft(monkeypatch, {path: _cells(*cells)})
    assert _lit(_peaks(project)) == expected


@pytest.mark.parametrize(("bin_index", "column"), [(0, 0), (31, 0), (33, 1), (65, 2), (3124, 95)])
def test_a_bin_lands_in_the_column_of_its_centre(tmp_path, monkeypatch, bin_index, column):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    path = _pyramid(project, "track:t")
    _craft(monkeypatch, {path: _cells((bin_index, 0, 9000))})
    assert _lit(_peaks(project)) == {column: 1.0}


def test_a_bin_past_the_timeline_clamps_into_the_last_column(tmp_path, monkeypatch):
    project = _make(tmp_path)
    _layout(project, [_clip()], duration=50.0)
    path = _pyramid(project, "track:t")
    _craft(monkeypatch, {path: _cells((1562, 0, 9000))})
    assert _lit(_peaks(project)) == {COLUMNS - 1: 1.0}


def test_bins_far_outside_the_timeline_are_dropped(tmp_path, monkeypatch):
    project = _make(tmp_path)
    _layout(project, [_clip()], duration=50.0)
    path = _pyramid(project, "track:t")
    _craft(monkeypatch, {path: _cells((300, 0, 4000), (1700, 0, 9000), (2500, 0, 9000))})
    assert _lit(_peaks(project)) == {18: 1.0}


def test_source_start_shifts_the_bins_onto_the_timeline(tmp_path, monkeypatch):
    project = _make(tmp_path)
    _layout(project, [_clip(start=48.0, end=100.0, at=0.0)])
    path = _pyramid(project, "track:t")
    _craft(monkeypatch, {path: _cells((1565, 0, 9000))})
    assert _lit(_peaks(project)) == {2: 1.0}


def test_bins_before_the_clip_start_are_left_out(tmp_path, monkeypatch):
    project = _make(tmp_path)
    _layout(project, [_clip(start=10.0, end=100.0, at=0.0)])
    path = _pyramid(project, "track:t")
    _craft(monkeypatch, {path: _cells((100, 0, 9000), (500, 0, 4500))})
    assert _lit(_peaks(project)) == {5: 1.0}


def test_a_clip_edge_inside_a_bin_keeps_that_bin(tmp_path, monkeypatch):
    project = _make(tmp_path)
    _layout(project, [_clip(start=0.040, end=0.045, at=0.0)])
    path = _pyramid(project, "track:t")
    _craft(monkeypatch, {path: _cells((1, 0, 9000))})
    assert _lit(_peaks(project)) == {0: 1.0}


def test_each_ref_folds_only_its_own_pieces(tmp_path, monkeypatch):
    project = _make(tmp_path)
    _layout(
        project,
        [_clip(end=50.0), _clip("c2", source_id="s1", end=50.0, at=50.0)],
        sources=("s1",),
    )
    track = _pyramid(project, "track:t")
    source = _pyramid(project, "source:s1")
    _craft(
        monkeypatch,
        {track: _cells((300, 0, 20000)), source: _cells((600, 0, 10000))},
    )
    assert _lit(_peaks(project)) == {9: 1.0, 66: 0.5}


def test_overlapping_tracks_take_the_louder_not_the_sum(tmp_path, monkeypatch):
    project = _make(tmp_path)

    def edit(data: dict) -> None:
        data["timeline"]["tracks"] = [
            {"id": "t", "label": "t", "media": {"path": "raw/t.wav"}},
            {"id": "u", "label": "u", "media": {"path": "raw/u.wav"}},
        ]
        data["timeline"]["clips"] = [_clip(), _clip("c2", "u")]
        data["timeline"]["duration_sec"] = float(SECONDS)

    (project.parent / "raw").mkdir(exist_ok=True)
    for name in ("t", "u"):
        (project.parent / "raw" / f"{name}.wav").write_bytes(b"x")
    _edit(project, edit)
    first = _pyramid(project, "track:t")
    second = _pyramid(project, "track:u")
    _craft(
        monkeypatch,
        {first: _cells((0, 0, 20000), (40, 0, 15000)), second: _cells((0, 0, 10000))},
    )
    assert _lit(_peaks(project)) == {0: 1.0, 1: 0.75}


def test_a_partial_pyramid_set_stays_flat(tmp_path):
    project = _make(tmp_path)

    def edit(data: dict) -> None:
        data["timeline"]["tracks"] = [
            {"id": "t", "label": "t", "media": {"path": "raw/t.wav"}},
            {"id": "u", "label": "u", "media": {"path": "raw/u.wav"}},
        ]
        data["timeline"]["clips"] = [_clip(end=50.0), _clip("c2", "u", end=50.0, at=50.0)]
        data["timeline"]["duration_sec"] = float(SECONDS)

    (project.parent / "raw").mkdir(exist_ok=True)
    for name in ("t", "u"):
        (project.parent / "raw" / f"{name}.wav").write_bytes(b"x")
    _edit(project, edit)
    _pyramid(project, "track:t")
    assert _peaks(project) == []
    _pyramid(project, "track:u")
    assert len(recent.recent_project_cards()[0]["peaks"]) == COLUMNS


def test_a_timed_gap_leaves_its_timeline_span_flat(tmp_path, monkeypatch):
    project = _make(tmp_path)
    timing = {"steps": [{"at": 50.0, "delta_sec": 30.0}]}
    _layout(project, [_clip(timing=timing)], duration=130.0)
    path = _pyramid(project, "track:t")
    cells = [(i, 0, 9000) for i in range(0, 3125, 20)]
    _craft(monkeypatch, {path: _cells(*cells)})
    peaks = _peaks(project)
    column_sec = 130.0 / COLUMNS
    gap = range(int(50.0 / column_sec) + 2, int(80.0 / column_sec) - 1)
    assert gap
    assert all(peaks[i] == 0.0 for i in gap)
    assert peaks[int(30.0 / column_sec)] == 1.0
    assert peaks[int(100.0 / column_sec)] == 1.0


def test_a_zero_width_clip_at_an_unaligned_source_time_adds_nothing(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip(start=50.00123, end=50.00123, at=10.0)])
    _pyramid(project, "track:t")
    assert _peaks(project) == []


def test_the_cached_peaks_are_not_the_returned_list(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t")
    first = _peaks(project)
    expected = list(first)
    first[0] = 99.0
    first.clear()
    second = recent.recent_project_cards()[0]["peaks"]
    assert second == expected
    second[0] = 99.0
    assert recent.recent_project_cards()[0]["peaks"] == expected


def test_a_pyramid_rebuilt_during_the_fold_is_not_cached_as_current(tmp_path, monkeypatch):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t", seed=1)
    real = recent_peaks.fold_peaks

    def fold_then_rebuild(plan, ready):
        out = real(plan, ready)
        _pyramid(project, "track:t", seed=9)
        return out

    monkeypatch.setattr(recent_peaks, "fold_peaks", fold_then_rebuild)
    first = _peaks(project)
    monkeypatch.setattr(recent_peaks, "fold_peaks", real)
    second = recent.recent_project_cards()[0]["peaks"]
    assert first
    assert second != first


def test_a_pyramid_that_changes_size_alone_refreshes_the_card(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    path = _pyramid(project, "track:t", seconds=SECONDS)
    first = _peaks(project)
    stat = path.stat()
    _pyramid(project, "track:t", seconds=SECONDS - 30)
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    assert path.stat().st_size != stat.st_size
    assert recent.recent_project_cards()[0]["peaks"] != first


def test_a_pyramid_under_a_new_name_refreshes_the_card_when_size_and_mtime_match(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    old = _pyramid(project, "track:t", seed=1)
    first = _peaks(project)
    stat = old.stat()
    media = project.parent / "raw" / "t.wav"
    media.write_bytes(b"different media bytes")
    new = _pyramid(project, "track:t", seed=9)
    os.utime(new, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    assert new.name != old.name
    assert new.stat().st_size == stat.st_size
    assert recent.recent_project_cards()[0]["peaks"] != first


def test_a_pyramid_that_becomes_ready_refreshes_a_card_with_another_pyramid_waiting(tmp_path):
    project = _make(tmp_path)

    def edit(data: dict) -> None:
        data["timeline"]["tracks"] = [
            {"id": "t", "label": "t", "media": {"path": "raw/t.wav"}},
            {"id": "u", "label": "u", "media": {"path": "raw/u.wav"}},
        ]
        data["timeline"]["clips"] = [_clip(end=50.0), _clip("c2", "u", end=50.0, at=50.0)]
        data["timeline"]["duration_sec"] = float(SECONDS)

    (project.parent / "raw").mkdir(exist_ok=True)
    for name in ("t", "u"):
        (project.parent / "raw" / f"{name}.wav").write_bytes(b"x")
    _edit(project, edit)
    assert _peaks(project) == []
    _pyramid(project, "track:t")
    assert recent.recent_project_cards()[0]["peaks"] == []
    _pyramid(project, "track:u")
    assert len(recent.recent_project_cards()[0]["peaks"]) == COLUMNS


def test_media_that_vanishes_after_the_plan_is_flat_and_logs_once(tmp_path, caplog):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t")
    assert _peaks(project)
    (project.parent / "raw" / "t.wav").unlink()
    with caplog.at_level(logging.DEBUG, logger=recent.__name__):
        cards = [recent.recent_project_cards()[0] for _ in range(4)]
    assert all(card["peaks"] == [] for card in cards)
    assert all(card["chip"]["text"] != "Needs attention" for card in cards)
    warned = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert len(warned) == 1
    assert len(caplog.records) == 4


def _media(project: Path) -> Path:
    return (project.parent / "raw" / "t.wav").resolve()


def test_a_warm_list_probes_no_media(tmp_path, probe):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t")
    probe.calls.clear()
    first = _peaks(project)
    assert first
    assert probe.calls == [_media(project)]
    for _ in range(3):
        assert recent.recent_project_cards()[0]["peaks"] == first
    assert probe.calls == [_media(project)]


def test_an_unprobeable_media_file_is_not_probed_again_within_30_seconds(
    tmp_path, probe, clock, caplog
):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    probe.fail()
    probe.calls.clear()
    with caplog.at_level(logging.DEBUG, logger=recent.__name__):
        assert _peaks(project) == []
    assert _fault_records(caplog) == []
    assert len(probe.calls) == 1
    clock.now += 29.9
    for _ in range(3):
        assert recent.recent_project_cards()[0]["peaks"] == []
    assert len(probe.calls) == 1
    assert not recent_peaks._MEDIA_KEYS


def test_an_unprobeable_media_file_is_probed_again_after_30_seconds(tmp_path, probe, clock):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    probe.fail()
    probe.calls.clear()
    _peaks(project)
    clock.now += 30.0
    assert recent.recent_project_cards()[0]["peaks"] == []
    assert len(probe.calls) == 2
    recent.recent_project_cards()
    assert len(probe.calls) == 2
    clock.now += 30.0
    recent.recent_project_cards()
    assert len(probe.calls) == 3
    assert not recent_peaks._MEDIA_KEYS


def test_a_media_file_that_changes_is_probed_at_once_after_a_failure(tmp_path, probe, clock):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    probe.fail()
    probe.calls.clear()
    _peaks(project)
    assert len(probe.calls) == 1
    media = project.parent / "raw" / "t.wav"
    media.write_bytes(b"a different size")
    recent.recent_project_cards()
    assert len(probe.calls) == 2
    recent.recent_project_cards()
    assert len(probe.calls) == 2


def test_a_media_file_with_a_new_mtime_is_probed_at_once_after_a_failure(tmp_path, probe, clock):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    probe.fail()
    probe.calls.clear()
    _peaks(project)
    media = project.parent / "raw" / "t.wav"
    stat = media.stat()
    os.utime(media, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))
    recent.recent_project_cards()
    assert len(probe.calls) == 2


def test_a_failed_probe_of_another_rel_path_is_not_served_from_the_negative_cache(tmp_path, probe):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    entry = waveform_media.resolve_media_refs(load_project(project), ["track:t"]).refs["track:t"]
    probe.fail()
    probe.calls.clear()
    assert recent_peaks._media_key(entry) is None
    assert recent_peaks._media_key(replace(entry, rel_path="elsewhere/t.wav")) is None
    assert len(probe.calls) == 2


def test_the_probe_that_fails_first_never_pins_the_key_of_a_multi_stream_file(
    tmp_path, probe, clock
):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    probe.several = True
    _pyramid(project, "track:t")
    probe.calls.clear()
    probe.fail(1)
    assert _peaks(project) == []
    assert len(probe.calls) == 1
    assert not recent_peaks._MEDIA_KEYS
    clock.now += 30.0
    assert len(recent.recent_project_cards()[0]["peaks"]) == COLUMNS
    assert len(probe.calls) == 2
    entry = waveform_media.resolve_media_refs(load_project(project), ["track:t"]).refs["track:t"]
    stat, key = recent_peaks._MEDIA_KEYS[_media(project)]
    assert key == waveform_media.current_key(entry)
    plain = waveform_media.media_key(entry.rel_path, *stat[1:])
    assert key != plain


def test_a_probe_that_fails_once_fills_the_card_in_with_no_stat_change(tmp_path, probe, clock):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t")
    probe.fail(1)
    assert _peaks(project) == []
    assert recent.recent_project_cards()[0]["peaks"] == []
    clock.now += 30.0
    assert len(recent.recent_project_cards()[0]["peaks"]) == COLUMNS
    assert not recent_peaks._FAILED_PROBES


def test_a_successful_probe_is_cached_per_stat(tmp_path, probe):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t")
    probe.calls.clear()
    _peaks(project)
    media = project.parent / "raw" / "t.wav"
    stat = media.stat()
    media.write_bytes(b"changed size")
    os.utime(media, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    assert recent.recent_project_cards()[0]["peaks"] == []
    assert len(probe.calls) == 2
    recent.recent_project_cards()
    assert len(probe.calls) == 2


def test_a_media_key_for_another_rel_path_is_not_served_from_the_cache(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    loaded = load_project(project)
    entry = waveform_media.resolve_media_refs(loaded, ["track:t"]).refs["track:t"]
    other = replace(entry, rel_path="elsewhere/t.wav")
    first = recent_peaks._media_key(entry)
    assert recent_peaks._media_key(other) != first
    assert recent_peaks._media_key(entry) == first


def test_a_media_file_with_a_new_mtime_and_the_same_size_loses_its_pyramid(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t")
    assert _peaks(project)
    media = project.parent / "raw" / "t.wav"
    stat = media.stat()
    os.utime(media, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))
    assert media.stat().st_size == stat.st_size
    assert recent.recent_project_cards()[0]["peaks"] == []


def test_the_first_bin_of_the_level_is_read(tmp_path, monkeypatch):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    path = _pyramid(project, "track:t")
    _craft(monkeypatch, {path: _cells((0, 0, 9000))}, sliced=True)
    assert _lit(_peaks(project)) == {0: 1.0}


def _fault_records(caplog) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.levelno >= logging.WARNING]


def test_a_second_outage_after_a_cache_hit_warns_again(tmp_path, caplog):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t")
    media = project.parent / "raw" / "t.wav"
    saved = media.read_bytes()
    stat = media.stat()
    assert _peaks(project)
    media.unlink()
    recent.recent_project_cards()
    assert str(project) in recent._PEAK_FAULTS
    media.write_bytes(saved)
    os.utime(media, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    assert recent.recent_project_cards()[0]["peaks"]
    assert str(project) not in recent._PEAK_FAULTS
    media.unlink()
    caplog.clear()
    with caplog.at_level(logging.DEBUG, logger=recent.__name__):
        recent.recent_project_cards()
    assert len(_fault_records(caplog)) == 1


def test_a_second_outage_after_a_fresh_fold_warns_again(tmp_path, caplog):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t")
    media = project.parent / "raw" / "t.wav"
    assert _peaks(project)
    media.unlink()
    recent.recent_project_cards()
    assert str(project) in recent._PEAK_FAULTS
    media.write_bytes(b"different media bytes")
    _pyramid(project, "track:t", seed=9)
    assert recent.recent_project_cards()[0]["peaks"]
    assert str(project) not in recent._PEAK_FAULTS
    media.unlink()
    caplog.clear()
    with caplog.at_level(logging.DEBUG, logger=recent.__name__):
        recent.recent_project_cards()
    assert len(_fault_records(caplog)) == 1


def test_a_forgotten_project_drops_its_peak_fault(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t")
    assert _peaks(project)
    (project.parent / "raw" / "t.wav").unlink()
    recent.recent_project_cards()
    assert str(project) in recent._PEAK_FAULTS
    recent.forget_recent(project)
    recent.recent_project_cards()
    assert str(project) not in recent._PEAK_FAULTS


def test_a_card_with_a_missing_pyramid_is_cached_until_the_stamp_changes(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    assert _peaks(project) == []
    assert recent._PEAKS[str(project)][2] == []
    cached = recent._PEAKS[str(project)]
    recent.recent_project_cards()
    assert recent._PEAKS[str(project)] is cached
    _pyramid(project, "track:t")
    assert len(recent.recent_project_cards()[0]["peaks"]) == COLUMNS


def test_a_fold_failure_warns_with_the_traceback(tmp_path, monkeypatch, caplog):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t")

    def broken(plan, ready):
        raise RuntimeError("fold")

    monkeypatch.setattr(recent_peaks, "fold_peaks", broken)
    with caplog.at_level(logging.DEBUG, logger=recent.__name__):
        assert _peaks(project) == []
    records = _fault_records(caplog)
    assert len(records) == 1
    assert records[0].exc_info is not None


def test_media_keys_are_pruned_with_the_forgotten_project(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    _pyramid(project, "track:t")
    _peaks(project)
    media = _media(project)
    assert media in recent_peaks._MEDIA_KEYS
    recent.forget_recent(project)
    recent.recent_project_cards()
    assert media not in recent_peaks._MEDIA_KEYS


def test_failed_probes_are_pruned_with_the_forgotten_project(tmp_path, probe):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    probe.fail()
    _peaks(project)
    media = _media(project)
    assert media in recent_peaks._FAILED_PROBES
    recent.forget_recent(project)
    recent.recent_project_cards()
    assert media not in recent_peaks._FAILED_PROBES


def test_a_success_clears_the_failed_probe_of_that_media(tmp_path, probe, clock):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    probe.fail(1)
    _peaks(project)
    assert _media(project) in recent_peaks._FAILED_PROBES
    clock.now += 30.0
    recent.recent_project_cards()
    assert _media(project) in recent_peaks._MEDIA_KEYS
    assert _media(project) not in recent_peaks._FAILED_PROBES


def test_a_source_clip_on_an_unknown_track_stays_flat(tmp_path):
    project = _make(tmp_path)
    _layout(project, [_clip(track="nope", source_id="s1")], sources=("s1",))
    _pyramid(project, "source:s1")
    assert _peaks(project) == []


BUILDERS = (
    "build_pyramid",
    "schedule_pyramid_build",
    "decode_media",
    "schedule_media_ref",
    "schedule_track_waveforms",
    "schedule_stem_waveforms",
    "ensure_track_waveforms",
    "ensure_project_waveforms",
)


@pytest.mark.parametrize("ready", [False, True], ids=["missing-pyramid", "ready-pyramid"])
def test_the_request_path_never_decodes_or_builds(tmp_path, monkeypatch, ready):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    if ready:
        _pyramid(project, "track:t")
    called: list[str] = []

    def refuse(name):
        def stop(*args, **kwargs):
            called.append(name)
            raise AssertionError(f"the recent list must not call {name}")

        return stop

    for module in (waveform_pyramid, waveform_media, recent_peaks, recent):
        for name in BUILDERS:
            monkeypatch.setattr(module, name, refuse(name), raising=False)
    peaks_dir = project.parent / "artifacts" / "peaks"
    before = sorted(peaks_dir.glob("*")) if peaks_dir.exists() else []
    peaks = _peaks(project)
    recent.recent_project_cards()
    after = sorted(peaks_dir.glob("*")) if peaks_dir.exists() else []
    assert called == []
    assert (len(peaks) == COLUMNS) is ready
    assert after == before


def test_one_probe_result_decides_the_key_with_no_stream_for_a_failed_probe(tmp_path, probe):
    project = _make(tmp_path)
    _layout(project, [_clip()])
    entry = waveform_media.resolve_media_refs(load_project(project), ["track:t"]).refs["track:t"]
    stamp = file_stamp(entry.abs_path)
    plain = waveform_media.media_key(entry.rel_path, *stamp.content)
    several = waveform_media.media_key(entry.rel_path, *stamp.content, first_stream=True)
    assert waveform_media.key_from_probe(entry, stamp, None) == plain
    assert waveform_media.key_from_probe(entry, stamp, probe(entry.abs_path)) == plain
    probe.several = True
    assert waveform_media.key_from_probe(entry, stamp, probe(entry.abs_path)) == several
    assert plain != several
