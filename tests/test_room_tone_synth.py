from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.timeline_ops import (
    fill_with_room_tone,
    insert_room_tone_pad,
    mute_room_tone_fill,
)
from podcast_mcp.engines import room_tone_synth
from podcast_mcp.engines.gate_fill import LOOP_SEC, synthesise_noise
from podcast_mcp.engines.room_tone import RecordedBedSample, room_tone_span
from podcast_mcp.engines.room_tone_synth import (
    SYNTH_ID_PREFIX,
    SynthSample,
    room_tone_for_gap,
)
from podcast_mcp.models import Clip, EpisodeProject
from podcast_mcp.util.dsp import rms_db
from podcast_mcp.util.workspace_paths import resolve_under_workspace
from test_room_tone import SR, _add_bed, _host_audio, _host_clip, _project

BED_DB = -62.0


def _bed(seconds: float, *, seed: int = 7) -> np.ndarray:
    return np.random.default_rng(seed).normal(0.0, 10 ** (BED_DB / 20), round(seconds * SR))


def _project_with_bed(tmp_path: Path, bed: np.ndarray) -> EpisodeProject:
    project = _project(tmp_path, host=_host_audio())
    _add_bed(project, tmp_path, bed)
    return project


def _pick(project: EpisodeProject, gap: float, *, seed_sec: float = 4.0):
    return room_tone_for_gap(
        project,
        "host",
        gap_sec=gap,
        seed_sec=seed_sec,
        near_sec=4.0,
        near_source_id=None,
        timeline_sec=seed_sec,
        duration_sec=gap,
    )


def test_a_gap_the_bed_covers_within_a_second_is_the_recorded_span_unchanged(
    tmp_path: Path,
) -> None:
    project = _project_with_bed(tmp_path, _bed(8.0))

    picked = _pick(project, 8.9)

    assert not isinstance(picked, SynthSample)
    assert picked == room_tone_span(
        project,
        "host",
        near_sec=4.0,
        near_source_id=None,
        timeline_sec=4.0,
        duration_sec=8.9,
    )


def test_a_gap_well_over_the_bed_is_a_registered_synthesised_source(tmp_path: Path) -> None:
    project = _project_with_bed(tmp_path, _bed(8.0))

    picked = _pick(project, 20.0)

    assert isinstance(picked, SynthSample)
    assert picked.source_id.startswith(SYNTH_ID_PREFIX)
    assert picked.end - picked.start == pytest.approx(20.0)
    registered = project.source_by_id(picked.source_id)
    assert registered is not None
    assert resolve_under_workspace(project, registered.path) == picked.path
    assert picked.path.is_file()


def test_synthesised_tone_matches_the_beds_level_and_does_not_repeat(tmp_path: Path) -> None:
    from podcast_mcp.engines.align import load_mono_window

    project = _project_with_bed(tmp_path, _bed(8.0))

    picked = _pick(project, 20.0)

    assert isinstance(picked, SynthSample)
    rate = room_tone_synth.SYNTH_RATE
    audio = load_mono_window(picked.path, start_sec=0.0, duration_sec=40.0, sample_rate=rate)
    basis = load_mono_window(
        tmp_path / "raw" / "room-tone" / "host.wav",
        start_sec=0.0,
        duration_sec=8.0,
        sample_rate=SR,
    )
    assert rms_db(audio) == pytest.approx(rms_db(basis), abs=0.3)
    window = audio[: 30 * rate]
    centred = window - window.mean()
    spectrum = np.fft.rfft(centred, n=2 * centred.size)
    correlation = np.fft.irfft(np.abs(spectrum) ** 2)[: centred.size]
    correlation /= correlation[0]
    lags = slice(round(0.5 * rate), round(25 * rate))
    assert np.abs(correlation[lags]).max() < 0.05


def test_the_same_fill_gets_the_same_source_in_every_project_copy(tmp_path: Path) -> None:
    project = _project_with_bed(tmp_path, _bed(8.0))
    scratch = project.model_copy(deep=True)

    first, second = _pick(project, 20.0), _pick(scratch, 20.0)

    assert isinstance(first, SynthSample) and isinstance(second, SynthSample)
    assert (first.source_id, first.start, first.end) == (second.source_id, second.start, second.end)
    assert first.path == second.path


def test_fills_at_different_positions_start_at_different_places_in_the_file(
    tmp_path: Path,
) -> None:
    project = _project_with_bed(tmp_path, _bed(8.0))

    starts = {
        _pick(project, 12.0, seed_sec=position).start  # type: ignore[union-attr]
        for position in (1.0, 2.5, 7.25, 40.0)
    }

    assert len(starts) == 4


def test_a_tonal_bed_keeps_the_recorded_tiling(tmp_path: Path) -> None:
    t = np.arange(round(8.0 * SR)) / SR
    hum = _bed(8.0) + 0.01 * np.sin(2 * np.pi * 1000 * t)
    project = _project_with_bed(tmp_path, hum)

    picked = _pick(project, 20.0)

    assert isinstance(picked, RecordedBedSample)
    assert not isinstance(picked, SynthSample)
    assert project.source_by_id(picked.source_id) is not None
    assert not any(s.id.startswith(SYNTH_ID_PREFIX) for s in project.sources)


