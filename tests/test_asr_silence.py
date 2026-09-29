from __future__ import annotations

import wave

import numpy as np
import pytest

from podcast_mcp.engines.asr_options import AsrOptions
from podcast_mcp.engines.asr_silence import (
    below_evidence_floor,
    digital_silence_fraction,
    flag_silent_words_in_file,
    flag_words_over_silence,
    flag_words_without_acoustic_evidence,
    peak_envelope,
    refresh_silence_flags,
    silence_filter_fingerprint,
    silent_fraction,
)
from podcast_mcp.models import TranscriptWord
from two_mic_project import two_mic_project

SR = 8000


class _Evidence:
    """A fixed answer to `has_speech`, for tests that exercise the flag logic alone."""

    def __init__(self, speech: bool) -> None:
        self.speech = speech
        self.asked: list[tuple[str, float, float]] = []

    def has_speech(self, track_id: str, start: float, end: float) -> bool:
        self.asked.append((track_id, start, end))
        return self.speech


NO_SPEECH = _Evidence(False)


def _w(start: float, end: float) -> TranscriptWord:
    return TranscriptWord(text="x", start=start, end=end)


def _audio() -> np.ndarray:
    """0-1 s zeros, 1-2 s tone."""
    t = np.arange(SR) / SR
    tone = (0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    return np.concatenate([np.zeros(SR, dtype=np.float32), tone])


def test_flags_zero_span_not_tone():
    words = [_w(0.2, 0.5), _w(1.2, 1.5)]
    assert flag_words_over_silence(words, _audio(), SR, peak_dbfs=-60.0) == 1
    assert [w.suspect_hallucination for w in words] == [True, False]


def test_min_span_widens_zero_length_word():
    words = [_w(1.0, 1.0)]  # widened to 50 ms, so it reaches into the tone
    assert flag_words_over_silence(words, _audio(), SR, peak_dbfs=-60.0) == 0
    assert not words[0].suspect_hallucination


def test_stale_flag_reset_and_past_end_stays_false():
    words = [_w(1.2, 1.5), _w(5.0, 5.5)]
    words[0].suspect_hallucination = True
    words[1].suspect_hallucination = True
    assert flag_words_over_silence(words, _audio(), SR, peak_dbfs=-60.0) == 0
    assert not any(w.suspect_hallucination for w in words)


def test_threshold_respected():
    quiet = np.full(SR, 0.001, dtype=np.float32)  # -60 dBFS peak
    assert flag_words_over_silence([_w(0.1, 0.4)], quiet, SR, peak_dbfs=-50.0) == 1
    assert flag_words_over_silence([_w(0.1, 0.4)], quiet, SR, peak_dbfs=-70.0) == 0


def test_file_wrapper_success_and_failure(monkeypatch, tmp_path, caplog):
    from podcast_mcp.engines import asr_silence

    monkeypatch.setattr(asr_silence, "peak_envelope", lambda path: (_audio(), float(SR)))
    words = [_w(0.2, 0.5)]
    assert flag_silent_words_in_file(words, tmp_path / "a.wav", peak_dbfs=-60.0) == 1

    def boom(*a, **k):
        raise RuntimeError("no decode")

    monkeypatch.setattr(asr_silence, "peak_envelope", boom)
    with caplog.at_level("WARNING"):
        assert flag_silent_words_in_file(words, tmp_path / "a.wav", peak_dbfs=-60.0) is None
    assert "silence filter skipped" in caplog.text


def test_peak_envelope_native_rate_stereo_high_frequency(tmp_path):
    sr = 44100
    t = np.arange(sr) / sr
    sine = np.round(0.003 * 32767 * np.sin(2 * np.pi * 6000 * t)).astype("<i2")
    zeros = np.zeros(sr, dtype="<i2")
    left = np.concatenate([zeros, zeros])
    right = np.concatenate([zeros, sine])
    path = tmp_path / "s.wav"
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(np.column_stack([left, right]).astype("<i2").tobytes())
    peaks, rate = peak_envelope(path)
    assert rate == pytest.approx(100.0)
    assert peaks.size == 200
    assert float(peaks[:100].max()) == 0.0
    assert float(peaks[100:].max()) > 10 ** (-60 / 20)
    words = [_w(0.2, 0.5), _w(1.2, 1.5)]
    assert flag_silent_words_in_file(words, path, peak_dbfs=-60.0) == 1
    assert [w.suspect_hallucination for w in words] == [True, False]


def test_real_decode_of_tone(sample_wav):
    words = [_w(0.5, 1.0)]
    assert flag_silent_words_in_file(words, sample_wav, peak_dbfs=-60.0) == 0
    assert not words[0].suspect_hallucination


def test_silent_fraction_counts_blocks_below_floor():
    peaks = np.array([0.0, 1e-5, 0.5, 0.2], dtype=np.float32)
    assert silent_fraction(peaks, peak_dbfs=-60.0) == 0.5
    assert silent_fraction(np.array([], dtype=np.float32), peak_dbfs=-60.0) == 0.0


def test_digital_silence_fraction_real_decode(tmp_path):
    sr = 8000
    zeros = np.zeros(sr * 3, dtype=np.float32)
    t = np.arange(sr) / sr
    tone = (0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    samples = np.concatenate([zeros, tone])
    ints = np.round(samples * 32767).astype("<i2")
    path = tmp_path / "mostly_silent.wav"
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(ints.tobytes())

    frac = digital_silence_fraction(path, peak_dbfs=-60.0)
    assert frac is not None
    assert 0.70 <= frac <= 0.80


def test_digital_silence_fraction_undecodable(monkeypatch, tmp_path, caplog):
    from podcast_mcp.engines import asr_silence

    def boom(*a, **k):
        raise RuntimeError("no decode")

    monkeypatch.setattr(asr_silence, "peak_envelope", boom)
    asr_silence._cached_silent_fraction.cache_clear()
    p = tmp_path / "a.wav"
    p.write_bytes(b"x")
    with caplog.at_level("WARNING"):
        result = asr_silence.digital_silence_fraction(p, peak_dbfs=-60.0)
    assert result is None
    assert "digital silence measure skipped" in caplog.text


def test_digital_silence_fraction_cached_per_file_version(monkeypatch, tmp_path):
    import os

    from podcast_mcp.engines import asr_silence

    asr_silence._cached_silent_fraction.cache_clear()
    calls = []

    def fake_envelope(path, **_k):
        calls.append(path)
        return np.array([0.0, 0.0, 0.0, 0.5], dtype=np.float32), 100.0

    monkeypatch.setattr(asr_silence, "peak_envelope", fake_envelope)
    p = tmp_path / "a.wav"
    p.write_bytes(b"x")
    assert asr_silence.digital_silence_fraction(p, peak_dbfs=-60.0) == 0.75
    assert asr_silence.digital_silence_fraction(p, peak_dbfs=-60.0) == 0.75
    assert len(calls) == 1
    st = p.stat()
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
    asr_silence.digital_silence_fraction(p, peak_dbfs=-60.0)
    assert len(calls) == 2
    asr_silence.digital_silence_fraction(p, peak_dbfs=-50.0)
    assert len(calls) == 3
    asr_silence._cached_silent_fraction.cache_clear()


def test_digital_silence_fraction_cache_misses_on_atomic_replace(monkeypatch, tmp_path):
    import os

    from podcast_mcp.engines import asr_silence

    asr_silence._cached_silent_fraction.cache_clear()
    calls = []

    def fake_envelope(path, **_k):
        calls.append(path)
        return np.array([0.0, 0.5], dtype=np.float32), 100.0

    monkeypatch.setattr(asr_silence, "peak_envelope", fake_envelope)
    p = tmp_path / "a.wav"
    p.write_bytes(b"x")
    asr_silence.digital_silence_fraction(p, peak_dbfs=-60.0)
    st = p.stat()
    replacement = tmp_path / "a.wav.tmp"
    replacement.write_bytes(b"y")  # same size
    os.utime(replacement, ns=(st.st_atime_ns, st.st_mtime_ns))  # same mtime
    os.replace(replacement, p)
    assert p.stat().st_size == st.st_size and p.stat().st_mtime_ns == st.st_mtime_ns
    asr_silence.digital_silence_fraction(p, peak_dbfs=-60.0)
    assert len(calls) == 2  # new inode -> cache miss
    asr_silence._cached_silent_fraction.cache_clear()


def test_digital_silence_fraction_cache_misses_on_in_place_rewrite(monkeypatch, tmp_path):
    import os

    from podcast_mcp.engines import asr_silence

    asr_silence._cached_silent_fraction.cache_clear()
    calls = []

    def fake_envelope(path, **_k):
        calls.append(path)
        return np.array([0.0, 0.5], dtype=np.float32), 100.0

    monkeypatch.setattr(asr_silence, "peak_envelope", fake_envelope)
    p = tmp_path / "a.wav"
    p.write_bytes(b"x")
    asr_silence.digital_silence_fraction(p, peak_dbfs=-60.0)
    st = p.stat()
    with p.open("r+b") as fh:  # same inode, same size
        fh.write(b"y")
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns))  # same mtime
    after = p.stat()
    assert (after.st_ino, after.st_size, after.st_mtime_ns) == (
        st.st_ino,
        st.st_size,
        st.st_mtime_ns,
    )
    asr_silence.digital_silence_fraction(p, peak_dbfs=-60.0)
    assert len(calls) == 2  # content digest changed -> cache miss
    asr_silence._cached_silent_fraction.cache_clear()


