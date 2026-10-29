"""A bleed mute takes the track's own room tone, not digital silence (#1734)."""

from __future__ import annotations

import copy
import shutil
import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.transcript_bleed_mute import apply_transcript_bleed_mute
from podcast_mcp.engines.bleed_fill import BleedFill, measure_bleed_fill
from podcast_mcp.engines.bleed_gate import BleedGatePlan, build_bleed_gate_plan
from podcast_mcp.engines.bleed_restore import restored_pcm
from podcast_mcp.engines.play_audit import track_render_hash, write_stem_hash
from podcast_mcp.engines.transcript_gated_play import (
    _gate_pcm_chunk,
    apply_bleed_gate_plan,
    apply_track_transcript_gate,
)
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.util.wav import open_wav

pytestmark = pytest.mark.usefixtures("one_phrase_copy_evidence")

RATE = 48_000
DURATION = 12.0
ROOM_DB = -72.0
FOREIGN = (2.0, 2.6)


def _defaults(handling: str = "mute", fill: str = "auto") -> dict:
    defaults = copy.deepcopy(load_defaults())
    defaults.setdefault("analysis", {}).setdefault("heuristics", {})["bleed_handling"] = handling
    defaults["gate_fill"] = {"mode": fill, "fade_ms": 10}
    return defaults


def _write_pcm(path: Path, samples: np.ndarray, rate: int = RATE) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as output:
        output.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        output.writeframes(np.round(samples * 32767).astype("<i2").tobytes())


def _read_pcm(path: Path) -> np.ndarray:
    with open_wav(path) as source:
        return np.frombuffer(source.readframes(source.getnframes()), dtype="<i2")


def _db(samples: np.ndarray) -> float:
    rms = float(np.sqrt(np.mean((samples.astype(np.float64) / 32768.0) ** 2)))
    return 20 * np.log10(max(rms, 1e-12))


def _episode(tmp_path: Path, *, room_db: float | None = ROOM_DB) -> EpisodeProject:
    """The host's mic hears a quiet room all along; the guest's voice leaks into it at 2 s."""
    project = EpisodeProject.create("room tone under a mute", str(tmp_path))
    project.ensure_dirs()
    clock = np.arange(round(DURATION * RATE)) / RATE
    rng = np.random.default_rng(7)
    room = rng.normal(0.0, 1.0, clock.size) * 10 ** (room_db / 20) if room_db is not None else 0.0
    owner = np.zeros(clock.size) + room
    mask = (clock >= 0.4) & (clock < 1.2)
    owner[mask] += 0.2 * np.sin(2 * np.pi * 173 * clock[mask])
    later = (clock >= 3.1) & (clock < 3.5)
    owner[later] += 0.09 * np.sin(2 * np.pi * 257 * clock[later])
    peer = np.zeros(clock.size)
    foreign = (clock >= FOREIGN[0]) & (clock < FOREIGN[1])
    peer[foreign] = np.random.default_rng(2).normal(0, 0.15, foreign.sum())
    owner += peer * 0.12
    for track_id, samples in (("host", owner), ("guest", peer)):
        raw = tmp_path / "raw" / f"{track_id}.wav"
        _write_pcm(raw, samples)
        project.timeline.tracks.append(
            Track(
                id=track_id,
                label=track_id,
                media=MediaAsset(path=f"raw/{track_id}.wav", duration_sec=DURATION),
                role=TrackRole.DIALOGUE,
                transcript_gate=track_id == "host",
            )
        )
        project.timeline.clips.append(
            Clip(
                id=f"clip-{track_id}",
                track_id=track_id,
                source_start=0.0,
                source_end=DURATION,
                timeline_start=0.0,
            )
        )
        stem = project.artifacts_dir() / "tracks" / f"{track_id}.wav"
        stem.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(raw, stem)
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="owner", start=0.55, end=1.0),
                TranscriptWord(
                    text="foreign",
                    start=FOREIGN[0],
                    end=FOREIGN[1],
                    suppressed=True,
                    audibility_status="bleed",
                    dominant_track="guest",
                ),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[TranscriptWord(text="foreign", start=FOREIGN[0], end=FOREIGN[1])],
        ),
    ]
    return project