def test_a_bed_whose_level_moves_keeps_the_recorded_tiling(tmp_path: Path) -> None:
    t = np.arange(round(8.0 * SR)) / SR
    swell = _bed(8.0) * (1.0 + 0.9 * (np.sin(2 * np.pi * 0.25 * t) > 0))
    project = _project_with_bed(tmp_path, swell)

    assert not isinstance(_pick(project, 20.0), SynthSample)


def test_a_basis_under_a_second_keeps_the_recorded_tiling(tmp_path: Path) -> None:
    project = _project_with_bed(tmp_path, _bed(0.8))

    assert not isinstance(_pick(project, 20.0), SynthSample)


def test_an_insert_pad_over_a_short_bed_is_filled_from_the_synthesised_source(
    tmp_path: Path,
) -> None:
    project = _project_with_bed(tmp_path, _bed(3.0))
    project.clips = [
        Clip(id="a", track_id="host", source_start=0.0, source_end=4.0, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=4.5, source_end=10.0, timeline_start=4.0),
    ]

    insert_room_tone_pad(project, 4.0, 20.0, defaults=load_defaults())

    pads = [c for c in project.clips if c.id not in {"a", "b"} and c.track_id == "host"]
    assert len(pads) == 1
    assert pads[0].source_id is not None and pads[0].source_id.startswith(SYNTH_ID_PREFIX)
    assert pads[0].timeline_end - pads[0].timeline_start == pytest.approx(20.0)
    assert project.source_by_id(pads[0].source_id) is not None


def test_fill_with_room_tone_over_a_long_gap_uses_one_synthesised_clip(tmp_path: Path) -> None:
    project = _project_with_bed(tmp_path, _bed(3.0))
    project.clips = [
        Clip(id="a", track_id="host", source_start=0.0, source_end=2.0, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=4.0, source_end=10.0, timeline_start=22.0),
    ]

    fill_with_room_tone(project, "host", sample_duration_sec=20.0, defaults=load_defaults())

    fills = [c for c in project.clips if c.id not in {"a", "b"}]
    assert [c.source_id and c.source_id.startswith(SYNTH_ID_PREFIX) for c in fills] == [True]


def test_a_mute_fill_over_a_long_mute_names_the_synthesised_source(tmp_path: Path) -> None:
    project = _project_with_bed(tmp_path, _bed(3.0))
    clip = _host_clip(project)
    clip.source_end = 10.0

    fill = mute_room_tone_fill(project, clip, 1.0, 9.0)

    assert fill is not None and fill.source_id is not None
    assert fill.source_id.startswith(SYNTH_ID_PREFIX)
    assert fill.end_s - fill.start_s == pytest.approx(8.0 + room_tone_synth.MUTE_FADE_SLACK_SEC)
    assert project.source_by_id(fill.source_id) is not None


def test_synthesise_noise_keeps_its_length_unless_asked() -> None:
    psd = np.ones(161)
    default = synthesise_noise(psd, 320, 16000, seed_key="k")
    longer = synthesise_noise(psd, 320, 16000, seed_key="k", length_sec=60.0)

    assert default.size == 1 << int(np.ceil(np.log2(LOOP_SEC * 16000)))
    assert longer.size > default.size


def test_a_synthesised_pad_renders_at_the_beds_level_without_repeating(tmp_path: Path) -> None:
    from podcast_mcp.engines.timeline_render import render_track_segment

    project = _project_with_bed(tmp_path, _bed(3.0))
    project.clips = [
        Clip(id="a", track_id="host", source_start=0.0, source_end=4.0, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=4.5, source_end=10.0, timeline_start=4.0),
    ]
    insert_room_tone_pad(project, 4.0, 20.0, defaults=load_defaults())
    out = tmp_path / "pad.wav"

    render_track_segment(project, "host", 5.0, 23.0, out, load_defaults())

    from podcast_mcp.engines.align import load_mono_window

    audio = load_mono_window(out, start_sec=0.0, duration_sec=18.0, sample_rate=SR)
    assert rms_db(audio) == pytest.approx(BED_DB, abs=0.8)
    centred = audio - audio.mean()
    spectrum = np.fft.rfft(centred, n=2 * centred.size)
    correlation = np.fft.irfft(np.abs(spectrum) ** 2)[: centred.size]
    correlation /= correlation[0]
    assert np.abs(correlation[round(0.5 * SR) : round(15 * SR)]).max() < 0.05


def test_a_synthesised_mute_fill_resolves_and_renders(tmp_path: Path) -> None:
    from podcast_mcp.engines.timeline_render import _room_tone_under_mutes
    from podcast_mcp.models import ClipMuteRegion

    project = _project_with_bed(tmp_path, _bed(3.0))
    clip = _host_clip(project)
    fill = mute_room_tone_fill(project, clip, 1.0, 9.0)
    assert fill is not None
    clip.mute_regions = [ClipMuteRegion(start_s=1.0, end_s=9.0, fill=fill)]
    track = project.track_by_id("host")
    assert track is not None

    tiles = _room_tone_under_mutes(project, track, clip, 0.0, 10.0)

    assert len(tiles) == 1
    assert tiles[0].audio.path.is_file()  # type: ignore[union-attr]


