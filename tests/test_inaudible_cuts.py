from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

from podcast_mcp.edits.inaudible_cuts import (
    InaudibleCutConfig,
    detect_track_cut_mode,
    optimize_source_cut_range,
    optimize_timeline_cut_range,
    recommend_micro_fades,
)
from podcast_mcp.edits.strip_silence import strip_silence
from podcast_mcp.edits.timeline_ops import ripple_delete
from podcast_mcp.edits.transcript_cuts import cut_time_range
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)


def _project(tmp_path: Path) -> EpisodeProject:
    ws = tmp_path / "ws"
    raw = ws / "raw"
    raw.mkdir(parents=True)
    (raw / "host.wav").write_bytes(b"fake")
    (raw / "bed.wav").write_bytes(b"fake")
    p = EpisodeProject.create("t", str(ws))
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=20.0),
        ),
        Track(
            id="bed",
            label="Bed",
            role=TrackRole.MUSIC,
            media=MediaAsset(path="raw/bed.wav", duration_sec=20.0),
        ),
    ]
    p.timeline.clips = [
        Clip(id="h1", track_id="host", source_start=0.0, source_end=20.0, timeline_start=0.0),
        Clip(id="b1", track_id="bed", source_start=0.0, source_end=20.0, timeline_start=0.0),
    ]
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="a", start=1.0, end=1.4),
                TranscriptWord(text="b", start=2.0, end=2.4),
                TranscriptWord(text="c", start=4.0, end=4.5),
            ],
        )
    ]
    return p


def test_detect_track_cut_mode(tmp_path):
    p = _project(tmp_path)
    assert detect_track_cut_mode(p.track_by_id("host")) == "vocal_transcript_guided"
    assert detect_track_cut_mode(p.track_by_id("bed")) == "waveform_only"


def test_optimize_source_prefers_word_boundary_for_dialogue(tmp_path):
    p = _project(tmp_path)
    # Synthetic window with minimum around mid-samples.
    fake = np.array([0.5, 0.4, 0.3, 0.1, 0.02, 0.1, 0.3, 0.5], dtype=np.float32)
    with patch("podcast_mcp.edits.inaudible_cuts.load_mono_window", return_value=fake):
        opt = optimize_source_cut_range(p, "host", 2.15, 4.1)
    # Should stay close to transcript boundaries (2.0/4.0-4.5 neighborhood) with shifts bounded.
    assert abs(opt.shifted_start_ms) <= 80
    assert abs(opt.shifted_end_ms) <= 80
    assert opt.mode == "vocal_transcript_guided"


def test_optimize_source_waveform_only_for_music(tmp_path):
    p = _project(tmp_path)
    fake = np.array([0.8, 0.5, 0.3, 0.1, 0.0, 0.1, 0.3, 0.8], dtype=np.float32)
    with patch("podcast_mcp.edits.inaudible_cuts.load_mono_window", return_value=fake):
        opt = optimize_source_cut_range(p, "bed", 5.0, 6.0)
    assert opt.mode == "waveform_only"
    assert abs(opt.shifted_start_ms) <= 80
    assert abs(opt.shifted_end_ms) <= 80


def test_trailing_energy_extends_short_cut_end(tmp_path: Path) -> None:
    """Naive end mid-filler burst should move forward to a quiet trough."""
    import wave

    from podcast_mcp.edits.inaudible_cuts import _extend_end_past_trailing_energy

    ws = tmp_path / "trail"
    raw = ws / "raw"
    raw.mkdir(parents=True)
    wav = raw / "host.wav"
    # 1s @ 16kHz: quiet, loud 400-550ms, quiet
    sr = 16000
    t = np.arange(sr, dtype=np.float32) / sr
    sig = np.zeros_like(t)
    burst = (t >= 0.40) & (t < 0.55)
    sig[burst] = 0.4 * np.sin(2 * np.pi * 200 * t[burst])
    pcm = (np.clip(sig, -1, 1) * 32767).astype(np.int16)
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())

    p = EpisodeProject.create("trail", str(ws))
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=1.0),
        )
    ]
    p.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=0.0,
        )
    ]
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="um", start=0.30, end=0.45),
                # Next word after the burst so quietest-to-next-word can land
                # in true silence; overlapping onset still uses hot chew.
                TranscriptWord(text="you", start=0.70, end=0.90),
            ],
        )
    ]
    cfg = InaudibleCutConfig(
        enabled=True,
        search_window_ms=20,
        max_shift_ms=40,
        min_word_margin_ms=0,
        short_cut_max_sec=1.2,
        trailing_energy_extend_ms=200,
        trailing_energy_hot_db=-30.0,
        trailing_energy_quiet_db=-40.0,
        trailing_energy_hop_ms=10,
    )
    # Mid-burst naive end; search capped at next word
    new_end, extended = _extend_end_past_trailing_energy(
        wav, 0.30, 0.45, config=cfg, sample_rate=sr, search_until=0.70
    )
    assert extended
    assert new_end > 0.50  # past the burst into quiet
    assert new_end <= 0.70

    opt = optimize_source_cut_range(p, "host", 0.30, 0.45, config=cfg)
    assert opt.details.get("trailing_energy_extended") is True
    assert opt.end > 0.50