def _gated(project: EpisodeProject, tmp_path: Path, defaults: dict, name: str) -> np.ndarray:
    out = tmp_path / f"{name}.wav"
    shutil.copyfile(tmp_path / "raw" / "host.wav", out)
    apply_track_transcript_gate(
        project, "host", out, timeline_start=0, timeline_end=DURATION, defaults=defaults
    )
    return _read_pcm(out)


def _inside(start: float, end: float) -> slice:
    return slice(round((start + 0.05) * RATE), round((end - 0.05) * RATE))


# --- the fill is the track's own room ---------------------------------------------


def test_a_muted_span_carries_the_tracks_room_tone_not_digital_silence(tmp_path: Path) -> None:
    project = _episode(tmp_path)
    defaults = _defaults()

    plan = build_bleed_gate_plan(project, "host", defaults=defaults)
    after = _gated(project, tmp_path, defaults, "gated")
    before = _read_pcm(tmp_path / "raw" / "host.wav")

    assert plan.reduction == "mute"
    assert plan.fill is not None, plan.fill_reason
    assert plan.fill.level_db == pytest.approx(ROOM_DB, abs=3.0)
    # Read from the lane's own pauses, which the plan says hold no copy and no voice.
    assert plan.fill.basis is not None and "own room" in plan.fill.basis
    muted = after[_inside(*FOREIGN)]
    assert np.count_nonzero(muted) > 0.9 * muted.size
    assert _db(muted) == pytest.approx(ROOM_DB, abs=3.0)
    # No other speaker is audible: the level is the room, not the room plus the guest's copy.
    assert _db(muted) < _db(before[_inside(*FOREIGN)]) - 15.0
    # The owner's own speech is untouched.
    np.testing.assert_array_equal(after[_inside(0.4, 1.2)], before[_inside(0.4, 1.2)])


