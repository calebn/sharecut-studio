"""Unit tests for scripts/build_aligned_dialogue_audio.py (#801).

Fast: no Piper, no ffmpeg, no network. Uses a fake synthesizer whose duration scales
linearly with ``length_scale``, like Piper's own ``SynthesisConfig.length_scale``.
"""

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
FAKE_SR = 22050
FAKE_PAD_SEC = 0.03
FAKE_SEC_PER_WORD = 0.08


def _load_builder() -> ModuleType:
    # register=True: Segment is a frozen dataclass under `from __future__ import
    # annotations`, and dataclass field resolution needs the module in sys.modules.
    return load_script("build_aligned_dialogue_audio", register=True)


def _make_fake_synthesizer(*, ignore_scale: bool = False):
    """A tone synthesizer whose active speech duration is ``FAKE_SEC_PER_WORD`` per word,
    scaled by ``length_scale`` (like real Piper), padded with silence on both sides.
    """
    calls: list[tuple[str, float]] = []

    def synthesize(text: str, scale: float) -> tuple[np.ndarray, int]:
        calls.append((text, scale))
        effective_scale = 1.0 if ignore_scale else scale
        n_words = len(text.split())
        active_sec = FAKE_SEC_PER_WORD * n_words * effective_scale
        n_active = max(round(active_sec * FAKE_SR), 1)
        t = np.arange(n_active) / FAKE_SR
        tone = (0.5 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
        pad = np.zeros(round(FAKE_PAD_SEC * FAKE_SR), dtype=np.float32)
        return np.concatenate([pad, tone, pad]), FAKE_SR

    return synthesize, calls


def _canned_words(track_id: str) -> list[dict]:
    canned = json.loads(DEFAULT_CANNED.read_text())
    for t in canned["per_track"]:
        if t["track_id"] == track_id:
            return t["words"]
    raise KeyError(track_id)


def test_plan_segments_groups_fast_runs_and_splits_slow_words() -> None:
    bld = _load_builder()

    reference = bld.plan_segments(_canned_words("reference"))
    assert len(reference) == 19
    assert (reference[0].text, reference[0].start, reference[0].end) == (
        "welcome to the show",
        2.0,
        3.2,
    )
    assert (reference[-1].text, reference[-1].start, reference[-1].end) == (
        "how is today going",
        23.0,
        23.9,
    )
    by_text = {seg.text: seg for seg in reference}
    assert by_text["um"].start == pytest.approx(22.0)
    assert by_text["um"].end == pytest.approx(22.2)
    # "so" .. "change" are all singles: 16 words, none merged (1.0s/word, not < 0.5s).
    singles = [s for s in reference if s.text not in {"welcome to the show", "how is today going"}]
    assert len(singles) == 17  # 16 mid words + "um"
    assert all(" " not in s.text for s in singles)

    guest = bld.plan_segments(_canned_words("guest"))
    by_text_g = {seg.text: seg for seg in guest}
    assert by_text_g["life been great"].start == pytest.approx(21.5)
    assert by_text_g["life been great"].end == pytest.approx(22.4)
    assert "documented" in by_text_g
    assert "people" in by_text_g
    assert by_text_g["documented"].start == pytest.approx(43.0)
    assert by_text_g["people"].start == pytest.approx(43.5)


def test_trim_silence_strips_edges_and_handles_silence() -> None:
    bld = _load_builder()

    loud = np.array([0.9, 0.8, 0.7], dtype=np.float32)
    audio = np.concatenate([np.zeros(10, dtype=np.float32), loud, np.zeros(10, dtype=np.float32)])
    trimmed = bld.trim_silence(audio)
    assert np.array_equal(trimmed, loud)

    silence = np.zeros(50, dtype=np.float32)
    assert bld.trim_silence(silence).size == 0


def test_fit_segment_speeds_up_then_truncates_long_speech(capsys) -> None:
    bld = _load_builder()

    # A 2.0s slot: target = 2.0 - ONSET_PAD_SEC - TAIL_GUARD_SEC.
    segment = bld.Segment("one two three four five six seven eight nine ten " * 3, 0.0, 2.0)
    target = 2.0 - bld.ONSET_PAD_SEC - bld.TAIL_GUARD_SEC

    synth, calls = _make_fake_synthesizer()
    audio, sr = bld.fit_segment(segment, synth)
    assert audio.size / sr <= target + 1e-9
    assert len(calls) == 2
    assert calls[0][1] == 1.0
    assert calls[1][1] < 1.0
    assert "truncat" not in capsys.readouterr().err

    ignoring_synth, _ = _make_fake_synthesizer(ignore_scale=True)
    audio2, sr2 = bld.fit_segment(segment, ignoring_synth)
    assert audio2.size <= round(target * sr2)
    assert "truncat" in capsys.readouterr().err


def test_fit_segment_truncates_to_the_loudest_window_not_the_head() -> None:
    """A word squeezed into a slot much shorter than its natural length (e.g. "um" against
    a 0.2s canned slot) should keep its loudest content, not whatever a fixed head-cut lands on.
    """
    bld = _load_builder()
    sr = FAKE_SR
    n_quiet = int(0.3 * sr)
    n_loud = int(0.2 * sr)
    quiet = 0.05 * np.ones(n_quiet, dtype=np.float32)
    loud = 0.9 * np.ones(n_loud, dtype=np.float32)

    def synth(text: str, scale: float) -> tuple[np.ndarray, int]:
        return np.concatenate([quiet, loud]), sr

    segment = bld.Segment("um", 0.0, 0.2)  # target ~= 0.14s, well under either part alone
    audio, out_sr = bld.fit_segment(segment, synth)
    assert out_sr == sr
    # The fitted (faded) clip should be dominated by the loud tail, not the quiet head.
    assert np.abs(audio).max() == pytest.approx(0.9, abs=1e-6)


def test_loudest_window_picks_the_highest_energy_slice() -> None:
    bld = _load_builder()
    audio = np.array([0.1, 0.1, 0.9, 0.9, 0.1], dtype=np.float32)
    window = bld._loudest_window(audio, 2)
    assert np.array_equal(window, np.array([0.9, 0.9], dtype=np.float32))


def test_render_track_places_speech_inside_canned_windows() -> None:
    bld = _load_builder()
    segments = bld.plan_segments(_canned_words("reference"))
    synth, _ = _make_fake_synthesizer()

    audio, sr = bld.render_track(segments, synth, duration_sec=60.0)
    assert audio.size == round(60.0 * sr)
    assert np.abs(audio).max() == pytest.approx(bld.TARGET_PEAK)

    windows = [(seg.start + bld.ONSET_PAD_SEC, seg.end - bld.TAIL_GUARD_SEC) for seg in segments]
    nonzero_idx = np.flatnonzero(audio != 0.0)
    for idx in nonzero_idx:
        t = idx / sr
        assert any(start - 1e-6 <= t <= end + 1e-6 for start, end in windows), t

    for start, end in windows:
        lo, hi = round(start * sr), round(end * sr)
        assert np.abs(audio[lo:hi]).sum() > 0


def test_render_track_rejects_overlap_and_mixed_rates() -> None:
    bld = _load_builder()
    synth, _ = _make_fake_synthesizer()

    overlapping = [
        bld.Segment("one two three four five six seven eight nine ten", 0.0, 1.0),
        bld.Segment("hi", 0.5, 1.5),
    ]
    with pytest.raises(ValueError, match="overlap"):
        bld.render_track(overlapping, synth, duration_sec=10.0)

    calls = {"n": 0}

    def mixed_rate_synth(text: str, scale: float) -> tuple[np.ndarray, int]:
        calls["n"] += 1
        sr = FAKE_SR if calls["n"] == 1 else FAKE_SR * 2
        return np.array([0.5, 0.4, 0.3], dtype=np.float32), sr

    two_segments = [
        bld.Segment("hi", 0.0, 1.0),
        bld.Segment("bye", 2.0, 3.0),
    ]
    with pytest.raises(ValueError, match="sample rate"):
        bld.render_track(two_segments, mixed_rate_synth, duration_sec=10.0)


def test_pad_source_and_exact_length() -> None:
    bld = _load_builder()

    raw = np.array([1, 2, 3, 4, 5], dtype=np.int16)
    padded = bld.pad_source(raw, offset_sec=0.5, duration_sec=4.0, sample_rate=2)
    assert padded.size == 8
    assert padded[0] == 0
    assert np.array_equal(padded[1:6], raw)
    assert np.array_equal(padded[6:8], np.zeros(2, dtype=np.int16))

    with pytest.raises(ValueError):
        bld.pad_source(raw, offset_sec=3.0, duration_sec=4.0, sample_rate=2)

    short = np.array([1, 2, 3], dtype=np.int16)
    assert np.array_equal(bld.exact_length(short, 5), np.array([1, 2, 3, 0, 0], dtype=np.int16))
    long = np.array([1, 2, 3, 4, 5], dtype=np.int16)
    assert np.array_equal(bld.exact_length(long, 3), np.array([1, 2, 3], dtype=np.int16))
    same = np.array([1, 2, 3], dtype=np.int16)
    assert bld.exact_length(same, 3) is same


def test_write_transcript_mirrors_matches_project_store(tmp_path: Path) -> None:
    bld = _load_builder()

    shutil.copy(FIXTURE / "episode.project.json", tmp_path / "episode.project.json")
    shutil.copytree(FIXTURE / "transcripts", tmp_path / "transcripts")
    shutil.copy(FIXTURE / "fixture.meta.json", tmp_path / "fixture.meta.json")
    shutil.copy(FIXTURE / "ingest.yaml", tmp_path / "ingest.yaml")
    before = (tmp_path / "episode.project.json").read_bytes()
    (tmp_path / "transcripts" / "combined.json").write_text("stale")

    bld.write_transcript_mirrors(tmp_path)

    project = load_project(tmp_path / "episode.project.json")
    assert project.transcript_data.combined is not None
    assert (tmp_path / "transcripts" / "combined.json").read_bytes() == (
        project.transcript_data.combined.model_dump_json(indent=2, by_alias=True).encode("utf-8")
    )
    for transcript in project.transcript_data.per_track:
        if not transcript.words:
            continue
        expected = transcript.model_dump_json(indent=2, by_alias=True).encode("utf-8")
        actual = (tmp_path / "transcripts" / f"{transcript.track_id}.json").read_bytes()
        assert actual == expected

    assert (tmp_path / "episode.project.json").read_bytes() == before


def test_main_regenerates_audio_and_transcript_mirrors(tmp_path: Path, monkeypatch) -> None:
    bld = _load_builder()
    for name in ("episode.project.json", "fixture.meta.json", "ingest.yaml"):
        shutil.copy(FIXTURE / name, tmp_path / name)
    synth, calls = _make_fake_synthesizer()
    monkeypatch.setattr(bld, "download_voice", lambda _voice: tmp_path / "fake.onnx")
    monkeypatch.setattr(bld, "piper_synthesizer", lambda _path: synth)
    monkeypatch.setattr(bld, "SAMPLE_RATE", FAKE_SR)

    assert bld.main(["--fixture", str(tmp_path)]) == 0
    assert calls
    for track, source_duration in (("reference", 90), ("guest", 180)):
        raw, rate = bld.read_wav_int16(tmp_path / "raw" / f"{track}.wav")
        source, source_rate = bld.read_wav_int16(tmp_path / "sources" / f"{track}.wav")
        assert rate == source_rate == FAKE_SR
        assert raw.size == 60 * FAKE_SR
        assert source.size == source_duration * FAKE_SR
        assert np.max(np.abs(raw)) > 1000
        assert (tmp_path / "transcripts" / f"{track}.json").is_file()
    assert (tmp_path / "transcripts" / "combined.json").is_file()
