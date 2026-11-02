"""Holes, windows, fades and the render hash of a clip with a timing map (#2956, umbrella #1089)."""

from __future__ import annotations

import wave
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import room_tone
from podcast_mcp.engines.audio import SourceAudio, duration, sources
from podcast_mcp.engines.play_audit import track_render_hash
from podcast_mcp.engines.room_tone_tiles import tile_span
from podcast_mcp.engines.timed_pieces import expand_timed_clips
from podcast_mcp.engines.timeline_render import (
    placed_track_audio,
    render_track_from_timeline,
    render_track_segment,
    shell_micro_fade_ms,
    track_grid,
)
from podcast_mcp.models import Clip, ClipJoinMode, EpisodeProject, MediaAsset, SourceRecording
from podcast_mcp.models.clip_timing import MAX_TIMING_STEPS
from podcast_mcp.util.coded_error import CodedValueError
from test_timed_clip_render import (
    MICRO_MS,
    RATE,
    _four_clips,
    _frames,
    _mapped,
    _project,
    _render,
    _source,
)

_BED_ID = room_tone.room_tone_source_id("host")


def _lane(steps: list[dict], *, end: float = 4.0, **extra) -> Clip:
    return Clip.model_validate(
        {
            "id": "lane",
            "track_id": "host",
            "source_start": 0.0,
            "source_end": end,
            "timeline_start": 0.0,
            "timing": {"steps": steps},
            **extra,
        }
    )


@contextmanager
def _pool(*samples: tuple[float, float]) -> Iterator[None]:
    pool = tuple(room_tone.Sample(a, b, -40.0, None) for a, b in samples)
    with patch.object(room_tone, "read_room_tone_pool", return_value=pool):
        yield


@contextmanager
def _no_pool() -> Iterator[None]:
    with patch.object(room_tone, "read_room_tone_pool", return_value=None):
        yield


