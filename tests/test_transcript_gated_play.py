from __future__ import annotations

import struct
import wave
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from podcast_mcp.engines.transcript_gated_play import (
    _apply_gate,
    _limit_to_full_scale,
    _load_segment,
    _normalize_peak,
    _write_wav,
    dialogue_tracks_for_play,
    gate_stem_window,
    render_gated_mix,
    render_gated_track,
    transcript_gate_fingerprint,
    word_intervals,
)
from podcast_mcp.models import (
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)


def _project_with_words(tmp_path: Path) -> EpisodeProject:
    project = EpisodeProject.create("ep", str(tmp_path))
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="a", start=1.0, end=1.5, confidence=0.9),
                TranscriptWord(
                    text="b",
                    start=1.55,
                    end=2.0,
                    confidence=0.9,
                    suppressed=True,
                ),
                TranscriptWord(text="c", start=2.2, end=2.8, confidence=0.9),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text="x", start=1.2, end=2.5, confidence=0.9),
            ],
        ),
    ]
    return project


def test_word_intervals_merges_and_skips_suppressed(tmp_path: Path) -> None:
    project = _project_with_words(tmp_path)
    iv = word_intervals(project, "host", 0.0, 5.0, merge_gap_sec=0.2)
    assert iv == [(1.0, 1.5), (2.2, 2.8)]


def test_transcript_gate_fingerprint_changes_with_suppression(tmp_path: Path) -> None:
    project = _project_with_words(tmp_path)
    a = transcript_gate_fingerprint(project, ["host", "guest"], 0.0, 5.0)
    tr = project.transcript_for_track("host")
    assert tr is not None
    tr.words[0] = tr.words[0].model_copy(update={"suppressed": True})
    b = transcript_gate_fingerprint(project, ["host", "guest"], 0.0, 5.0)
    assert a != b


def test_apply_gate_silences_outside_intervals() -> None:
    sr = 1000
    samples = np.ones(sr, dtype=np.float32)
    gated = _apply_gate(
        samples,
        [(0.2, 0.5)],
        timeline_start=0.0,
        sample_rate=sr,
        fade_sec=0.0,
    )
    assert gated[0] == 0.0
    assert gated[300] == 1.0
    assert gated[900] == 0.0


def test_word_intervals_missing_track_and_clips(tmp_path: Path) -> None:
    project = _project_with_words(tmp_path)
    assert word_intervals(project, "missing", 0.0, 5.0) == []
    iv = word_intervals(project, "host", 1.2, 1.4)
    assert iv == [(1.2, 1.4)]


def test_word_intervals_merges_close_words(tmp_path: Path) -> None:
    project = EpisodeProject.create("ep", str(tmp_path))
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="a", start=1.0, end=1.2),
                TranscriptWord(text="b", start=1.25, end=1.5),
            ],
        )
    ]
    iv = word_intervals(project, "host", 0.0, 5.0, merge_gap_sec=0.1)
    assert iv == [(1.0, 1.5)]


def test_transcript_gate_fingerprint_skips_missing_track(tmp_path: Path) -> None:
    project = _project_with_words(tmp_path)
    fp = transcript_gate_fingerprint(project, ["missing"], 0.0, 5.0)
    assert len(fp) == 16
    clipped = transcript_gate_fingerprint(project, ["host"], 2.5, 5.0)
    assert clipped != transcript_gate_fingerprint(project, ["host"], 0.0, 5.0)


def test_apply_gate_empty_and_fade() -> None:
    assert _apply_gate(np.array([], dtype=np.float32), [(0.0, 1.0)], timeline_start=0.0).size == 0
    sr = 10
    tiny = np.ones(sr, dtype=np.float32)
    outside = _apply_gate(
        tiny,
        [(100.0, 101.0)],
        timeline_start=0.0,
        sample_rate=sr,
        fade_sec=0.0,
    )
    assert outside.max() == 0.0
    sr = 1000
    samples = np.ones(sr, dtype=np.float32)
    gated = _apply_gate(
        samples,
        [(10.0, 11.0)],
        timeline_start=0.0,
        sample_rate=sr,
        fade_sec=0.01,
    )
    assert gated.max() == 0.0
    faded = _apply_gate(
        samples,
        [(0.2, 0.5)],
        timeline_start=0.0,
        sample_rate=sr,
        fade_sec=0.05,
    )
    assert faded[200] == 0.0
    assert 0.0 < faded[210] < 1.0