def test_trailing_energy_picks_quietest_not_first_trough(tmp_path: Path) -> None:
    """Skip a shallow local trough when a quieter spot exists before next word."""
    import wave

    from podcast_mcp.edits.inaudible_cuts import _extend_end_past_trailing_energy

    ws = tmp_path / "trough"
    raw = ws / "raw"
    raw.mkdir(parents=True)
    wav = raw / "host.wav"
    sr = 16000
    n = int(sr * 0.8)
    t = np.arange(n, dtype=np.float32) / sr
    sig = np.zeros(n, dtype=np.float32)
    # Hot filler through ~0.45, shallow dip ~0.48, deeper quiet ~0.58
    hot = (t >= 0.30) & (t < 0.46)
    shallow = (t >= 0.46) & (t < 0.52)
    deep = (t >= 0.52) & (t < 0.62)
    sig[hot] = 0.35 * np.sin(2 * np.pi * 180 * t[hot])
    sig[shallow] = 0.04 * np.sin(2 * np.pi * 180 * t[shallow])
    sig[deep] = 0.002 * np.sin(2 * np.pi * 180 * t[deep])
    pcm = (np.clip(sig, -1, 1) * 32767).astype(np.int16)
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())

    cfg = InaudibleCutConfig(
        trailing_energy_extend_ms=250,
        trailing_energy_hot_db=-30.0,
        trailing_energy_quiet_db=-40.0,
        trailing_energy_hop_ms=10,
        short_cut_max_sec=1.2,
    )
    new_end, extended = _extend_end_past_trailing_energy(
        wav, 0.30, 0.45, config=cfg, sample_rate=sr, search_until=0.70
    )
    assert extended
    # Must pass the shallow trough and land near the deep quiet plateau.
    assert new_end >= 0.52
    assert new_end <= 0.70


def test_trailing_energy_chews_past_next_word_when_still_hot(tmp_path: Path) -> None:
    """When next-word onset still sits in the filler blob, chew within max extend."""
    import wave

    from podcast_mcp.edits.inaudible_cuts import _extend_end_past_trailing_energy

    ws = tmp_path / "chew"
    raw = ws / "raw"
    raw.mkdir(parents=True)
    wav = raw / "host.wav"
    sr = 16000
    t = np.arange(sr, dtype=np.float32) / sr
    sig = np.zeros_like(t)
    burst = (t >= 0.40) & (t < 0.58)
    sig[burst] = 0.4 * np.sin(2 * np.pi * 200 * t[burst])
    pcm = (np.clip(sig, -1, 1) * 32767).astype(np.int16)
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())

    cfg = InaudibleCutConfig(
        trailing_energy_extend_ms=200,
        trailing_energy_hot_db=-30.0,
        trailing_energy_quiet_db=-40.0,
        trailing_energy_hop_ms=10,
        short_cut_max_sec=1.2,
    )
    # Next word starts mid-burst; quietest before it is still hot → expand.
    new_end, extended = _extend_end_past_trailing_energy(
        wav, 0.30, 0.45, config=cfg, sample_rate=sr, search_until=0.50
    )
    assert extended
    assert new_end > 0.50
    assert new_end <= 0.65


