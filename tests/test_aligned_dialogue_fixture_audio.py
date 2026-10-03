from __future__ import annotations

import hashlib
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


@pytest.mark.parametrize(
    "track,utterance,offsets,source_sha256",
    [
        (
            "reference",
            "6241-61943-0003",
            (2.0, 35.0),
            "8d1217eb43a8e46f825bc25cdf2cfed9d2f797520e1c0e1624cbf22208468540",
        ),
        (
            "guest",
            "1988-147956-0023",
            (8.0, 43.0),
            "60726751a107f923f62d1f4c271751c07ae4c6ec511d4ba009e8182720184f53",
        ),
    ],
)
def test_tracks_and_labels_match_recorded_corpus(
    track: str, utterance: str, offsets: tuple[float, ...], source_sha256: str
) -> None:
    source = FIXTURES_DIR / "word_boundary" / f"{utterance}.wav"
    assert hashlib.sha256(source.read_bytes()).hexdigest() == source_sha256
    original, original_rate = _read_wav(source)
    assert original_rate == 16000
    speech = np.array(
        [
            (
                (3 - phase) * int(sample)
                + phase * int(original[min(index + 1, original.size - 1)])
                + 1
            )
            // 3
            for index, sample in enumerate(original)
            for phase in range(3)
        ],
        dtype=np.int16,
    )
    expected = np.zeros(round(DURATION_SEC * SAMPLE_RATE), dtype=np.int16)
    for offset in offsets:
        start = round(offset * SAMPLE_RATE)
        expected[start : start + speech.size] = speech
    actual, sr = _read_wav(FIXTURE / "raw" / f"{track}.wav")
    assert sr == SAMPLE_RATE
    assert np.array_equal(actual, expected)

    gold_path = source.with_suffix(".gold.json")
    provenance = json.loads((FIXTURE / "provenance.json").read_text(encoding="utf-8"))
    recorded = next(t for t in provenance["tracks"] if t["track_id"] == track)
    assert recorded["clip_id"] == utterance
    assert recorded["audio_sha256"] == source_sha256
    assert recorded["gold_sha256"] == hashlib.sha256(gold_path.read_bytes()).hexdigest()
    assert recorded["placements_sec"] == list(offsets)
    assert recorded["resampled_frames"] == speech.size
    for relative in (f"raw/{track}.wav", f"sources/{track}.wav"):
        assert (
            hashlib.sha256((FIXTURE / relative).read_bytes()).hexdigest()
            == (provenance["output_sha256"][relative])
        )
    gold = json.loads(gold_path.read_text(encoding="utf-8"))
    expected_words = [
        (word["text"], round(offset + word["start"], 4), round(offset + word["end"], 4))
        for offset in offsets
        for word in gold["words"]
    ]
    canned = _canned_words(track)
    assert [(w["text"].lower().strip(".!?"), w["start"], w["end"]) for w in canned] == (
        expected_words
    )


@pytest.mark.parametrize("track", TRACKS)
def test_transcript_mirrors_match_project(track: str) -> None:
    project = load_project(FIXTURE / "episode.project.json")
    transcript = next(t for t in project.transcript_data.per_track if t.track_id == track)
    mirror_path = FIXTURE / "transcripts" / f"{track}.json"
    from podcast_mcp.models.episode import Transcript

    mirrored = Transcript.model_validate_json(mirror_path.read_text())
    assert mirrored.track_id == transcript.track_id
    assert [w.model_dump() for w in mirrored.words] == [w.model_dump() for w in transcript.words]
    assert [(w.text, w.start, w.end) for w in transcript.words] == [
        (w["text"], w["start"], w["end"]) for w in _canned_words(track)
    ]
    assert all(w.confidence == 0.95 for w in transcript.words)