def test_digital_silence_fraction_missing_file(tmp_path, caplog):
    with caplog.at_level("WARNING"):
        assert digital_silence_fraction(tmp_path / "nope.wav", peak_dbfs=-60.0) is None
    assert "digital silence measure skipped" in caplog.text


def test_refresh_silence_flags_off_clears_and_on_reflags(monkeypatch, tmp_path):
    from podcast_mcp.engines import asr_silence

    monkeypatch.setattr(asr_silence, "peak_envelope", lambda path: (_audio(), float(SR)))
    words = [_w(0.2, 0.5)]
    words[0].suspect_hallucination = True
    path = tmp_path / "a.wav"
    assert refresh_silence_flags(words, path, AsrOptions(silence_filter_enabled=False)) == 0
    assert words[0].suspect_hallucination is False
    assert refresh_silence_flags(words, path, AsrOptions()) == 1
    assert words[0].suspect_hallucination is True


def test_evidence_flag_ors_with_silence_flag(monkeypatch, tmp_path):
    from podcast_mcp.engines import asr_silence

    monkeypatch.setattr(asr_silence, "peak_envelope", lambda path: (_audio(), float(SR)))
    tone = _w(1.2, 1.5)
    tone.alignment_score = 0.001
    clear = _w(1.6, 1.9)
    clear.alignment_score = 0.9
    silent = _w(0.2, 0.5)
    silent.alignment_score = None
    words = [tone, clear, silent]
    path = tmp_path / "a.wav"

    n = refresh_silence_flags(words, path, AsrOptions(), evidence=NO_SPEECH, track_id="host")

    assert [w.suspect_hallucination for w in words] == [True, False, True]
    assert n == 2

    # A word that is silent *and* scored low stays True.
    words2 = [_w(0.2, 0.5)]
    words2[0].alignment_score = 0.001
    assert refresh_silence_flags(words2, path, AsrOptions(), evidence=NO_SPEECH) == 1
    assert words2[0].suspect_hallucination is True