def test_trailing_energy_skips_when_end_already_quiet(tmp_path: Path) -> None:
    import wave

    from podcast_mcp.edits.inaudible_cuts import _extend_end_past_trailing_energy

    ws = tmp_path / "quiet"
    raw = ws / "raw"
    raw.mkdir(parents=True)
    wav = raw / "host.wav"
    sr = 16000
    pcm = np.zeros(sr, dtype=np.int16)
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    cfg = InaudibleCutConfig(trailing_energy_extend_ms=200, short_cut_max_sec=1.2)
    new_end, extended = _extend_end_past_trailing_energy(
        wav, 0.1, 0.2, config=cfg, sample_rate=sr, search_until=0.4
    )
    assert extended is False
    assert new_end == 0.2


def test_quietest_hop_end_rejects_tiny_or_missing_audio(tmp_path: Path) -> None:
    from podcast_mcp.edits.inaudible_cuts import _quietest_hop_end

    cfg = InaudibleCutConfig()
    fake = tmp_path / "missing-inaudible-hop.wav"
    assert (
        _quietest_hop_end(fake, 1.0, 1.002, config=cfg, sample_rate=16000, audio_cache=None) is None
    )
    assert (
        _quietest_hop_end(fake, 1.0, 1.015, config=cfg, sample_rate=16000, audio_cache=None) is None
    )


def test_trailing_energy_disabled_or_long_cut_is_noop(tmp_path: Path) -> None:
    from podcast_mcp.edits.inaudible_cuts import _extend_end_past_trailing_energy

    wav = tmp_path / "unused.wav"
    disabled = InaudibleCutConfig(trailing_energy_extend_ms=0, short_cut_max_sec=1.2)
    end, extended = _extend_end_past_trailing_energy(
        wav, 0.0, 0.2, config=disabled, sample_rate=16000
    )
    assert end == 0.2 and extended is False

    long_cut = InaudibleCutConfig(trailing_energy_extend_ms=200, short_cut_max_sec=0.1)
    end, extended = _extend_end_past_trailing_energy(
        wav, 0.0, 0.5, config=long_cut, sample_rate=16000
    )
    assert end == 0.5 and extended is False


def test_optimize_timeline_cut_range(tmp_path):
    p = _project(tmp_path)
    fake = np.array([0.6, 0.4, 0.2, 0.05, 0.01, 0.1, 0.4], dtype=np.float32)
    with patch("podcast_mcp.edits.inaudible_cuts.load_mono_window", return_value=fake):
        opt = optimize_timeline_cut_range(p, "host", 2.0, 4.0)
    assert opt.end > opt.start


def test_recommend_micro_fades_positive():
    rec = recommend_micro_fades()
    assert rec["fade_in_ms"] > 0
    assert rec["fade_out_ms"] > 0


def test_cut_time_range_calls_optimizer(tmp_path):
    p = _project(tmp_path)
    with patch("podcast_mcp.edits.transcript_cuts.optimize_source_cut_range") as opt:
        opt.return_value = type(
            "R",
            (),
            {
                "start": 1.1,
                "end": 2.2,
                "mode": "vocal_transcript_guided",
                "confidence": 0.9,
            },
        )()
        cut_time_range(p, "host", 1.0, 2.0)
    assert opt.called


def test_ripple_delete_calls_timeline_optimizer(tmp_path):
    p = _project(tmp_path)
    with patch("podcast_mcp.edits.timeline_ops.optimize_timeline_cut_range") as opt:
        opt.return_value = type(
            "R", (), {"start": 2.0, "end": 3.0, "mode": "vocal_transcript_guided"}
        )()
        ripple_delete(p, 2.0, 3.0)
    assert opt.called


def test_ripple_delete_override_forwards_flag(tmp_path):
    p = _project(tmp_path)
    with patch("podcast_mcp.edits.timeline_ops.optimize_timeline_cut_range") as opt:
        opt.return_value = type(
            "R", (), {"start": 2.0, "end": 3.0, "mode": "vocal_transcript_guided"}
        )()
        ripple_delete(p, 2.0, 3.0, use_inaudible_opt=False)
    assert opt.call_args.kwargs.get("force_enabled") is False