def test_apply_gate_matches_sample_clock_reference() -> None:
    samples = np.ones(2400, dtype=np.float32)
    intervals = [(0.013, 0.061), (0.084, 0.12)]
    rate = 12_000
    start = 0.01
    actual = _apply_gate(samples, intervals, timeline_start=start, sample_rate=rate)
    clock = np.arange(samples.size, dtype=np.float64) / rate + start
    expected = np.zeros_like(samples)
    for begin, end in intervals:
        indices = np.where((clock >= begin) & (clock < end))[0]
        expected[indices] = 1
        fade = min(int(0.012 * rate), indices.size)
        expected[indices[:fade]] *= np.linspace(0, 1, fade, dtype=np.float32)
        expected[indices[-fade:]] *= np.linspace(1, 0, fade, dtype=np.float32)
    np.testing.assert_array_equal(actual, expected)


def test_gate_stem_window_streams_and_preserves_outer_pcm(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "source.wav"
    output = tmp_path / "gated.wav"
    pcm = np.arange(48_000 * 3, dtype=np.int16)
    with wave.open(str(source), "wb") as wav:
        wav.setparams((1, 2, 48_000, 0, "NONE", "not compressed"))
        wav.writeframes(pcm.tobytes())

    def unexpected_decode(*args, **kwargs):
        raise AssertionError("PCM gate must not decode the full stem")

    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play._load_segment", unexpected_decode
    )
    gate_stem_window(source, [], output, duration_sec=3, win_start=1, win_end=2)
    with wave.open(str(output), "rb") as wav:
        result = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16)
    np.testing.assert_array_equal(result[:48_000], pcm[:48_000])
    np.testing.assert_array_equal(result[96_000:], pcm[96_000:])
    assert not result[48_000:96_000].any()


def test_gate_stem_window_in_place_is_atomic(tmp_path: Path) -> None:
    path = tmp_path / "stem.wav"
    pcm = np.full(48_000, 1000, dtype=np.int16)
    with wave.open(str(path), "wb") as wav:
        wav.setparams((1, 2, 48_000, 0, "NONE", "not compressed"))
        wav.writeframes(pcm.tobytes())
    gate_stem_window(path, [], path, duration_sec=1, win_start=0.25, win_end=0.5)
    with wave.open(str(path), "rb") as wav:
        result = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16)
    assert result.size == pcm.size
    np.testing.assert_array_equal(result[:12_000], pcm[:12_000])
    assert not result[12_000:24_000].any()
    np.testing.assert_array_equal(result[24_000:], pcm[24_000:])


def test_gate_stem_window_matches_gate_across_stream_chunk(tmp_path: Path) -> None:
    source = tmp_path / "source.wav"
    output = tmp_path / "gated.wav"
    pcm = np.full(96_000, 1000, dtype=np.int16)
    with wave.open(str(source), "wb") as wav:
        wav.setparams((1, 2, 48_000, 0, "NONE", "not compressed"))
        wav.writeframes(pcm.tobytes())
    intervals = [(0.9, 1.1)]
    gate_stem_window(source, intervals, output, duration_sec=2, win_start=0, win_end=2)
    with wave.open(str(output), "rb") as wav:
        actual = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16)
    expected = _apply_gate(pcm.astype(np.float32), intervals, timeline_start=0).astype(np.int16)
    np.testing.assert_array_equal(actual, expected)


