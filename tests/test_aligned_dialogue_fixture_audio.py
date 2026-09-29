"""Guard the committed aligned_dialogue audio: format, ingest offsets and speech placement
inside the canned word windows (#801). Fast, default CI tier, independent of the builder.
"""

from __future__ import annotations

import json
import wave
from pathlib import Path

import numpy as np
import pytest
import yaml

from podcast_mcp.e2e_fixture import DEFAULT_CANNED, FIXTURES_DIR
from podcast_mcp.models import load_project

FIXTURE = FIXTURES_DIR / "aligned_dialogue"
SAMPLE_RATE = 48_000
DURATION_SEC = 60.0
JOIN_GAP_SEC = 0.05
WINDOW_PAD_SEC = 0.05
TRACKS = ("reference", "guest")


def _read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as wf:
        sr = wf.getframerate()
        n = wf.getnframes()
        assert wf.getnchannels() == 1
        assert wf.getsampwidth() == 2
        raw = wf.readframes(n)
    return np.frombuffer(raw, dtype=np.int16), sr


def _canned_words(track_id: str) -> list[dict]:
    canned = json.loads(DEFAULT_CANNED.read_text())
    for t in canned["per_track"]:
        if t["track_id"] == track_id:
            return t["words"]
    raise KeyError(track_id)


def _windows(words: list[dict]) -> list[tuple[float, float]]:
    """Merge canned words with gap <= JOIN_GAP_SEC into (start, end) speech windows.

    Independent re-derivation from the builder's plan_segments, on purpose: this test must
    not pass merely because it shares a bug with the generator.
    """
    ordered = sorted(words, key=lambda w: w["start"])
    windows: list[tuple[float, float]] = []
    for w in ordered:
        if windows and w["start"] - windows[-1][1] <= JOIN_GAP_SEC:
            windows[-1] = (windows[-1][0], w["end"])
        else:
            windows.append((w["start"], w["end"]))
    return windows


def _ingest_offsets() -> dict[str, float]:
    ingest = yaml.safe_load((FIXTURE / "ingest.yaml").read_text())
    return {s["name"]: float(s["session_start_in_file_sec"]) for s in ingest["speakers"]}


@pytest.mark.parametrize("track", TRACKS)
def test_raw_tracks_are_60s_48k_mono_s16(track: str) -> None:
    samples, sr = _read_wav(FIXTURE / "raw" / f"{track}.wav")
    assert sr == SAMPLE_RATE
    assert samples.size == round(DURATION_SEC * SAMPLE_RATE)


@pytest.mark.parametrize("track,source_duration_sec", [("reference", 90.0), ("guest", 180.0)])
def test_sources_pad_raw_at_ingest_offsets(track: str, source_duration_sec: float) -> None:
    raw, sr = _read_wav(FIXTURE / "raw" / f"{track}.wav")
    source, source_sr = _read_wav(FIXTURE / "sources" / f"{track}.wav")
    assert source_sr == sr == SAMPLE_RATE
    assert source.size == round(source_duration_sec * SAMPLE_RATE)

    offset = round(_ingest_offsets()[track] * sr)
    assert np.array_equal(source[offset : offset + raw.size], raw)
    assert not np.any(source[:offset])
    assert not np.any(source[offset + raw.size :])


@pytest.mark.parametrize("track", TRACKS)
def test_speech_sits_inside_canned_word_windows(track: str) -> None:
    samples, sr = _read_wav(FIXTURE / "raw" / f"{track}.wav")
    audio = samples.astype(np.float64) / 32768.0
    windows = _windows(_canned_words(track))
    widened = [(max(0.0, s - WINDOW_PAD_SEC), e + WINDOW_PAD_SEC) for s, e in windows]

    for start, end in windows:
        lo, hi = round(start * sr), round(end * sr)
        rms = float(np.sqrt(np.mean(np.square(audio[lo:hi])))) if hi > lo else 0.0
        db = 20 * np.log10(rms) if rms > 0 else float("-inf")
        assert db >= -40.0, f"{track} window {start}-{end}s is too quiet ({db:.1f} dBFS)"

    in_window = np.zeros(audio.size, dtype=bool)
    for start, end in widened:
        lo, hi = round(start * sr), round(end * sr)
        in_window[lo:hi] = True

    outside = np.abs(samples)[~in_window]
    assert outside.size == 0 or int(outside.max()) <= 32

    total_energy = float(np.sum(np.square(audio)))
    windowed_energy = float(np.sum(np.square(audio[in_window])))
    assert total_energy == 0 or windowed_energy / total_energy >= 0.99


@pytest.mark.parametrize("track", TRACKS)
def test_transcript_mirrors_match_project(track: str) -> None:
    project = load_project(FIXTURE / "episode.project.json")
    transcript = next(t for t in project.transcript_data.per_track if t.track_id == track)
    mirror_path = FIXTURE / "transcripts" / f"{track}.json"
    from podcast_mcp.models.episode import Transcript

    mirrored = Transcript.model_validate_json(mirror_path.read_text())
    assert mirrored.track_id == transcript.track_id
    assert [w.model_dump() for w in mirrored.words] == [w.model_dump() for w in transcript.words]