def test_strip_silence_ignores_inaudible_opt_flag(tmp_path):
    """Strip keeps speech islands as-is; use_inaudible_opt is API-compat only."""
    p = _project(tmp_path)
    with (
        patch("podcast_mcp.edits.strip_silence.detect_silence", return_value=[]),
        patch("podcast_mcp.engines.ffmpeg.FFmpegEngine") as eng_cls,
    ):
        eng_cls.return_value.probe.return_value = type("Probe", (), {"duration_sec": 2.0})()
        out_default = strip_silence(p, "host")
        out_false = strip_silence(p, "host", use_inaudible_opt=False)
        out_true = strip_silence(p, "host", use_inaudible_opt=True)
    assert out_default["clips_created"] == 1
    assert out_false["clips_created"] == out_default["clips_created"]
    assert out_true["clips_created"] == out_default["clips_created"]


def test_word_only_boundaries_within_tolerance(tmp_path):
    p = _project(tmp_path)
    cfg = InaudibleCutConfig(max_shift_ms=80)
    with patch(
        "podcast_mcp.edits.inaudible_cuts._snap_boundary_to_waveform",
        side_effect=lambda _path, center, **kwargs: center,
    ):
        word_only = optimize_source_cut_range(p, "host", 2.15, 4.1, config=cfg, force_enabled=True)
        passthrough = optimize_source_cut_range(
            p, "host", 2.15, 4.1, config=cfg, force_enabled=False
        )
    assert abs(word_only.shifted_start_ms) <= cfg.max_shift_ms
    assert abs(word_only.shifted_end_ms) <= cfg.max_shift_ms
    assert passthrough.shifted_start_ms == 0.0
    assert passthrough.shifted_end_ms == 0.0


def test_full_mode_matches_subprocess_snap(sample_wav, tmp_path):
    p = _project(tmp_path)
    raw = tmp_path / "ws" / "raw" / "host.wav"
    raw.write_bytes(sample_wav.read_bytes())
    cfg = InaudibleCutConfig(max_shift_ms=80, search_window_ms=40)

    with patch("podcast_mcp.edits.inaudible_cuts.load_mono_window") as mocked:
        fake = np.array([0.6, 0.4, 0.2, 0.05, 0.01, 0.1, 0.4], dtype=np.float32)
        mocked.return_value = fake
        optimized = optimize_source_cut_range(p, "host", 1.0, 1.5, config=cfg, force_enabled=True)

    assert optimized.end > optimized.start
    assert abs(optimized.shifted_start_ms) <= cfg.max_shift_ms
    assert abs(optimized.shifted_end_ms) <= cfg.max_shift_ms
    assert mocked.call_count >= 2


def test_track_audio_path_raises(tmp_path):
    p = _project(tmp_path)
    with pytest.raises(ValueError, match="not found"):
        from podcast_mcp.util.tracks import track_audio_path

        track_audio_path(p, "missing")


def test_optimize_source_end_before_start_raises(tmp_path):
    p = _project(tmp_path)
    with pytest.raises(ValueError, match="end must be after start"):
        optimize_source_cut_range(p, "host", 2.0, 2.0)


def test_optimize_source_clamps_when_end_too_close(tmp_path):
    p = _project(tmp_path)
    cfg = InaudibleCutConfig(max_shift_ms=80, enabled=False)
    opt = optimize_source_cut_range(p, "host", 2.0, 2.00001, config=cfg)
    assert opt.end > opt.start


def test_optimize_source_no_track_passthrough(tmp_path):
    p = _project(tmp_path)
    opt = optimize_source_cut_range(p, "missing", 1.0, 2.0)
    assert opt.start == 1.0
    assert opt.details["strategy"] == "passthrough:no-track"


def test_optimize_timeline_invalid_range_raises(tmp_path):
    p = _project(tmp_path)
    with pytest.raises(ValueError, match="timeline_end must be after"):
        optimize_timeline_cut_range(p, "host", 3.0, 3.0)


def test_optimize_timeline_passthrough_without_clip_match(tmp_path):
    p = _project(tmp_path)
    opt = optimize_timeline_cut_range(p, "host", 50.0, 55.0)
    assert opt.start == 50.0
    assert opt.details["strategy"] == "passthrough"