def test_gate_stem_window_queries_only_intervals_near_each_chunk(
    tmp_path: Path, monkeypatch
) -> None:
    from podcast_mcp.engines import transcript_gated_play as tgp

    source = tmp_path / "source.wav"
    output = tmp_path / "gated.wav"
    pcm = np.full(10_000, 1000, dtype=np.int16)
    with wave.open(str(source), "wb") as wav:
        wav.setparams((1, 2, 1000, 0, "NONE", "not compressed"))
        wav.writeframes(pcm.tobytes())

    checked: list[int] = []
    original = tgp._gate_pcm_chunk

    def record_chunk(raw, frame_intervals, **kwargs):
        checked.append(len(frame_intervals))
        return original(raw, frame_intervals, **kwargs)

    monkeypatch.setattr(tgp, "_gate_pcm_chunk", record_chunk)
    intervals = [(second + 0.1, second + 0.2) for second in range(10)]
    gate_stem_window(source, intervals, output, duration_sec=10, win_start=0, win_end=10)
    assert checked == [1] * 10


def test_gate_stem_window_preserves_unsorted_overlapping_interval_order(tmp_path: Path) -> None:
    from podcast_mcp.engines.transcript_gated_play import _gate_pcm_chunk

    source = tmp_path / "source.wav"
    output = tmp_path / "gated.wav"
    pcm = np.full(2000, 1000, dtype=np.int16)
    with wave.open(str(source), "wb") as wav:
        wav.setparams((1, 2, 1000, 0, "NONE", "not compressed"))
        wav.writeframes(pcm.tobytes())

    # The last interval intentionally overwrites part of the earlier fade.
    intervals = [(1.3, 1.8), (0.2, 0.5), (0.4, 1.4)]
    gate_stem_window(source, intervals, output, duration_sec=2, win_start=0, win_end=2)
    expected = _gate_pcm_chunk(
        pcm.tobytes(),
        [(1300, 1800), (200, 500), (400, 1400)],
        first_frame=0,
        sample_rate=1000,
        channels=1,
    )
    with wave.open(str(output), "rb") as wav:
        assert wav.readframes(wav.getnframes()) == expected


def test_gate_stem_window_rejects_non_pcm16(tmp_path: Path) -> None:
    source = tmp_path / "pcm8.wav"
    output = tmp_path / "out.wav"
    with wave.open(str(source), "wb") as wav:
        wav.setparams((1, 1, 48_000, 0, "NONE", "not compressed"))
        wav.writeframes(bytes([100] * 100))
    with pytest.raises(ValueError, match="PCM16 WAV"):
        gate_stem_window(
            source, [], output, duration_sec=100 / 48_000, win_start=0, win_end=100 / 48_000
        )
    assert not output.exists()


def test_gate_stem_window_preserves_stereo_channels(tmp_path: Path) -> None:
    source = tmp_path / "stereo.wav"
    output = tmp_path / "out.wav"
    pcm = np.tile(np.array([1000, -2000], dtype=np.int16), (48_000, 1))
    with wave.open(str(source), "wb") as wav:
        wav.setparams((2, 2, 48_000, 0, "NONE", "not compressed"))
        wav.writeframes(pcm.tobytes())
    gate_stem_window(source, [], output, duration_sec=1, win_start=0.25, win_end=0.5)
    with wave.open(str(output), "rb") as wav:
        assert wav.getnchannels() == 2
        result = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).reshape(-1, 2)
    np.testing.assert_array_equal(result[:12_000], pcm[:12_000])
    assert not result[12_000:24_000].any()
    np.testing.assert_array_equal(result[24_000:], pcm[24_000:])