def test_low_score_alone_never_flags_a_word_with_own_speech(monkeypatch, tmp_path):
    """#780: a 1-4 frame "um" scores below the floor; the audio, not the score, decides."""
    from podcast_mcp.engines import asr_silence

    monkeypatch.setattr(asr_silence, "peak_envelope", lambda path: (_audio(), float(SR)))
    um = _w(1.2, 1.24)
    um.alignment_score = 0.0
    path = tmp_path / "a.wav"
    spoken = _Evidence(True)

    assert refresh_silence_flags([um], path, AsrOptions(), evidence=spoken, track_id="host") == 0
    assert um.suspect_hallucination is False
    assert spoken.asked == [("host", 1.2, 1.24)]

    assert refresh_silence_flags([um], path, AsrOptions(), evidence=None, track_id="host") == 0
    assert um.suspect_hallucination is False


def test_below_evidence_floor_truth_table() -> None:
    assert below_evidence_floor(0.004, 0.01)
    assert not below_evidence_floor(0.01, 0.01)
    assert not below_evidence_floor(None, 0.01)
    assert not below_evidence_floor(0.0, 0.0)
    assert not below_evidence_floor(0.0, -1.0)


def test_evidence_flag_off_at_zero_min_score():
    words = [_w(0.0, 0.1)]
    words[0].alignment_score = 0.0001
    assert (
        flag_words_without_acoustic_evidence(
            words, min_score=0.0, evidence=NO_SPEECH, track_id="host"
        )
        == 0
    )
    assert words[0].suspect_hallucination is False