def test_a_short_piece_of_a_long_bed_is_synthesised_when_the_gap_would_replay_it(
    tmp_path: Path,
) -> None:
    project = _project_with_bed(tmp_path, _bed(8.0))

    picked = room_tone_for_gap(
        project,
        "host",
        gap_sec=6.0,
        seed_sec=4.0,
        near_sec=4.0,
        near_source_id=None,
        timeline_sec=4.0,
        duration_sec=0.25,
    )

    assert isinstance(picked, SynthSample)
    assert picked.path.is_relative_to(tmp_path / "raw" / "room-tone-synth")


def test_an_error_while_synthesising_keeps_the_recorded_tiling(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project_with_bed(tmp_path, _bed(8.0))

    def fail(*args: object, **kwargs: object) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(room_tone_synth, "_write_file", fail)

    picked = _pick(project, 20.0)

    assert not isinstance(picked, SynthSample)
    assert not any(s.id.startswith(SYNTH_ID_PREFIX) for s in project.sources)


def test_a_mute_region_with_fades_is_one_tile(tmp_path: Path) -> None:
    from podcast_mcp.engines.room_tone_tiles import tile_span

    project = _project_with_bed(tmp_path, _bed(3.0))
    clip = _host_clip(project)
    clip.source_end = 10.0
    fill = mute_room_tone_fill(project, clip, 1.0, 9.0)
    assert fill is not None

    assert len(tile_span(fill.start_s, fill.end_s, 8.0 + 0.4, seed_sec=fill.start_s)) == 1


def test_a_harmonic_mains_buzz_keeps_the_recorded_tiling(tmp_path: Path) -> None:
    t = np.arange(round(8.0 * SR)) / SR
    buzz = sum(0.003 * 10 ** (-0.15 * k) * np.sin(2 * np.pi * 60 * k * t) for k in range(1, 8))
    project = _project_with_bed(tmp_path, _bed(8.0) + buzz)

    assert not isinstance(_pick(project, 20.0), SynthSample)


def test_a_long_fill_reads_inside_the_file_and_differs_by_position(tmp_path: Path) -> None:
    project = _project_with_bed(tmp_path, _bed(8.0))

    first = _pick(project, 130.0, seed_sec=1.0)
    second = _pick(project, 130.0, seed_sec=2.5)

    assert isinstance(first, SynthSample) and isinstance(second, SynthSample)
    assert first.end - first.start == pytest.approx(room_tone_synth.SYNTH_MAX_FILL_SEC)
    assert first.start != second.start
    assert first.end <= room_tone_synth.SYNTH_FILE_SEC


def test_a_synthesised_source_is_never_a_transcription_job(tmp_path: Path) -> None:
    from podcast_mcp.engines.transcribe import dialogue_transcribe_jobs

    project = _project_with_bed(tmp_path, _bed(3.0))
    project.clips = [
        Clip(id="a", track_id="host", source_start=0.0, source_end=4.0, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=4.5, source_end=10.0, timeline_start=4.0),
    ]
    insert_room_tone_pad(project, 4.0, 20.0, defaults=load_defaults())
    assert any((c.source_id or "").startswith(SYNTH_ID_PREFIX) for c in project.clips)

    jobs = dialogue_transcribe_jobs(project)

    assert not any((job.source_id or "").startswith(SYNTH_ID_PREFIX) for job in jobs)


def test_a_track_id_with_path_characters_stays_inside_the_synth_directory(
    tmp_path: Path,
) -> None:
    project = _project_with_bed(tmp_path, _bed(8.0))
    project.tracks[0].id = "../../host"

    picked = room_tone_for_gap(
        project,
        "../../host",
        gap_sec=20.0,
        seed_sec=4.0,
        near_sec=4.0,
        near_source_id=None,
        duration_sec=20.0,
    )

    if isinstance(picked, SynthSample):
        assert picked.path.parent == (tmp_path / "raw" / "room-tone-synth").resolve()


def test_a_cut_copy_registers_a_synthesised_source_on_the_copy_only(tmp_path: Path) -> None:
    from podcast_mcp.edits.cut_application import _cut_copy

    project = _project_with_bed(tmp_path, _bed(3.0))
    project.clips = [
        Clip(id="a", track_id="host", source_start=0.0, source_end=4.0, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=4.5, source_end=10.0, timeline_start=4.0),
    ]
    sources_before = [s.id for s in project.sources]
    candidate = _cut_copy(project)

    insert_room_tone_pad(candidate, 4.0, 20.0, defaults=load_defaults())

    assert any(s.id.startswith(SYNTH_ID_PREFIX) for s in candidate.sources)
    assert [s.id for s in project.sources] == sources_before
