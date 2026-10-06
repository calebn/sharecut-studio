"""#945: foreign dialogue on a lane is turned down by a fixed amount, not gated to silence."""

from __future__ import annotations

import shutil
from pathlib import Path

import numpy as np
import pytest
import yaml

from podcast_mcp.config import load_defaults
from podcast_mcp.engines.bleed_gate import build_bleed_gate_plan
from podcast_mcp.engines.transcript_gated_play import apply_track_transcript_gate
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from test_bleed_gate_regression import RATE, _read_pcm, _write_pcm

DURATION = 4.0
FOREIGN = (1.0, 3.0)


def _speech(start: float, end: float, seed: int) -> np.ndarray:
    """Syllable-rate noise bursts, so level envelopes rise and fall like a voice."""
    clock = np.arange(int(DURATION * RATE)) / RATE
    inside = (clock >= start) & (clock < end)
    envelope = 0.5 * (1 - np.cos(2 * np.pi * 4 * (clock - start)))
    noise = np.random.default_rng(seed).normal(0, 0.25, clock.size)
    return np.where(inside, noise * envelope, 0.0)


def _colored(samples: np.ndarray) -> np.ndarray:
    """Room coloration: a short reflection and a gentle low-pass."""
    reflected = samples + 0.4 * np.roll(samples, int(0.003 * RATE))
    return np.convolve(reflected, np.ones(6) / 6, mode="same")


def _episode(
    tmp_path: Path,
    *,
    direct_lag_sec: float = 0.0,
    colored: bool = False,
    direct_gated_until: float | None = None,
    own_overlap: tuple[float, float] | None = None,
) -> EpisodeProject:
    """Host mic carries guest bleed 18 dB down; the guest's own track may run late or gate late."""
    project = EpisodeProject.create("bleed attenuation", str(tmp_path))
    project.ensure_dirs()
    clock = np.arange(int(DURATION * RATE)) / RATE
    voice = _speech(*FOREIGN, seed=7)
    direct = np.roll(voice, round(direct_lag_sec * RATE))
    if direct_gated_until is not None:
        direct[clock < direct_gated_until + direct_lag_sec] = 0.0
    host = 0.12 * (_colored(voice) if colored else voice)
    owner = (clock >= 0.2) & (clock < 0.7)
    host[owner] += 0.2 * np.sin(2 * np.pi * 173 * clock[owner])
    if own_overlap is not None:
        overlap = (clock >= own_overlap[0]) & (clock < own_overlap[1])
        host[overlap] += 0.5 * np.sin(2 * np.pi * 191 * clock[overlap])
    for track_id, samples in (("host", host), ("guest", direct)):
        _write_pcm(tmp_path / "raw" / f"{track_id}.wav", samples)
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
    bleed = {
        "suppressed": True,
        "audibility_status": "bleed",
        "dominant_track": "guest",
    }
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="mine", start=0.25, end=0.65),
                TranscriptWord(text="and", start=1.0, end=2.0, **bleed),
                TranscriptWord(text="then", start=2.0, end=3.0, **bleed),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text="and", start=1.0 + direct_lag_sec, end=2.0 + direct_lag_sec),
                TranscriptWord(text="then", start=2.0 + direct_lag_sec, end=3.0 + direct_lag_sec),
            ],
        ),
    ]
    return project


def _gated(project: EpisodeProject, tmp_path: Path) -> tuple[np.ndarray, np.ndarray]:
    source = tmp_path / "raw" / "host.wav"
    output = tmp_path / "gated.wav"
    shutil.copyfile(source, output)
    apply_track_transcript_gate(project, "host", output, timeline_start=0, timeline_end=DURATION)
    return _read_pcm(source).astype(float), _read_pcm(output).astype(float)


def _gain_db(before: np.ndarray, after: np.ndarray, start: float, end: float) -> float:
    window = slice(round(start * RATE), round(end * RATE))
    energy = float(np.sum(before[window] ** 2))
    return 10 * np.log10(float(np.sum(after[window] ** 2)) / energy)


@pytest.mark.parametrize(
    ("direct_lag_sec", "colored"),
    [
        pytest.param(0.0, False, id="exact-copy"),
        pytest.param(0.14, True, id="colored-copy-direct-track-140ms-late"),
    ],
)
def test_foreign_copy_on_silent_owner_span_is_turned_down_by_20_db(
    tmp_path: Path, direct_lag_sec: float, colored: bool
) -> None:
    project = _episode(tmp_path, direct_lag_sec=direct_lag_sec, colored=colored)
    before, after = _gated(project, tmp_path)
    assert _gain_db(before, after, 1.05, 2.95) == pytest.approx(-20.0, abs=0.2)
    np.testing.assert_array_equal(after[: round(0.95 * RATE)], before[: round(0.95 * RATE)])
    np.testing.assert_array_equal(after[round(3.05 * RATE) :], before[round(3.05 * RATE) :])


def test_attenuation_amount_comes_from_pipeline_defaults(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    defaults = load_defaults()
    defaults["analysis"]["heuristics"]["bleed_attenuation_db"] = 12.0
    config = tmp_path / "pipeline.yaml"
    config.write_text(yaml.safe_dump(defaults))
    monkeypatch.setenv("PODCAST_MCP_PIPELINE_DEFAULTS", str(config))
    project = _episode(tmp_path)
    before, after = _gated(project, tmp_path)
    assert _gain_db(before, after, 1.05, 2.95) == pytest.approx(-12.0, abs=0.2)


def test_track_speakers_own_speech_is_untouched(tmp_path: Path) -> None:
    project = _episode(tmp_path, own_overlap=(1.8, 2.2))
    before, after = _gated(project, tmp_path)
    np.testing.assert_array_equal(
        after[round(0.2 * RATE) : round(0.7 * RATE)], before[round(0.2 * RATE) : round(0.7 * RATE)]
    )
    np.testing.assert_array_equal(
        after[round(1.8 * RATE) : round(2.2 * RATE)], before[round(1.8 * RATE) : round(2.2 * RATE)]
    )
    assert _gain_db(before, after, 1.05, 1.6) == pytest.approx(-20.0, abs=0.2)
    assert _gain_db(before, after, 2.4, 2.95) == pytest.approx(-20.0, abs=0.2)


def test_late_gate_on_the_direct_track_still_turns_the_foreign_copy_down(tmp_path: Path) -> None:
    project = _episode(tmp_path, direct_gated_until=1.15)
    before, after = _gated(project, tmp_path)
    assert _gain_db(before, after, 1.02, 1.15) == pytest.approx(-20.0, abs=0.2)
    assert _gain_db(before, after, 1.15, 2.95) == pytest.approx(-20.0, abs=0.2)


def test_level_without_a_matching_copy_is_not_foreign_evidence(tmp_path: Path) -> None:
    project = _episode(tmp_path)
    unrelated = _speech(*FOREIGN, seed=99)
    _write_pcm(tmp_path / "raw" / "guest.wav", np.roll(unrelated, round(0.9 * RATE)))
    plan = build_bleed_gate_plan(project, "host")
    assert plan.attenuation_spans == ()
    assert plan.reasons == ("uncertain_foreign_ownership",)


def test_copy_between_asr_word_spans_is_turned_down_with_the_words(tmp_path: Path) -> None:
    project = _episode(tmp_path, direct_lag_sec=0.14)
    host_words = project.transcript_for_track("host").words
    host_words[1].end = 1.6
    host_words[2].start = 2.4
    before, after = _gated(project, tmp_path)
    assert _gain_db(before, after, 1.6, 2.4) == pytest.approx(-20.0, abs=0.2)