def test_evidence_flag_applies_when_silence_filter_off_or_decode_fails(monkeypatch, tmp_path):
    from podcast_mcp.engines import asr_silence

    monkeypatch.setattr(asr_silence, "peak_envelope", lambda path: (_audio(), float(SR)))
    scored = _w(1.2, 1.5)
    scored.alignment_score = 0.001
    path = tmp_path / "a.wav"

    result = refresh_silence_flags(
        [scored], path, AsrOptions(silence_filter_enabled=False), evidence=NO_SPEECH
    )
    assert result == 1
    assert scored.suspect_hallucination is True

    monkeypatch.setattr(asr_silence, "flag_silent_words_in_file", lambda *a, **k: None)
    scored2 = _w(1.2, 1.5)
    scored2.alignment_score = 0.001
    result2 = refresh_silence_flags([scored2], path, AsrOptions(), evidence=NO_SPEECH)
    assert result2 is None
    assert scored2.suspect_hallucination is True


def test_fingerprint_unchanged_without_scores_and_tracks_min_score_with_scores():
    words = [_w(0.0, 0.5)]
    low = AsrOptions(forced_alignment_min_word_score=0.01)
    high = AsrOptions(forced_alignment_min_word_score=0.5)
    assert silence_filter_fingerprint(words, "sha", low) == silence_filter_fingerprint(
        words, "sha", high
    )

    words[0].alignment_score = 0.9
    assert silence_filter_fingerprint(words, "sha", low) != silence_filter_fingerprint(
        words, "sha", high
    )
    wide = AsrOptions(forced_alignment_min_word_score=0.01, forced_alignment_bleed_margin_db=6.0)
    assert silence_filter_fingerprint(words, "sha", low) != silence_filter_fingerprint(
        words, "sha", wide
    )


