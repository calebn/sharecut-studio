"""Analyze's digital-silence ratio counts a gate's silence, not a quiet recording (#1381).

Every scenario is written at several gains and read through the one entry Analyze uses
(``digital_silence_fraction``), and through ``suggest_pipeline_tuning`` for the VAD decision.
"""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines import audio_audit
from podcast_mcp.engines.asr_silence import digital_silence_fraction
from podcast_mcp.models import EpisodeProject, MediaAsset, Track, TrackRole
from podcast_mcp.services.pipeline.config import merge_pipeline_config, suggest_pipeline_tuning

RATE = 16_000
SECONDS = 20
GAINS_DB = (12.0, 0.0, -12.0, -24.0, -36.0)
VAD_OFF = merge_pipeline_config({"transcribe": {"vad": {"enabled": False}}})
ROOM_DB = -66.0
SPEECH_DB = -24.0


def _voice(audio: np.ndarray, start: float, end: float) -> None:
    lo, hi = round(start * RATE), round(end * RATE)
    t = np.arange(hi - lo) / RATE
    tone = sum(np.sin(2 * np.pi * 140.0 * k * t) / k for k in range(1, 6))
    audio[lo:hi] += tone / np.sqrt(np.mean(tone**2)) * 10 ** (SPEECH_DB / 20)


def _recording(*, gated: bool, period: float = 7.0) -> np.ndarray:
    n = SECONDS * RATE
    audio = np.zeros(n) if gated else np.random.default_rng(3).normal(0, 10 ** (ROOM_DB / 20), n)
    for start in np.arange(0.0, SECONDS - 2.0, period):
        _voice(audio, start + 1.0, start + 2.0)
    return audio


def _write(path: Path, samples: np.ndarray, gain_db: float, width: int, dither_lsb: float = 0.0):
    full = float(2 ** (8 * width - 1) - 1)
    scaled = np.clip(samples * 10 ** (gain_db / 20), -1.0, 1.0) * full
    if dither_lsb:
        rng = np.random.default_rng(11)
        scaled = scaled + rng.choice([-dither_lsb, 0.0, dither_lsb], size=scaled.size)
    ints = np.rint(scaled).astype("<i4")
    raw = (
        ints.astype("<i2").tobytes()
        if width == 2
        else ints.view(np.uint8).reshape(-1, 4)[:, :3].tobytes()
    )
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(width)
        handle.setframerate(RATE)
        handle.writeframes(raw)


def _fraction(tmp_path: Path, audio: np.ndarray, gain_db: float, width: int = 3, dither=0.0):
    path = tmp_path / f"t_{gain_db:+.0f}_{width}_{dither}.wav"
    _write(path, audio, gain_db, width, dither)
    return digital_silence_fraction(path)


@pytest.mark.parametrize("gain_db", GAINS_DB)
def test_ungated_recording_reads_as_not_silent_at_every_level(tmp_path, gain_db):
    assert _fraction(tmp_path, _recording(gated=False), gain_db) == 0.0


@pytest.mark.parametrize("gain_db", GAINS_DB)
def test_gated_recording_reads_as_gated_at_every_level(tmp_path, gain_db):
    assert _fraction(tmp_path, _recording(gated=True), gain_db) == pytest.approx(0.85, abs=0.02)


def test_one_ratio_across_levels_for_a_24_bit_file(tmp_path):
    audio = _recording(gated=False)
    assert {_fraction(tmp_path, audio, g, 3) for g in GAINS_DB} == {0.0}


def test_a_16_bit_file_keeps_its_ratio_until_the_room_is_quantized_away(tmp_path):
    audio = _recording(gated=False)
    assert {_fraction(tmp_path, audio, g, 2) for g in (12.0, 0.0, -12.0)} == {0.0}
    assert _fraction(tmp_path, audio, -36.0, 2) > 0.5


@pytest.mark.parametrize("width", [2, 3])
def test_a_gate_with_one_lsb_dither_still_reads_as_gated(tmp_path, width):
    frac = _fraction(tmp_path, _recording(gated=True), -12.0, width, dither=1.0)
    assert frac == pytest.approx(0.85, abs=0.02)


def test_sixteen_bit_dither_is_room_noise_to_a_24_bit_file(tmp_path):
    dither = 2.0**8
    assert _fraction(tmp_path, _recording(gated=True), -12.0, 3, dither=dither) == 0.0


def test_a_quiet_room_in_a_sixteen_bit_file_is_not_silent_until_it_is_quantized_away(tmp_path):
    quiet_room = np.random.default_rng(5).normal(0, 10 ** (-60 / 20), SECONDS * RATE)
    assert _fraction(tmp_path, quiet_room, 0.0, 2) == 0.0


@pytest.fixture
def stub_cleanup(monkeypatch):
    monkeypatch.setattr(
        audio_audit,
        "analyze_cleanup",
        lambda project, *, policy=None, progress=None, cancel_check=None, **_kw: {"tracks": []},
    )


def _project(tmp_path: Path, path: Path) -> EpisodeProject:
    project = EpisodeProject.create(name="t", workspace_dir=str(tmp_path))
    project.tracks.append(
        Track(
            id="solo",
            label="solo",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=str(path), duration_sec=float(SECONDS)),
        )
    )
    return project


def _decision(tmp_path: Path, gated: bool, gain_db: float, period: float = 7.0):
    path = tmp_path / f"a_{gated}_{gain_db:+.0f}_{period}.wav"
    _write(path, _recording(gated=gated, period=period), gain_db, 3)
    result = suggest_pipeline_tuning(_project(tmp_path, path), base_config=VAD_OFF)
    codes = [r["code"] for r in result["reasons"]]
    row = result["report_summary"]["tracks"][0]
    proposed = result["patches"].get("transcribe", {}).get("vad", {}).get("enabled")
    return "digital_silence" in codes, proposed, row["digital_silence_fraction"]


@pytest.mark.usefixtures("stub_cleanup")
@pytest.mark.parametrize("gain_db", GAINS_DB)
def test_vad_is_not_proposed_for_an_ungated_recording_at_any_level(tmp_path, gain_db):
    assert _decision(tmp_path, False, gain_db) == (False, None, 0.0)


@pytest.mark.usefixtures("stub_cleanup")
@pytest.mark.parametrize("gain_db", GAINS_DB)
def test_vad_is_proposed_for_a_gated_recording_at_any_level(tmp_path, gain_db):
    flagged, proposed, fraction = _decision(tmp_path, True, gain_db)
    assert (flagged, proposed) == (True, True)
    assert fraction == pytest.approx(0.85, abs=0.02)


@pytest.mark.usefixtures("stub_cleanup")
@pytest.mark.parametrize("gain_db", GAINS_DB)
def test_a_gated_track_that_is_mostly_speech_still_gets_vad(tmp_path, gain_db):
    flagged, proposed, fraction = _decision(tmp_path, True, gain_db, period=2.5)
    assert (flagged, proposed) == (True, True)
    assert fraction == pytest.approx(0.6, abs=0.03)