def _read(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as audio:
        return np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2")


def _segment(project: EpisodeProject, tmp_path: Path, start: float, end: float) -> np.ndarray:
    out = tmp_path / "segment.wav"
    render_track_segment(project, "host", start, end, out, {})
    return _read(out)


def _fills(
    clip: Clip,
    project: EpisodeProject,
    window: tuple[float, float] | None = None,
    *,
    on_grid: bool = True,
) -> list[SourceAudio]:
    track = project.tracks[0]
    grid = track_grid(project, track, [clip], window=window) if on_grid else None
    placed = placed_track_audio(project, track, [clip], grid=grid, window=window)
    return [leaf for leaf in sources(placed.audio) if leaf.is_fill]


def _assert_slice(window: np.ndarray, stem: np.ndarray, start: float, end: float) -> None:
    first = round(start * RATE)
    assert window.shape[0] == round((end - start) * RATE)
    assert np.abs(window.astype(int) - stem[first : first + window.shape[0]].astype(int)).max() <= 1


@pytest.mark.parametrize("step", [0.02, 0.0500001, 0.05])
@pytest.mark.parametrize("filled", [False, True])
def test_a_short_positive_step_keeps_its_hole_with_and_without_a_pool(
    tmp_path: Path, step: float, filled: bool
) -> None:
    clip = _lane([{"at": 2.0, "delta_sec": step}])
    project = _project(tmp_path, [clip], _source(room=0.02))
    with _pool((5.0, 7.0)) if filled else _no_pool():
        samples = _render(project, tmp_path)
    assert samples.shape[0] == _frames(4.0 + step)
    source = (_source(room=0.02) * 32767).astype("<i2")[: _frames(4.0)]
    hole = _frames(2.0 + step) - _frames(2.0)
    expected = np.concatenate(
        [source[: _frames(2.0)], np.zeros(hole, "<i2"), source[_frames(2.0) :]]
    )
    seam = _frames(MICRO_MS / 1000) + 1
    before, after = _frames(2.0) - seam, _frames(2.0 + step) + seam
    assert np.abs(samples[:before].astype(int) - expected[:before].astype(int)).max() <= 1
    assert np.abs(samples[after:].astype(int) - expected[after:].astype(int)).max() <= 1


def test_pool_and_no_pool_lanes_agree_outside_the_hole(tmp_path: Path) -> None:
    clip = _lane([{"at": 2.0, "delta_sec": 0.02}])
    with _no_pool():
        silent = _render(_project(tmp_path / "a", [clip], _source(room=0.02)), tmp_path / "a")
    with _pool((5.0, 7.0)):
        filled = _render(_project(tmp_path / "b", [clip], _source(room=0.02)), tmp_path / "b")
    assert silent.shape == filled.shape
    assert not silent[_frames(2.0) : _frames(2.02)].any()
    outside = np.ones(silent.shape, dtype=bool)
    outside[_frames(2.0) : _frames(2.02)] = False
    assert np.abs(silent.astype(int) - filled.astype(int))[outside].max() <= 1


@pytest.mark.parametrize("filled", [False, True])
def test_a_sub_tolerance_step_without_a_grid_keeps_its_length(tmp_path: Path, filled: bool) -> None:
    clip = _lane([{"at": 2.0, "delta_sec": 0.02}])
    project = _project(tmp_path, [clip], _source(room=0.02))
    with _pool((5.0, 7.0)) if filled else _no_pool():
        placed = placed_track_audio(project, project.tracks[0], [clip], grid=None)
    assert duration(placed.audio) == pytest.approx(4.02, abs=1e-6)


@pytest.mark.parametrize("filled", [False, True])
def test_a_hole_before_a_piece_shorter_than_a_sample_still_counts(
    tmp_path: Path, filled: bool
) -> None:
    clip = _lane([{"at": 3.99999, "delta_sec": 0.1}])
    project = _project(tmp_path, [clip], _source(room=0.02))
    with _pool((5.0, 7.0)) if filled else _no_pool():
        samples = _render(project, tmp_path)
    assert samples.shape[0] == _frames(4.1)
    if not filled:
        assert not samples[_frames(4.0) :].any()


def test_a_no_pool_hole_between_pieces_is_silent_and_later_audio_is_on_time(
    tmp_path: Path,
) -> None:
    clip = _lane([{"at": 1.0, "delta_sec": 0.03}, {"at": 3.0, "delta_sec": 0.0500001}])
    project = _project(tmp_path, [clip], _source())
    with _no_pool():
        samples = _render(project, tmp_path)
    assert samples.shape[0] == _frames(4.0 + 0.03 + 0.0500001)
    assert not samples[_frames(1.0) : _frames(1.03)].any()
    source = (_source() * 32767).astype("<i2")
    shift = _frames(0.03)
    middle = slice(_frames(1.03) + 400, _frames(3.03) - 400)
    assert np.array_equal(samples[middle], source[middle.start - shift : middle.stop - shift])


@pytest.mark.parametrize(
    ("delta", "sample"),
    [(0.2, (5.0, 7.0)), (1.2, (5.0, 5.5)), (2.0, (5.0, 6.2))],
    ids=["one tile", "butt-spliced tiles", "crossfaded tiles"],
)
def test_a_window_that_cuts_a_hole_matches_the_stem_slice(
    tmp_path: Path, delta: float, sample: tuple[float, float]
) -> None:
    clip = _lane([{"at": 1.0, "delta_sec": delta}])
    project = _project(tmp_path, [clip], _source(room=0.02))
    start, end = 1.0 + delta * 0.37, 1.0 + delta * 0.81
    with _pool(sample):
        stem = _render(project, tmp_path)
        window = _segment(project, tmp_path, start, end)
    assert stem[round(start * RATE) : round(end * RATE)].any()
    _assert_slice(window, stem, start, end)


def test_a_window_hole_tone_tiles_from_the_stems_origin_without_a_grid(tmp_path: Path) -> None:
    clip = _lane([{"at": 1.0, "delta_sec": 2.0}])
    project = _project(tmp_path, [clip], _source(room=0.02))
    with _pool((5.0, 6.2)):
        whole = _fills(clip, project, on_grid=False)
        window = _fills(clip, project, (1.5, 2.0), on_grid=False)
    assert len(whole) == 3
    assert len(window) == 2
    tile = 2.0 / 3
    assert window[0].src_start == pytest.approx(whole[0].src_start + 0.5)
    assert (window[0].fade_in_sec, window[0].reach_in) == (0.0, 0.0)
    assert window[1].src_start == pytest.approx(whole[1].src_start)
    assert window[1].src_end == pytest.approx(whole[1].src_start + 1.0 - tile + whole[1].reach_in)
    assert window[1].fade_out_sec == 0.0


def test_hole_tone_is_laid_out_from_the_right_pieces_source_position(tmp_path: Path) -> None:
    clip = _lane([{"at": 7.3, "delta_sec": 2.0}], end=8.0)
    project = _project(tmp_path, [clip], _source(room=0.02))
    with _pool((5.0, 6.2)):
        fills = _fills(clip, project)
    tiles = tile_span(5.0, 6.2, 2.0, seed_sec=7.3)
    assert [(f.src_start, f.src_end) for f in fills] == pytest.approx(
        [(t.source_start - t.reach_in, t.source_start + t.length + t.reach_out) for t in tiles]
    )
    unseeded = tile_span(5.0, 6.2, 2.0, seed_sec=0.0)
    assert [t.source_start for t in tiles] != pytest.approx([t.source_start for t in unseeded])


def test_hole_fill_asks_for_a_pick_near_the_right_piece_and_avoids_skipped_source(
    tmp_path: Path,
) -> None:
    steps: list[dict] = [
        {"at": 1.0, "delta_sec": 0.2},
        {"at": 2.0, "delta_sec": -0.1, "quiet": {"start_s": 2.0, "end_s": 2.5}},
    ]
    clip = _lane(steps)
    project = _project(tmp_path, [clip], _source(room=0.02))
    calls = []
    real = room_tone.room_tone_span

    def spy(*args, **kwargs):
        calls.append(kwargs)
        return real(*args, **kwargs)

    with _pool((5.0, 7.0)), patch.object(room_tone, "room_tone_span", spy):
        _fills(clip, project)
    assert len(calls) == 1
    assert calls[0]["near_sec"] == pytest.approx(1.0)
    assert calls[0]["near_source_id"] == clip.source_id
    assert calls[0]["duration_sec"] == pytest.approx(0.2)
    assert [tuple(span) for span in calls[0]["avoid"]] == pytest.approx([(2.0, 2.1)])


def test_a_pooled_sample_overlapping_skipped_source_is_not_played(tmp_path: Path) -> None:
    steps: list[dict] = [
        {"at": 1.0, "delta_sec": 0.2},
        {"at": 3.0, "delta_sec": -0.5, "quiet": {"start_s": 3.0, "end_s": 3.6}},
    ]
    clip = _lane(steps)
    project = _project(tmp_path, [clip], _source(room=0.02))
    with _pool((3.0, 3.5)):
        fills = _fills(clip, project)
    for fill in fills:
        assert fill.src_end <= 3.0 + 1e-9 or fill.src_start >= 3.5 - 1e-9


def test_hole_fill_leaves_carry_the_parent_clip_id_and_are_marked_as_fills(tmp_path: Path) -> None:
    clip = _lane([{"at": 1.0, "delta_sec": 0.2}])
    project = _project(tmp_path, [clip], _source(room=0.02))
    with _pool((5.0, 7.0)):
        fills = _fills(clip, project)
    assert [(f.clip_id, f.is_fill, f.source_id) for f in fills] == [("lane", True, None)]


def test_a_recorded_bed_fills_the_hole_and_its_window_matches_the_stem(tmp_path: Path) -> None:
    clip = _lane([{"at": 1.0, "delta_sec": 1.2}])
    project = _project(tmp_path, [clip], _source())
    bed_path = tmp_path / "raw" / "bed.wav"
    bed = 0.01 * np.random.default_rng(3).uniform(-1, 1, RATE)
    with wave.open(str(bed_path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes((bed * 32767).astype("<i2").tobytes())
    project.tracks[0].room_tone = MediaAsset(path="raw/bed.wav", duration_sec=1.0)
    project.sources.append(SourceRecording(id=_BED_ID, path="raw/bed.wav"))
    pick = room_tone.RecordedBedSample(0.1, 0.6, _BED_ID, bed_path)
    with patch.object(room_tone, "room_tone_bed", return_value=pick):
        stem = _render(project, tmp_path)
        window = _segment(project, tmp_path, 1.31, 1.83)
        fills = _fills(clip, project)
    assert {f.source_id for f in fills} == {_BED_ID}
    assert len(fills) > 1
    assert stem[_frames(1.03) : _frames(2.17)].any()
    _assert_slice(window, stem, 1.31, 1.83)


def test_the_first_pieces_join_mode_and_parent_fades_reach_the_render(tmp_path: Path) -> None:
    parent = _mapped().model_copy(
        update={"fade_in_ms": 300, "fade_out_ms": 250, "join_in_mode": ClipJoinMode.CUT}
    )
    shells, _ = expand_timed_clips([parent])
    assert [s.join_in_mode for s in shells] == [ClipJoinMode.CUT] + [ClipJoinMode.FADE] * 3
    assert (shells[0].fade_in_ms, shells[-1].fade_out_ms) == (300, 250)
    plain = _four_clips()
    plain[0] = plain[0].model_copy(update={"fade_in_ms": 300, "join_in_mode": ClipJoinMode.CUT})
    plain[-1] = plain[-1].model_copy(update={"fade_out_ms": 250})
    expected = _render(_project(tmp_path / "p", plain, _source()), tmp_path / "p")
    mapped = _render(_project(tmp_path / "m", [parent], _source()), tmp_path / "m")
    assert np.array_equal(mapped, expected)
    assert np.abs(mapped[: _frames(0.05)]).max() < np.abs(mapped[_frames(0.3) :][:800]).max()


@pytest.mark.parametrize(("configured", "applied"), [(40, 40), (0, 0), (-5, 0)])
def test_micro_fade_ms_from_the_defaults_shapes_the_rendered_joins(
    tmp_path: Path, configured: int, applied: int
) -> None:
    defaults = {"inaudible_cuts": {"micro_fade_ms": configured}}
    project = _project(tmp_path / "m", [_mapped()], _source())
    out = tmp_path / "m" / "artifacts" / "host.wav"
    render_track_from_timeline(project, project.tracks[0], out, defaults)
    last = len(_four_clips()) - 1
    plain = [
        c.model_copy(
            update={
                "fade_in_ms": applied if index else 0,
                "fade_out_ms": applied if index < last else 0,
            }
        )
        for index, c in enumerate(_four_clips())
    ]
    expected = _render(_project(tmp_path / "p", plain, _source()), tmp_path / "p")
    assert np.array_equal(_read(out), expected)


def test_a_negative_micro_fade_builds_no_negative_shell_fades(tmp_path: Path) -> None:
    clip = _mapped()
    project = _project(tmp_path, [clip], _source(room=0.02))
    track = project.tracks[0]
    grid = track_grid(project, track, [clip])
    with _pool((5.0, 7.0)):
        placed = placed_track_audio(project, track, [clip], grid=grid, micro_fade_ms=-5)
    assert all(leaf.fade_in_sec >= 0 and leaf.fade_out_sec >= 0 for leaf in sources(placed.audio))
    assert shell_micro_fade_ms([clip], {"inaudible_cuts": {"micro_fade_ms": -5}}) == 0


def test_shell_micro_fade_is_read_only_for_a_mapped_clip() -> None:
    defaults = {"inaudible_cuts": {"micro_fade_ms": 40}}
    assert shell_micro_fade_ms([_mapped()], defaults) == 40
    assert shell_micro_fade_ms(_four_clips(), defaults) == 10


def test_micro_fade_reaches_every_placed_track_audio_call_site(tmp_path: Path) -> None:
    from podcast_mcp.edits import cut_effects
    from podcast_mcp.engines import timeline_render

    project = _project(tmp_path, [_mapped()], _source())
    defaults = {"inaudible_cuts": {"micro_fade_ms": 33}}
    seen: list[int] = []
    real = timeline_render.placed_track_audio

    def spy(*args, **kwargs):
        seen.append(kwargs["micro_fade_ms"])
        return real(*args, **kwargs)

    with (
        patch.object(timeline_render, "placed_track_audio", spy),
        patch.object(cut_effects, "placed_track_audio", spy),
    ):
        render_track_from_timeline(
            project, project.tracks[0], tmp_path / "artifacts" / "host.wav", defaults
        )
        render_track_segment(project, "host", 0.5, 1.5, tmp_path / "s.wav", defaults)
    assert seen
    assert set(seen) == {33}


def _hash(project: EpisodeProject, fade: int | None = None) -> str:
    defaults = load_defaults()
    if fade is not None:
        defaults["inaudible_cuts"]["micro_fade_ms"] = fade
    return track_render_hash(project, "host", defaults=defaults)


def test_the_hash_follows_the_resolved_micro_fade_of_a_timed_clip_only(tmp_path: Path) -> None:
    timed = _project(tmp_path / "t", [_mapped()], _source())
    assert _hash(timed, 10) != _hash(timed, 40)
    assert _hash(timed, -5) == _hash(timed, 0)
    plain = _project(tmp_path / "p", _four_clips(), _source())
    assert _hash(plain, 10) == _hash(plain, 40)


def test_the_hash_ignores_timing_method_and_evidence(tmp_path: Path) -> None:
    project = _project(tmp_path, [_mapped()], _source())
    clip = project.timeline.clips[0]
    assert clip.timing is not None
    before = _hash(project)
    clip.timing = clip.timing.model_copy(update={"method": "other", "evidence": "lag 20 ms"})
    assert _hash(project) == before


def test_the_hash_still_follows_the_step_geometry(tmp_path: Path) -> None:
    project = _project(tmp_path, [_mapped()], _source())
    clip = project.timeline.clips[0]
    assert clip.timing is not None
    before = _hash(project)
    steps = [clip.timing.steps[0].model_copy(update={"delta_sec": 0.21}), *clip.timing.steps[1:]]
    clip.timing = clip.timing.model_copy(update={"steps": steps})
    assert _hash(project) != before


def test_a_clip_over_the_step_cap_is_refused_by_name(tmp_path: Path) -> None:
    def steps(count: int) -> list[dict]:
        return [{"at": 0.1 + 0.05 * index, "delta_sec": 0.001} for index in range(count)]

    expand_timed_clips([_lane(steps(MAX_TIMING_STEPS), end=20.0)])
    project = _project(tmp_path, [_lane(steps(MAX_TIMING_STEPS + 1), end=20.0)], _source())
    with pytest.raises(CodedValueError) as refused:
        render_track_from_timeline(project, project.tracks[0], tmp_path / "x.wav", {})
    assert refused.value.code == "timing_map_too_many_steps"