def test_speech_levels_gate_flags_bleed_and_silence_but_not_a_short_real_word(tmp_workspace):
    """#780: literal outcomes for the three word classes the lab tape showed."""
    from podcast_mcp.engines.asr_silence import SpeechLevels

    project = two_mic_project(tmp_workspace)
    levels = SpeechLevels.for_project(project, AsrOptions(), bleed_check=True)
    assert set(levels.tracks) == {"host", "guest"}
    assert levels.skipped == []
    assert levels.floors_db["host"] == pytest.approx(-70.0, abs=2.0)
    assert levels.tracks["host"].frames_db.dtype == np.float32
    assert levels.tracks["host"].frames_db.size == 300

    real = _w(0.70, 0.72)  # a one-frame "um" inside host's own tone
    real.alignment_score = 0.0
    bleed = _w(1.6, 1.9)  # the guest talking, 20 dB louder on the guest mic
    bleed.alignment_score = 0.003
    silent = _w(2.5, 2.6)
    silent.alignment_score = 0.0
    scored_fine = _w(1.6, 1.9)  # same bleed span, but the aligner was sure of it
    scored_fine.alignment_score = 0.8
    words = [real, bleed, silent, scored_fine]

    n = refresh_silence_flags(
        words,
        tmp_workspace / "raw" / "host.wav",
        AsrOptions(silence_filter_enabled=False),
        evidence=levels,
        track_id="host",
    )

    assert [w.suspect_hallucination for w in words] == [False, True, True, False]
    assert n == 2
    assert levels.has_speech("host", 0.70, 0.72) is True
    assert levels.has_speech("host", 1.6, 1.9) is False
    assert levels.has_speech("host", 2.5, 2.6) is False
    # The guest's own word over the same span is the guest's speech.
    assert levels.has_speech("guest", 1.6, 1.9) is True


def test_speech_levels_apply_the_track_gain_and_the_bleed_margin(tmp_workspace):
    from podcast_mcp.engines.asr_silence import SpeechLevels

    # +15 dB on host lifts its -32 dBFS bleed to -17 dBFS against the guest's -12 dBFS:
    # still bleed at the 3 dB default, the host's own speech at a 6 dB margin.
    project = two_mic_project(tmp_workspace, host_gain_db=15.0)
    strict = SpeechLevels.for_project(project, AsrOptions(), bleed_check=True)
    assert strict.has_speech("host", 1.6, 1.9) is False
    lenient = SpeechLevels.for_project(
        project, AsrOptions(forced_alignment_bleed_margin_db=6.0), bleed_check=True
    )
    assert lenient.has_speech("host", 1.6, 1.9) is True


def test_speech_levels_treat_an_undecodable_track_as_evidence(tmp_workspace, caplog):
    from podcast_mcp.engines.asr_silence import SpeechLevels

    project = two_mic_project(tmp_workspace)
    (tmp_workspace / "raw" / "guest.wav").write_bytes(b"not audio")
    with caplog.at_level("WARNING"):
        levels = SpeechLevels.for_project(project, AsrOptions(), bleed_check=True)
    assert levels.skipped == ["guest"]
    assert "aligner evidence levels skipped for track guest" in caplog.text
    # No guest levels: host's bleed span cannot be called bleed, so it is not flagged.
    assert levels.has_speech("host", 1.6, 1.9) is True
    # A track with no levels at all is never flagged on the score.
    assert levels.has_speech("guest", 1.6, 1.9) is True


def test_own_scope_ignores_the_other_tracks_and_their_placement(tmp_workspace):
    """#780: before align_tracks the gate reads the own track only, so a wrong placement
    cannot flag a real word; it also cannot see bleed, which reconcile handles later."""
    from podcast_mcp.engines.asr_silence import SpeechLevels

    # Host placed 1.0 s late: its own -30 dBFS word now sits under the guest's -12 dBFS line.
    misplaced = two_mic_project(tmp_workspace, host_timeline_start=1.0)
    own = SpeechLevels.for_project(misplaced, AsrOptions(), bleed_check=False)
    assert own.fingerprint_term("host").startswith("own:")
    assert own.has_speech("host", 0.70, 0.72) is True
    assert own.has_speech("host", 1.6, 1.9) is True
    assert own.has_speech("host", 2.5, 2.6) is False

    # The full gate on that wrong placement is exactly the defect: the real word is flagged.
    full = SpeechLevels.for_project(misplaced, AsrOptions(), bleed_check=True)
    assert full.has_speech("host", 0.70, 0.72) is False
    assert full.fingerprint_term("host").startswith("bleed:")

    # With the placement fixed the full gate flags the bleed span and not the real word,
    # and the fingerprint term changes with the placement.
    fixed = two_mic_project(tmp_workspace, host_timeline_start=0.0)
    settled = SpeechLevels.for_project(fixed, AsrOptions(), bleed_check=True)
    assert settled.has_speech("host", 0.70, 0.72) is True
    assert settled.has_speech("host", 1.6, 1.9) is False
    assert settled.fingerprint_term("host") != full.fingerprint_term("host")


