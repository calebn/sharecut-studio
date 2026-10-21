"""Raw projection, placed playback and the peer guard keep the same native source samples (#1258).

The oracle is the lane after the removal, as the forward consumer leaves it: a native
source sample plays when it lies in ``[round(source_start * rate), round(source_end * rate))``
of a remaining clip. Every reader has to agree with it, at any fractional source origin.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.ripple import ripple_remove_clips
from podcast_mcp.edits.speech_energy_guard import measure_peer_speech
from podcast_mcp.engines.audio_audit import _played_window, build_track_rms_caches
from podcast_mcp.engines.sample_grid import Piece, lay_out
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.engines.ungated_audio import raw_timeline_samples
from podcast_mcp.models import Clip, EpisodeProject, SourceRecording
from podcast_mcp.util.timebase import SourceSec
from test_speech_energy_guard import _GUARD_ON, _project_with_peer_audio, _write_wav

RATE = 8000
_REMOVALS = [(1.003, 3.003), (1.00304, 3.00704), (1.0030625, 3.0070625)]
_AROUND = (-2, -1, 0, 1)


def _impulse_indices(source_start: float, source_end: float) -> list[int]:
    return [round(edge * RATE) + step for edge in (source_start, source_end) for step in _AROUND]


def _scene(
    tmp_path: Path, origin: float, removal: tuple[float, float], indices: list[int]
) -> tuple[EpisodeProject, tuple[tuple[float, float], ...], np.ndarray]:
    peer = np.zeros(8 * RATE)
    amplitudes = 0.01 * (1 + np.arange(len(indices)))
    peer[indices] = amplitudes
    project = _project_with_peer_audio(tmp_path, np.zeros(16 * RATE))
    _write_wav(tmp_path / "guest.wav", peer, sample_rate=RATE)
    project.clips[0].timeline_start = 0.50004
    project.clips[1].source_start = origin
    project.clips[1].timeline_start = 0.50004 + origin
    project.timeline.duration_sec = 8.50004
    spans = tuple(
        (float(a), float(b))
        for a, b in SessionTimeline(project).map_source_span(
            "host", SourceSec(removal[0]), SourceSec(removal[1])
        )
    )
    return project, spans, amplitudes


def _played_amplitudes(samples: np.ndarray) -> set[float]:
    return {round(float(v), 2) for v in samples[samples != 0]}


def _covered(project: EpisodeProject, indices: list[int], amplitudes: np.ndarray) -> set[float]:
    clips = [c for c in project.clips if c.track_id == "guest"]
    return {
        round(float(amplitude), 2)
        for index, amplitude in zip(indices, amplitudes, strict=True)
        if any(round(c.source_start * RATE) <= index < round(c.source_end * RATE) for c in clips)
    }


@pytest.mark.parametrize("origin", [0.0, 0.00004, 0.00008, 0.00011, 0.10008])
@pytest.mark.parametrize("removal", _REMOVALS)
def test_raw_projection_and_placed_playback_play_the_samples_the_clips_cover(
    tmp_path: Path, origin: float, removal: tuple[float, float]
) -> None:
    indices = _impulse_indices(origin, 0.0) + _impulse_indices(removal[0], removal[1])
    indices = sorted({index for index in indices if index > 0})
    project, spans, amplitudes = _scene(tmp_path, origin, removal, indices)
    before_raw = _played_amplitudes(raw_timeline_samples(project, "guest", sample_rate=RATE))
    before_placed = _played_amplitudes(
        _played_window(project, "guest", 0.0, 8.51, defaults=load_defaults())
    )
    assert before_raw == before_placed == _covered(project, indices, amplitudes)

    forward = project.model_copy(deep=True)
    ripple_remove_clips(forward, spans, ["host", "guest"], defaults=load_defaults())
    expected = _covered(forward, indices, amplitudes)
    assert _played_amplitudes(raw_timeline_samples(forward, "guest", sample_rate=RATE)) == expected
    assert (
        _played_amplitudes(_played_window(forward, "guest", 0.0, 6.51, defaults=load_defaults()))
        == expected
    )


@pytest.mark.parametrize("origin", [0.0, 0.00004, 0.00008, 0.00011, 0.10008])
@pytest.mark.parametrize("removal", _REMOVALS)
@pytest.mark.parametrize("cached", [False, True], ids=["placed", "cached"])
def test_peer_guard_protects_exactly_the_samples_the_removal_deletes(
    tmp_path: Path, origin: float, removal: tuple[float, float], cached: bool
) -> None:
    probes = sorted({i for i in _impulse_indices(removal[0], removal[1]) if i > 0})
    for index in probes:
        project, spans, amplitudes = _scene(tmp_path, origin, removal, [index])
        forward = project.model_copy(deep=True)
        ripple_remove_clips(forward, spans, ["host", "guest"], defaults=load_defaults())
        removed = not _covered(forward, [index], amplitudes)
        levels = measure_peer_speech(
            project,
            spans,
            owner_track_ids=["host"],
            peer_track_ids=["guest"],
            defaults=_GUARD_ON,
            caches=build_track_rms_caches(project, defaults=load_defaults()) if cached else None,
            _admissible_spans=spans,
        )
        assert levels is not None
        assert levels.speaking == (("guest",) if removed else ()), (index, removed)


def _overlay(tmp_path: Path, *, a: bool, b: bool) -> tuple[EpisodeProject, tuple[float, float]]:
    """Two recordings share the guest lane. A's impulse survives the removal; B's does not."""
    silent = np.zeros(8 * RATE)
    first, second = silent.copy(), silent.copy()
    first[24024] = 0.045 if a else 0.0
    second[24023] = 0.045 if b else 0.0
    project = _project_with_peer_audio(tmp_path, np.zeros(16 * RATE))
    _write_wav(tmp_path / "guest.wav", first, sample_rate=RATE)
    _write_wav(tmp_path / "b.wav", second, sample_rate=RATE)
    project.sources = [SourceRecording(id="b", path=str(tmp_path / "b.wav"))]
    project.clips[0].timeline_start = project.clips[1].timeline_start = 0.50004
    project.clips.append(
        Clip(
            id="gB",
            track_id="guest",
            source_id="b",
            source_start=0.00004,
            source_end=8.0,
            timeline_start=0.50008,
        )
    )
    project.timeline.duration_sec = 8.50008
    return project, (1.50304, 3.50304)


@pytest.mark.parametrize("cached", [False, True], ids=["placed", "cached"])
@pytest.mark.parametrize(
    ("a", "b", "expected"),
    [(True, False, ()), (False, True, ("guest",)), (True, True, ("guest",))],
    ids=["retained_a_only", "removed_b_only", "both"],
)
def test_a_cell_two_recordings_share_keeps_the_removed_one_apart(
    tmp_path: Path, cached: bool, a: bool, b: bool, expected: tuple[str, ...]
) -> None:
    project, span = _overlay(tmp_path, a=a, b=b)
    forward = project.model_copy(deep=True)
    ripple_remove_clips(forward, [span], ["host", "guest"], defaults=load_defaults())
    assert np.count_nonzero(raw_timeline_samples(forward, "guest", sample_rate=RATE)) == int(a)
    assert np.count_nonzero(
        _played_window(forward, "guest", 0.0, 6.6, defaults=load_defaults())
    ) == int(a)
    levels = measure_peer_speech(
        project,
        [span],
        owner_track_ids=["host"],
        peer_track_ids=["guest"],
        defaults=_GUARD_ON,
        caches=build_track_rms_caches(project, defaults=load_defaults()) if cached else None,
        _admissible_spans=(span,),
    )
    assert levels is not None
    assert levels.speaking == expected
    assert levels.unread == {}


def test_removed_recording_that_cannot_be_read_apart_leaves_the_lane_reading(
    tmp_path: Path,
) -> None:
    project, span = _overlay(tmp_path, a=True, b=True)
    with patch("podcast_mcp.edits.speech_energy_guard.read_samples", side_effect=OSError):
        levels = measure_peer_speech(
            project,
            [span],
            owner_track_ids=["host"],
            peer_track_ids=["guest"],
            defaults=_GUARD_ON,
            _admissible_spans=(span,),
        )
    assert levels is not None
    assert levels.speaking == ()
    assert levels.unread == {}


@pytest.mark.parametrize("rate", [8000, 16000, 44100])
def test_raw_projection_follows_the_clip_cells_at_any_reader_rate(
    tmp_path: Path, rate: int
) -> None:
    peer = np.zeros(8 * rate)
    keep, lose = round(1.003 * rate) - 1, round(1.003 * rate)
    peer[[keep, lose]] = [0.03, 0.05]
    project = _project_with_peer_audio(tmp_path, np.zeros(8 * 16000))
    _write_wav(tmp_path / "guest.wav", peer, sample_rate=rate)
    project.clips[0].timeline_start = 0.50004
    project.clips[1].source_start = 0.00004
    project.clips[1].timeline_start = 0.50008
    forward = project.model_copy(deep=True)
    ripple_remove_clips(forward, [(1.50304, 3.50304)], ["host", "guest"], defaults=load_defaults())
    played = raw_timeline_samples(forward, "guest", sample_rate=rate)
    clips = [c for c in forward.clips if c.track_id == "guest"]
    covers = [
        any(round(c.source_start * rate) <= i < round(c.source_end * rate) for c in clips)
        for i in (keep, lose)
    ]
    assert {round(float(v), 2) for v in played[played != 0]} == {
        v for v, c in zip((0.03, 0.05), covers, strict=True) if c
    }


def test_a_clip_shorter_than_one_sample_plays_nothing(tmp_path: Path) -> None:
    project = _project_with_peer_audio(tmp_path, np.zeros(8 * 16000))
    _write_wav(tmp_path / "guest.wav", np.full(8 * RATE, 0.01), sample_rate=RATE)
    project.clips[1].source_end = project.clips[1].source_start + 0.00003
    assert np.count_nonzero(raw_timeline_samples(project, "guest", sample_rate=RATE)) == 0
    assert (
        np.count_nonzero(_played_window(project, "guest", 0.0, 1.0, defaults=load_defaults())) == 0
    )


def test_a_split_that_removed_nothing_lays_out_like_the_unsplit_clip() -> None:
    whole = lay_out([Piece(0.00004, 8.0, 0.50008, 8.50004)], RATE)
    parts = lay_out(
        [
            Piece(0.00004, 1.003, 0.50008, 1.50304),
            Piece(1.003, 8.0, 1.50304, 8.50004),
        ],
        RATE,
    )
    assert parts[0].first + parts[0].count == parts[1].first
    assert parts[1].dest == parts[0].stop
    assert (parts[0].dest, parts[0].first, parts[1].stop - parts[0].dest) == (
        whole[0].dest,
        whole[0].first,
        whole[0].count,
    )


def test_a_ripple_join_is_back_to_back_and_a_far_join_keeps_its_own_start() -> None:
    joined = lay_out(
        [Piece(0.00004, 1.003, 0.50008, 1.50304), Piece(3.003, 8.0, 1.50304, 6.50004)], RATE
    )
    assert joined[1].dest == joined[0].stop
    far = lay_out([Piece(0.0, 1.0, 0.0, 1.0), Piece(1.0, 2.0, 1.00045, 2.00045)], RATE)
    assert far[1].dest == round(1.00045 * RATE)
    no_join = lay_out([Piece(0.0, 1.0, 0.0, 1.0), Piece(1.0, 2.0, 1.5, 2.5)], RATE)
    assert no_join[1].dest == round(1.5 * RATE)


def test_a_chain_of_fractional_joins_never_strays_from_the_timeline() -> None:
    rng = np.random.default_rng(1258)
    cursor, source, pieces = 0.5, 0.0, []
    for _ in range(300):
        length = float(rng.uniform(0.2, 2.0))
        pieces.append(Piece(source, source + length, cursor, cursor + length))
        cursor += length
        source += length + float(rng.uniform(0.1, 1.0))
    for piece, cell in zip(pieces, lay_out(pieces, RATE), strict=True):
        assert abs(cell.dest - piece.timeline_start * RATE) <= 2.5
        assert cell.count == round(piece.source_end * RATE) - round(piece.source_start * RATE)


def test_a_piece_ends_on_the_nearest_even_sample_like_the_clips_it_came_from() -> None:
    (cell,) = lay_out([Piece(0.0, 3.0070625, 0.0, 3.0070625)], RATE)
    assert cell.count == 24056