def test_gate_stem_window_preserves_extensible_51_header_and_channels(tmp_path: Path) -> None:
    source = tmp_path / "surround.wav"
    output = tmp_path / "out.wav"
    pcm = np.tile(np.arange(1, 7, dtype=np.int16) * 1000, (4800, 1))
    guid = bytes.fromhex("0100000000001000800000aa00389b71")
    fmt = struct.pack("<HHIIHHHHI", 65534, 6, 48_000, 48_000 * 12, 12, 16, 22, 16, 0x3F) + guid
    payload = pcm.tobytes()
    header = (
        b"RIFF"
        + struct.pack("<I", 4 + 8 + len(fmt) + 8 + len(payload))
        + b"WAVEfmt "
        + struct.pack("<I", len(fmt))
        + fmt
        + b"data"
        + struct.pack("<I", len(payload))
    )
    source.write_bytes(header + payload)
    gate_stem_window(source, [], output, duration_sec=0.1, win_start=0.025, win_end=0.05)
    raw = output.read_bytes()
    assert raw[: len(header)] == header
    result = np.frombuffer(raw[len(header) :], dtype="<i2").reshape(-1, 6)
    np.testing.assert_array_equal(result[:1200], pcm[:1200])
    assert not result[1200:2400].any()
    np.testing.assert_array_equal(result[2400:], pcm[2400:])


def test_normalize_peak_handles_silence_and_signal() -> None:
    silent = np.zeros(8, dtype=np.float32)
    assert np.array_equal(_normalize_peak(silent), silent)
    loud = np.array([0.5, -1.0], dtype=np.float32)
    normalized = _normalize_peak(loud)
    assert pytest.approx(float(np.max(np.abs(normalized))), rel=1e-3) == 0.95


def test_load_segment_and_write_wav(tmp_path: Path) -> None:
    fake_audio = np.array([0.25, -0.25], dtype=np.float32)
    with patch(
        "podcast_mcp.engines.transcript_gated_play.run",
        return_value=MagicMock(stdout=fake_audio.tobytes()),
    ) as run:
        loaded = _load_segment(tmp_path / "stem.wav", 1.0, 0.5)
    assert loaded.shape == (2,)
    run.assert_called_once()

    out = tmp_path / "out.wav"
    with patch(
        "podcast_mcp.engines.transcript_gated_play.run",
        return_value=MagicMock(returncode=0),
    ) as run:
        written = _write_wav(fake_audio, out, sample_rate=48_000)
    assert written == out
    assert out.parent.exists()
    run.assert_called_once()


def test_gate_full_stem(tmp_path: Path) -> None:
    stem = tmp_path / "host.wav"
    out = tmp_path / "gated.wav"
    with wave.open(str(stem), "wb") as wav:
        wav.setparams((1, 2, 48_000, 0, "NONE", "not compressed"))
        wav.writeframes(np.full(4800, 1000, dtype=np.int16).tobytes())
    gate_stem_window(stem, [(0.0, 0.05)], out, duration_sec=0.1, win_start=0, win_end=0.1)
    with wave.open(str(out), "rb") as wav:
        gated = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16)
    assert gated.max() > 0
    assert not gated[2400:].any()


def test_gate_stem_window_edge_cases(tmp_path: Path) -> None:
    stem = tmp_path / "host.wav"
    out = tmp_path / "out.wav"
    with wave.open(str(stem), "wb") as wav:
        wav.setparams((1, 2, 48_000, 0, "NONE", "not compressed"))
        wav.writeframes(b"")
    gate_stem_window(stem, [], out, duration_sec=0.1, win_start=0, win_end=0.1)
    with wave.open(str(out), "rb") as wav:
        assert wav.getnframes() == 0
    gate_stem_window(stem, [], out, duration_sec=0.1, win_start=0.5, win_end=0.2)
    assert out.read_bytes() == stem.read_bytes()