def test_fingerprint_carries_the_evidence_scope_only_for_scored_words():
    from podcast_mcp.engines.asr_silence import evidence_term
    from podcast_mcp.models import Clip, EpisodeProject, Track, TrackRole

    project = EpisodeProject.create("fp", "/tmp")
    project.tracks = [
        Track(id="host", label="host", role=TrackRole.DIALOGUE),
        Track(id="guest", label="guest", role=TrackRole.DIALOGUE),
    ]
    project.clips = [
        Clip(id="c", track_id="host", source_start=0.0, source_end=3.0, timeline_start=0.0)
    ]
    settled = evidence_term(project, "host", bleed_check=True)
    own = evidence_term(project, "host", bleed_check=False)
    assert own.startswith("own:")
    assert settled.startswith("bleed:") and len(settled) == len("bleed:") + 33
    project.track_by_id("guest").gain_db = 12.0
    assert evidence_term(project, "host", bleed_check=False) == own
    assert evidence_term(project, "host", bleed_check=True) != settled
    settled = evidence_term(project, "host", bleed_check=True)
    project.track_by_id("host").gain_db = 3.0
    assert evidence_term(project, "host", bleed_check=False) != own
    assert evidence_term(project, "host", bleed_check=True) != settled
    project.clips[0].timeline_start = 0.5
    assert evidence_term(project, "host", bleed_check=True) != settled

    words = [_w(0.0, 0.5)]
    unscored_own = silence_filter_fingerprint(words, "sha", AsrOptions(), evidence="own")
    assert silence_filter_fingerprint(words, "sha", AsrOptions(), evidence=settled) == unscored_own
    words[0].alignment_score = 0.9
    scored_own = silence_filter_fingerprint(words, "sha", AsrOptions(), evidence="own")
    assert silence_filter_fingerprint(words, "sha", AsrOptions(), evidence=settled) != scored_own
    assert silence_filter_fingerprint(words, "sha", AsrOptions()) == scored_own


def test_track_energy_levels_match_the_tone_and_stream_in_frames(tmp_workspace):
    from podcast_mcp.engines.asr_silence import LEVEL_FRAME_SEC, TrackEnergy

    two_mic_project(tmp_workspace)
    energy = TrackEnergy.decode(tmp_workspace / "raw" / "guest.wav")
    assert energy.frames_db.size == round(3.0 / LEVEL_FRAME_SEC)
    assert energy.level_db(1.6, 1.9) == pytest.approx(-12.0, abs=1.0)
    assert energy.level_db(0.1, 0.4) == pytest.approx(-70.0, abs=2.0)
    assert energy.level_db(2.99, 3.05) is not None
    assert energy.level_db(3.5, 3.6) is None


def test_whisper_audio_decoder_reads_pcm_without_loading_a_model(tmp_path):
    from faster_whisper.audio import decode_audio

    path = tmp_path / "decode.wav"
    samples = np.full(1600, 8192, dtype="<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16000)
        handle.writeframes(samples.tobytes())

    decoded = decode_audio(str(path), sampling_rate=16000)

    assert decoded.shape == (1600,)
    assert decoded.dtype == np.float32
    np.testing.assert_allclose(decoded, 0.25, atol=1 / 32768)