def test_the_fill_ramps_in_as_the_mute_ramps_out(tmp_path: Path) -> None:
    project = _episode(tmp_path)
    defaults = _defaults()
    plan = build_bleed_gate_plan(project, "host", defaults=defaults)
    start, _end = plan.attenuation_spans[0]
    first = round(start * RATE)
    gains = plan.gains_for_frames(first, 2 * RATE // 10, RATE)
    fill = plan.fill_for_frames(first, 2 * RATE // 10, RATE, gains)

    assert fill is not None
    # Silent where the gain is full, and the fill's weight is exactly the mute's depth.
    assert fill[0] == 0.0
    muted = gains < 1.0
    assert (fill[~muted] == 0).all()
    mid = np.flatnonzero(gains == 0.0)[0]
    reference = plan.fill.noise(first, gains.size, RATE) * 32768.0
    np.testing.assert_allclose(fill[mid], reference[mid], atol=0.5)


def test_the_fill_does_not_depend_on_how_the_stem_is_read(tmp_path: Path) -> None:
    """A segment, a chunk boundary or a whole-stem pass lands on the same samples."""
    project = _episode(tmp_path)
    defaults = _defaults()
    plan = build_bleed_gate_plan(project, "host", defaults=defaults)
    raw = _read_pcm(tmp_path / "raw" / "host.wav")
    span = raw[round(1.9 * RATE) : round(2.7 * RATE)]
    whole = np.frombuffer(
        _gate_pcm_chunk(
            span.tobytes(),
            [],
            first_frame=round(1.9 * RATE),
            sample_rate=RATE,
            channels=1,
            plan=plan,
        ),
        dtype="<i2",
    )
    cut = 12_345
    pieces = np.concatenate(
        [
            np.frombuffer(
                _gate_pcm_chunk(
                    piece.tobytes(),
                    [],
                    first_frame=round(1.9 * RATE) + offset,
                    sample_rate=RATE,
                    channels=1,
                    plan=plan,
                ),
                dtype="<i2",
            )
            for offset, piece in ((0, span[:cut]), (cut, span[cut:]))
        ]
    )

    np.testing.assert_array_equal(whole, pieces)


def test_the_fill_keeps_its_spectral_density_at_another_sample_rate() -> None:
    """Noise measured at 48 kHz is realised at 16 kHz with the band that exists there."""
    psd = tuple(float(x) for x in np.full(513, 1e-6))
    fill = BleedFill("comfort_noise", -60.0, -60.0, None, 48_000, 1024, psd, "host:comfort_noise")

    levels = {
        rate: _db(np.round(fill.noise(0, 4 * rate, rate) * 32768).astype(np.int16))
        for rate in (16_000, 48_000)
    }

    assert levels[48_000] == pytest.approx(-60.0, abs=0.5)
    assert levels[16_000] - levels[48_000] == pytest.approx(10 * np.log10(16_000 / 48_000), abs=0.5)


def test_the_fill_has_nothing_above_the_band_it_was_measured_in() -> None:
    psd = tuple(float(x) for x in np.full(513, 1e-6))
    fill = BleedFill("comfort_noise", -60.0, -60.0, None, 16_000, 1024, psd, "host:comfort_noise")

    noise = fill.noise(0, 48_000, 48_000)
    spectrum = np.abs(np.fft.rfft(noise * np.hanning(noise.size))) ** 2
    freqs = np.fft.rfftfreq(noise.size, 1 / 48_000)

    assert spectrum[freqs > 8_200].sum() < 1e-6 * spectrum.sum()
    assert 10 * np.log10(np.mean(noise**2)) == pytest.approx(-60.0, abs=0.5)


# --- when there is nothing credible to fill with ----------------------------------


def test_a_track_whose_room_is_digital_silence_stays_silent(tmp_path: Path) -> None:
    project = _episode(tmp_path, room_db=None)
    defaults = _defaults()

    plan = build_bleed_gate_plan(project, "host", defaults=defaults)
    after = _gated(project, tmp_path, defaults, "gated")

    assert plan.fill is None
    assert plan.fill_reason
    np.testing.assert_array_equal(after[_inside(*FOREIGN)], 0)


def test_a_fill_that_cannot_be_measured_never_fails_the_plan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _episode(tmp_path)

    def broken(*_args: object, **_kwargs: object) -> object:
        raise RuntimeError("ffmpeg exited 1")

    monkeypatch.setattr("podcast_mcp.engines.bleed_fill.measure_bleed_fill", broken)
    plan = build_bleed_gate_plan(project, "host", defaults=_defaults())

    assert plan.fill is None
    assert "ffmpeg exited 1" in (plan.fill_reason or "")


def test_the_fill_is_whole_sixteen_bit_steps(tmp_path: Path) -> None:
    project = _episode(tmp_path)
    plan = build_bleed_gate_plan(project, "host", defaults=_defaults())
    first = int(FOREIGN[0] * RATE) - 2_400
    fill = plan.fill_for_frames(first, 12_000, RATE)

    assert fill is not None
    np.testing.assert_array_equal(fill, np.rint(fill))


def test_gate_fill_mode_off_leaves_mutes_silent(tmp_path: Path) -> None:
    project = _episode(tmp_path)
    defaults = _defaults(fill="off")

    plan = build_bleed_gate_plan(project, "host", defaults=defaults)
    after = _gated(project, tmp_path, defaults, "gated")

    assert plan.fill is None
    assert plan.fill_reason == "gate_fill.mode is off"
    np.testing.assert_array_equal(after[_inside(*FOREIGN)], 0)


def test_an_attenuating_gate_keeps_the_room_it_leaves(tmp_path: Path) -> None:
    project = _episode(tmp_path)
    defaults = _defaults(handling="attenuate")

    plan = build_bleed_gate_plan(project, "host", defaults=defaults)

    assert plan.reduction == "attenuate"
    assert plan.fill is None
    assert plan.fill_for_frames(0, RATE, RATE) is None


# --- the render hash and the dry run follow the fill ------------------------------


def test_the_render_hash_follows_the_fill_setting(tmp_path: Path) -> None:
    project = _episode(tmp_path)

    on = track_render_hash(project, "host", defaults=_defaults())
    off = track_render_hash(project, "host", defaults=_defaults(fill="off"))

    assert on != off


def test_the_dry_run_says_what_a_mute_is_filled_with(tmp_path: Path) -> None:
    project = _episode(tmp_path)
    for track_id in ("host", "guest"):
        write_stem_hash(project, track_id, defaults=_defaults())

    result = apply_transcript_bleed_mute(
        project, track_id="host", dry_run=True, defaults=_defaults()
    )

    candidate = result["candidates"][0]
    assert candidate["room_tone_fill"]["source"] == "comfort_noise"
    assert candidate["room_tone_fill_reason"] is None


# --- Bleed Restore ----------------------------------------------------------------


def test_a_restored_span_is_the_recording_again_with_no_fill_under_it() -> None:
    n = 4_800
    base = np.full((n, 1), 7, dtype="<i2")
    fill = np.full(n, 7.0, dtype=np.float32)
    whole = np.full((n, 1), 1_000, dtype="<i2")
    without = np.zeros((n, 1), dtype="<i2")
    gate_gains = np.zeros(n)

    restored = np.frombuffer(
        restored_pcm(
            base.tobytes(),
            whole.tobytes(),
            without.tobytes(),
            channels=1,
            gate_gains=gate_gains,
            restore_gains=np.ones(n),
            fill=fill,
        ),
        dtype="<i2",
    )
    untouched = np.frombuffer(
        restored_pcm(
            base.tobytes(),
            whole.tobytes(),
            without.tobytes(),
            channels=1,
            gate_gains=gate_gains,
            restore_gains=np.zeros(n),
            fill=fill,
        ),
        dtype="<i2",
    )

    assert (restored == 1_000).all()
    assert (untouched == 7).all()


def test_a_plan_with_no_fill_gates_exactly_as_before() -> None:
    plan = BleedGatePlan(attenuation_spans=((0.1, 0.5),), reduction="mute")
    samples = (np.arange(RATE, dtype=np.int64) % 2_000 - 1_000).astype("<i2")

    gated = np.frombuffer(
        _gate_pcm_chunk(
            samples.tobytes(), [], first_frame=0, sample_rate=RATE, channels=1, plan=plan
        ),
        dtype="<i2",
    )

    assert (gated[round(0.15 * RATE) : round(0.45 * RATE)] == 0).all()
    np.testing.assert_array_equal(gated[round(0.6 * RATE) :], samples[round(0.6 * RATE) :])


def test_measuring_a_tracks_room_returns_a_reason_when_it_has_no_media(tmp_path: Path) -> None:
    project = _episode(tmp_path)
    track = project.track_by_id("host")
    assert track is not None
    track.media = None

    assert measure_bleed_fill(project, track) == "no media"


def test_apply_bleed_gate_plan_is_the_one_gain_path(tmp_path: Path) -> None:
    """Stems, play segments and source proxies all go through it, so it carries the fill."""
    project = _episode(tmp_path)
    defaults = _defaults()
    plan = build_bleed_gate_plan(project, "host", defaults=defaults)
    out = tmp_path / "plan.wav"
    shutil.copyfile(tmp_path / "raw" / "host.wav", out)

    apply_bleed_gate_plan(out, plan, timeline_start=0.0, timeline_end=DURATION)

    assert _db(_read_pcm(out)[_inside(*FOREIGN)]) == pytest.approx(ROOM_DB, abs=3.0)