def test_source_to_timeline_after_last_clip(tmp_path):
    p = _project(tmp_path)
    from podcast_mcp.edits.inaudible_cuts import _source_to_timeline

    tl = _source_to_timeline(p, "host", 25.0)
    assert tl == pytest.approx(20.0)


def test_source_to_timeline_gap_clamps_to_join(tmp_path):
    p = _project(tmp_path)
    p.timeline.clips = [
        Clip(id="h1", track_id="host", source_start=0.0, source_end=5.0, timeline_start=0.0),
        Clip(
            id="h2",
            track_id="host",
            source_start=10.0,
            source_end=20.0,
            timeline_start=5.0,
        ),
    ]
    from podcast_mcp.edits.inaudible_cuts import _source_to_timeline

    # Source 7.5 was cut away; it clamps to the timeline join at 5.0.
    assert _source_to_timeline(p, "host", 7.5) == pytest.approx(5.0)


def test_zero_crossing_score_at_sign_change(tmp_path):
    from podcast_mcp.edits.inaudible_cuts import (
        InaudibleCutConfig,
        _score_samples,
        _zero_crossing_score,
    )

    samples = np.array([0.2, -0.2, 0.15, -0.1], dtype=np.float32)
    assert _zero_crossing_score(samples, 1) == 0.0
    cfg = InaudibleCutConfig()
    assert _score_samples(samples, 1, cfg) < _score_samples(samples, 0, cfg)


def test_enforce_word_margin_clamps_near_neighbor(tmp_path):
    p = _project(tmp_path)
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="a", start=1.0, end=1.4),
                TranscriptWord(text="um", start=1.42, end=1.5),
                TranscriptWord(text="b", start=1.52, end=2.0),
            ],
        )
    ]
    cfg = InaudibleCutConfig(max_shift_ms=80, min_word_margin_ms=20)
    fake = np.linspace(0.5, 0.0, 80, dtype=np.float32)
    with patch("podcast_mcp.edits.inaudible_cuts.load_mono_window", return_value=fake):
        opt = optimize_source_cut_range(p, "host", 1.42, 1.5, config=cfg, force_enabled=True)
    assert opt.end - opt.start >= 0.01
    assert opt.end <= 1.52 - (cfg.min_word_margin_ms / 1000.0) + 0.05


def test_absorb_trailing_silence_extends_to_breath_floor(tmp_path: Path) -> None:
    import wave

    from podcast_mcp.edits.inaudible_cuts import _absorb_trailing_silence

    ws = tmp_path / "absorb"
    raw = ws / "raw"
    raw.mkdir(parents=True)
    wav = raw / "host.wav"
    sr = 16000
    # 5s of near-silence
    pcm = np.zeros(sr * 5, dtype=np.int16)
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())

    p = EpisodeProject.create("absorb", str(ws))
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=5.0),
        )
    ]
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.5, end=1.0),
                TranscriptWord(text="restart", start=1.0, end=1.5),
                TranscriptWord(text="kept", start=2.8, end=3.2),
            ],
        )
    ]
    cfg = InaudibleCutConfig(
        absorb_trailing_silence=True,
        absorb_trailing_silence_retain_sec=0.4,
        absorb_trailing_silence_max_sec=2.0,
        absorb_trailing_silence_quiet_db=-40.0,
    )
    new_end, absorbed = _absorb_trailing_silence(p, "host", wav, 1.5, config=cfg, sample_rate=sr)
    assert absorbed is True
    assert new_end == pytest.approx(2.4, abs=0.02)

    opt = optimize_source_cut_range(p, "host", 1.0, 1.5, config=cfg, force_enabled=True)
    assert opt.details.get("absorb_trailing_silence") is True
    assert opt.end == pytest.approx(2.4, abs=0.05)


def test_absorb_trailing_silence_skips_distant_next_word(tmp_path: Path) -> None:
    import wave

    from podcast_mcp.edits.inaudible_cuts import _absorb_trailing_silence

    ws = tmp_path / "far"
    raw = ws / "raw"
    raw.mkdir(parents=True)
    wav = raw / "host.wav"
    sr = 16000
    pcm = np.zeros(sr * 8, dtype=np.int16)
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())

    p = EpisodeProject.create("far", str(ws))
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=8.0),
        )
    ]
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="a", start=0.5, end=1.0),
                TranscriptWord(text="b", start=5.0, end=5.5),
            ],
        )
    ]
    cfg = InaudibleCutConfig(
        absorb_trailing_silence_max_sec=2.0,
        absorb_trailing_silence_retain_sec=0.4,
    )
    new_end, absorbed = _absorb_trailing_silence(p, "host", wav, 1.0, config=cfg, sample_rate=sr)
    assert absorbed is False
    assert new_end == 1.0