def test_apply_track_transcript_gate_branches(tmp_path: Path, monkeypatch) -> None:
    from podcast_mcp.engines.bleed_gate import BleedGatePlan
    from podcast_mcp.engines.transcript_gated_play import apply_track_transcript_gate
    from podcast_mcp.models import EpisodeProject, MediaAsset, Track, TrackRole

    project = EpisodeProject.create("ep", str(tmp_path))
    wav = tmp_path / "seg.wav"
    wav.write_bytes(b"wav")
    assert (
        apply_track_transcript_gate(project, "missing", wav, timeline_start=0.0, timeline_end=1.0)
        is wav
    )

    project.timeline.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=1.0),
            transcript_gate=False,
        )
    )
    assert (
        apply_track_transcript_gate(project, "host", wav, timeline_start=0.0, timeline_end=1.0)
        is wav
    )
    project.track_by_id("host").transcript_gate = True
    assert (
        apply_track_transcript_gate(project, "host", wav, timeline_start=1.0, timeline_end=0.5)
        is wav
    )

    called: list[tuple] = []

    def _fake_gate(path, intervals, *, timeline_start, timeline_end):
        called.append((path, intervals, timeline_start, timeline_end))
        return path

    plan = BleedGatePlan(attenuation_spans=((0.0, 0.2),))
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *a, **k: plan,
    )
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.apply_bleed_gate_plan",
        _fake_gate,
    )
    assert (
        apply_track_transcript_gate(project, "host", wav, timeline_start=0.0, timeline_end=0.5)
        is wav
    )
    assert called and called[0][1] is plan


def test_gate_rendered_wav_zero_duration(tmp_path: Path) -> None:
    from podcast_mcp.engines.transcript_gated_play import gate_rendered_wav

    wav = tmp_path / "x.wav"
    wav.write_bytes(b"ok")
    assert gate_rendered_wav(wav, [], timeline_start=1.0, timeline_end=1.0) is wav


def test_render_gated_track_and_mix(tmp_path: Path, monkeypatch) -> None:
    seg = np.ones(4800, dtype=np.float32)
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play._load_segment",
        lambda *args, **kwargs: seg.copy(),
    )
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play._write_wav",
        lambda samples, path, **kwargs: path,
    )
    stem = tmp_path / "host.wav"
    stem.write_bytes(b"x")
    out = tmp_path / "gated.wav"
    render_gated_track(stem, [(0.0, 0.05)], out, timeline_start=0.0, timeline_end=0.1)
    mix_out = tmp_path / "mix.wav"
    render_gated_mix(
        [("host", stem), ("guest", stem)],
        {"host": [(0.0, 0.05)], "guest": []},
        mix_out,
        timeline_start=0.0,
        timeline_end=0.1,
    )
    with pytest.raises(ValueError, match="no stems"):
        render_gated_mix([], {}, mix_out, timeline_start=0.0, timeline_end=0.1)


def test_render_gated_mix_plays_each_track_at_its_gain(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play._load_segment",
        lambda *args, **kwargs: np.ones(4800, dtype=np.float32),
    )
    written: list[np.ndarray] = []
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play._write_wav",
        lambda samples, path, **kwargs: written.append(samples) or path,
    )
    stem = tmp_path / "stem.wav"
    # Host speaks in the first half, guest in the second: each half holds one track.
    intervals = {"host": [(0.0, 0.05)], "guest": [(0.05, 0.1)]}
    for gains, host_over_guest in ((None, 1.0), ({"host": 0.0, "guest": -6.0}, 10 ** (6 / 20))):
        render_gated_mix(
            [("host", stem), ("guest", stem)],
            intervals,
            tmp_path / "mix.wav",
            timeline_start=0.0,
            timeline_end=0.1,
            gains_db=gains,
        )
        mix = written[-1]
        # Samples 1200 and 3600 sit clear of the 12 ms gate fades.
        assert float(mix[1200] / mix[3600]) == pytest.approx(host_over_guest, rel=1e-4)
    assert float(np.max(np.abs(written[-1]))) == pytest.approx(0.95, rel=1e-4)


def test_dialogue_tracks_for_play(tmp_path: Path) -> None:
    project = EpisodeProject.create("ep", str(tmp_path))
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="host.wav"),
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            muted=True,
            media=MediaAsset(path="guest.wav"),
        ),
        Track(id="bed", label="Bed", role=TrackRole.MUSIC),
    ]
    assert dialogue_tracks_for_play(project) == ["host"]
    project.tracks = []
    assert dialogue_tracks_for_play(project) == []


