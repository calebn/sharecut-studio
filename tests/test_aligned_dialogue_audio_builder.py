from __future__ import annotations

import json
import shutil
from pathlib import Path
from types import ModuleType

import numpy as np
import pytest

from podcast_mcp.e2e_fixture import DEFAULT_CANNED, FIXTURES_DIR
from podcast_mcp.models import load_project
from script_loader import load_script

FIXTURE = FIXTURES_DIR / "aligned_dialogue"


def _load_builder() -> ModuleType:
    return load_script("build_aligned_dialogue_audio", register=True)


def test_compose_preserves_entire_clip_and_silence() -> None:
    builder = _load_builder()
    clip = np.array([0, 100, -200, 400, 0], dtype=np.int16)
    audio = builder.compose_track(clip, (1.0, 4.0), duration_sec=7.0, sample_rate=2)
    np.testing.assert_array_equal(audio, [0, 0, 0, 100, -200, 400, 0, 0, 0, 100, -200, 400, 0, 0])


@pytest.mark.parametrize(
    ("placements", "duration", "message"),
    [
        ((0.0, 1.0), 10, "overlap"),
        ((-1.0,), 10, "before zero"),
        ((9.0,), 10, "past the track end"),
        ((3.0, 0.0), 10, "overlap"),
    ],
)
def test_compose_rejects_destructive_placements(placements, duration, message) -> None:
    builder = _load_builder()
    with pytest.raises(ValueError, match=message):
        builder.compose_track(
            np.array([1, 2, 3], dtype=np.int16), placements, duration_sec=duration, sample_rate=1
        )


def test_pad_source_preserves_raw_and_recorder_offset() -> None:
    builder = _load_builder()
    raw = np.array([1, -2, 3], dtype=np.int16)
    padded = builder.pad_source(raw, offset_sec=2.0, duration_sec=7.0, sample_rate=1)
    np.testing.assert_array_equal(padded, [0, 0, 1, -2, 3, 0, 0])
    with pytest.raises(ValueError, match="past the track end"):
        builder.pad_source(raw, offset_sec=6, duration_sec=7, sample_rate=1)


@pytest.mark.parametrize("suffix", [".wav", ".gold.json"])
def test_clip_rejects_tampered_audio_or_labels(tmp_path: Path, suffix: str) -> None:
    builder = _load_builder()
    clip = builder.LAYOUT[0].clip
    for extension in (".wav", ".gold.json"):
        shutil.copy(builder.GOLD_DIR / f"{clip.clip_id}{extension}", tmp_path)
    target = tmp_path / f"{clip.clip_id}{suffix}"
    target.write_bytes(target.read_bytes() + b"tampered")
    with pytest.raises(ValueError, match="SHA-256 mismatch"):
        builder.load_clip(clip, tmp_path)


def test_builder_reproduces_checked_in_audio_labels_and_mirrors(tmp_path: Path) -> None:
    builder = _load_builder()
    shutil.copy(FIXTURE / "episode.project.json", tmp_path)
    canned = tmp_path / "canned.json"
    assert builder.main(["--fixture", str(tmp_path), "--canned", str(canned)]) == 0
    project = load_project(tmp_path / "episode.project.json")
    expected_canned = json.loads(DEFAULT_CANNED.read_text())
    assert json.loads(canned.read_text()) == expected_canned
    manifest = json.loads((tmp_path / "provenance.json").read_text())
    assert manifest == json.loads((FIXTURE / "provenance.json").read_text())
    assert manifest["license"] == "CC-BY-4.0"
    for layout, transcript in zip(builder.LAYOUT, project.transcript_data.per_track, strict=True):
        original = json.loads((builder.GOLD_DIR / f"{layout.clip.clip_id}.gold.json").read_text())
        clip, _ = builder.load_clip(layout.clip, builder.GOLD_DIR)
        raw, rate = builder.read_wav_int16(tmp_path / "raw" / f"{layout.track_id}.wav")
        assert rate == 48000
        assert raw.size == 60 * 48000
        for offset in layout.placements_sec:
            start = round(offset * rate)
            np.testing.assert_array_equal(raw[start : start + clip.size], clip)
        expected_words = [
            (word["text"], round(word["start"] + offset, 8), round(word["end"] + offset, 8))
            for offset in layout.placements_sec
            for word in original["words"]
        ]
        assert [(w.text, w.start, w.end) for w in transcript.words] == expected_words
        source, source_rate = builder.read_wav_int16(
            tmp_path / "sources" / f"{layout.track_id}.wav"
        )
        start = round(layout.session_start_in_file_sec * source_rate)
        assert source.size == layout.source_duration_sec * source_rate
        np.testing.assert_array_equal(source[start : start + raw.size], raw)
        assert np.count_nonzero(source[:start]) == 0
        assert np.count_nonzero(source[start + raw.size :]) == 0
        mirror = tmp_path / "transcripts" / f"{layout.track_id}.json"
        assert json.loads(mirror.read_text()) == transcript.model_dump(mode="json", by_alias=True)
    assert project.transcript_data.combined is not None
    assert json.loads((tmp_path / "transcripts" / "combined.json").read_text()) == (
        project.transcript_data.combined.model_dump(mode="json", by_alias=True)
    )
    for relative, digest in manifest["output_sha256"].items():
        assert builder.sha256(tmp_path / relative) == digest
        assert (tmp_path / relative).read_bytes() == (FIXTURE / relative).read_bytes()
    first_project = (tmp_path / "episode.project.json").read_bytes()
    first_manifest = (tmp_path / "provenance.json").read_bytes()
    builder.main(["--fixture", str(tmp_path), "--canned", str(canned)])
    assert (tmp_path / "episode.project.json").read_bytes() == first_project
    assert (tmp_path / "provenance.json").read_bytes() == first_manifest