def test_absorb_trailing_silence_skips_when_gap_not_quiet(tmp_path: Path) -> None:
    import wave

    from podcast_mcp.edits.inaudible_cuts import _absorb_trailing_silence

    ws = tmp_path / "noisy"
    raw = ws / "raw"
    raw.mkdir(parents=True)
    wav = raw / "host.wav"
    sr = 16000
    t = np.arange(sr * 4, dtype=np.float32) / sr
    sig = 0.3 * np.sin(2 * np.pi * 220 * t)
    pcm = (np.clip(sig, -1, 1) * 32767).astype(np.int16)
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())

    p = EpisodeProject.create("noisy", str(ws))
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=4.0),
        )
    ]
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="a", start=0.5, end=1.0),
                TranscriptWord(text="b", start=2.2, end=2.6),
            ],
        )
    ]
    cfg = InaudibleCutConfig(
        absorb_trailing_silence_max_sec=2.0,
        absorb_trailing_silence_retain_sec=0.4,
        absorb_trailing_silence_quiet_db=-45.0,
    )
    new_end, absorbed = _absorb_trailing_silence(p, "host", wav, 1.0, config=cfg, sample_rate=sr)
    assert absorbed is False
    assert new_end == 1.0


def test_absorb_trailing_silence_disabled_and_no_next_word(tmp_path: Path) -> None:
    import wave
    from unittest.mock import patch

    from podcast_mcp.edits.inaudible_cuts import (
        _absorb_trailing_silence,
        _region_is_quiet,
        optimize_source_cut_range,
    )

    ws = tmp_path / "edge"
    raw = ws / "raw"
    raw.mkdir(parents=True)
    wav = raw / "host.wav"
    sr = 16000
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(np.zeros(sr * 3, dtype=np.int16).tobytes())
    p = EpisodeProject.create("edge", str(ws))
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=3.0),
        )
    ]
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="only", start=0.2, end=0.5),
                TranscriptWord(text="next", start=1.5, end=1.8),
            ],
        )
    ]
    disabled = InaudibleCutConfig(absorb_trailing_silence=False)
    end, ok = _absorb_trailing_silence(p, "host", wav, 0.5, config=disabled)
    assert ok is False and end == 0.5
    enabled = InaudibleCutConfig(absorb_trailing_silence=True)
    end2, ok2 = _absorb_trailing_silence(p, "host", wav, 1.8, config=enabled)
    assert ok2 is False and end2 == 1.8
    assert _region_is_quiet(
        wav, 0.5, 0.505, quiet_db=-40, hop_ms=10, sample_rate=sr, audio_cache=None
    )
    missing = tmp_path / "nope.wav"
    assert (
        _region_is_quiet(
            missing, 0.0, 0.5, quiet_db=-40, hop_ms=10, sample_rate=sr, audio_cache=None
        )
        is False
    )
    with (
        patch(
            "podcast_mcp.edits.inaudible_cuts.load_mono_window",
            return_value=np.zeros(80, dtype=np.float32),
        ),
        patch(
            "podcast_mcp.edits.inaudible_cuts._rms_db_hops",
            return_value=[],
        ),
    ):
        assert (
            _region_is_quiet(
                wav, 0.0, 0.5, quiet_db=-40, hop_ms=10, sample_rate=sr, audio_cache=None
            )
            is False
        )
    # Exception path inside optimize_source_cut_range absorb call
    with (
        patch(
            "podcast_mcp.edits.inaudible_cuts._absorb_trailing_silence",
            side_effect=RuntimeError("boom"),
        ),
        patch(
            "podcast_mcp.edits.inaudible_cuts.load_mono_window",
            return_value=np.zeros(80, dtype=np.float32),
        ),
    ):
        opt = optimize_source_cut_range(p, "host", 0.2, 0.5, config=enabled, force_enabled=True)
    assert opt.end >= opt.start