def test_source_word_intervals_merge_and_window(tmp_path: Path) -> None:
    from podcast_mcp.engines.transcript_gated_play import source_word_intervals

    project = EpisodeProject.create("ep", str(tmp_path))
    assert source_word_intervals(project, "missing", 0.0, 10.0) == []

    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="a", start=1.0, end=1.4, confidence=0.9),
                TranscriptWord(
                    text="b",
                    start=1.45,
                    end=1.8,
                    confidence=0.9,
                    suppressed=True,
                ),
                TranscriptWord(text="c", start=1.9, end=2.2, confidence=0.9),
                TranscriptWord(text="d", start=5.0, end=5.5, confidence=0.9),
                TranscriptWord(text="early", start=0.0, end=0.2, confidence=0.9),
                TranscriptWord(text="late", start=9.0, end=9.5, confidence=0.9),
            ],
        )
    ]
    assert source_word_intervals(project, "host", 1.0, 3.0) == [(1.0, 1.4), (1.9, 2.2)]
    assert source_word_intervals(project, "host", 1.0, 3.0, merge_gap_sec=1.0) == [(1.0, 2.2)]
    assert source_word_intervals(project, "host", 10.0, 11.0) == []
    clipped = source_word_intervals(project, "host", 1.2, 2.0)
    assert clipped == [(1.2, 1.4), (1.9, 2.0)]


def test_render_gated_track_plays_at_its_gain(tmp_path, monkeypatch) -> None:
    from podcast_mcp.engines import transcript_gated_play as tgp

    monkeypatch.setattr(
        tgp, "_load_segment", lambda *_a, **_k: np.full(4800, 0.5, dtype=np.float32)
    )
    written: list[np.ndarray] = []

    def _write(samples, path):
        written.append(samples)
        return path

    monkeypatch.setattr(tgp, "_write_wav", _write)
    stem = tmp_path / "s.wav"
    out = tmp_path / "g.wav"
    tgp.render_gated_track(stem, [(0.0, 0.1)], out, timeline_start=0.0, timeline_end=0.1)
    tgp.render_gated_track(
        stem, [(0.0, 0.1)], out, timeline_start=0.0, timeline_end=0.1, gain_db=-6.0
    )
    assert float(written[0][2400]) == pytest.approx(0.5, rel=1e-4)
    assert float(written[1][2400] / written[0][2400]) == pytest.approx(10 ** (-6 / 20), rel=1e-4)


def test_limit_to_full_scale_only_touches_clipping_samples() -> None:
    quiet = np.array([0.5, -0.9], dtype=np.float32)
    assert np.array_equal(_limit_to_full_scale(quiet), quiet)
    empty = np.array([], dtype=np.float32)
    assert _limit_to_full_scale(empty).size == 0
    loud = np.array([0.5, -1.6], dtype=np.float32)
    limited = _limit_to_full_scale(loud)
    assert float(np.max(np.abs(limited))) == pytest.approx(0.95, rel=1e-4)
    assert float(limited[0] / limited[1]) == pytest.approx(0.5 / -1.6, rel=1e-4)


def test_render_gated_track_does_not_clip_on_positive_gain(tmp_path, monkeypatch) -> None:
    from podcast_mcp.engines import transcript_gated_play as tgp

    monkeypatch.setattr(
        tgp, "_load_segment", lambda *_a, **_k: np.full(4800, 0.8, dtype=np.float32)
    )
    written: list[np.ndarray] = []

    def _write(samples, path):
        written.append(samples)
        return path

    monkeypatch.setattr(tgp, "_write_wav", _write)
    tgp.render_gated_track(
        tmp_path / "s.wav",
        [(0.0, 0.1)],
        tmp_path / "g.wav",
        timeline_start=0.0,
        timeline_end=0.1,
        gain_db=6.0,
    )
    assert float(np.max(np.abs(written[0]))) == pytest.approx(0.95, rel=1e-4)
