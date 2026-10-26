from __future__ import annotations

import os
from pathlib import Path

import pytest

from podcast_mcp.engines.ffmpeg import AudioProbe, FFmpegEngine
from podcast_mcp.engines.media_probe import probe_first_audio_duration_sec, probe_media
from podcast_mcp.engines.play_audit import probe_wav_duration_sec


@pytest.mark.parametrize("audio_duration", [None, 0, -1, float("nan"), float("inf")])
def test_first_audio_duration_has_no_container_fallback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, audio_duration: float | None
) -> None:
    path = tmp_path / "media.wav"
    path.write_bytes(b"probe fixture")
    monkeypatch.setattr(
        FFmpegEngine,
        "probe",
        lambda *_: AudioProbe(
            duration_sec=3,
            sample_rate=48000,
            channels=1,
            audio_duration_sec=audio_duration,
            audio_start_sec=0.0,
        ),
    )
    assert probe_wav_duration_sec(path) == 3
    assert probe_first_audio_duration_sec(path) is None


def test_duration_policies_share_successful_revision_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "media.wav"
    path.write_bytes(b"probe fixture")
    calls: list[Path] = []

    def probe(_engine: FFmpegEngine, selected: Path) -> AudioProbe:
        calls.append(selected)
        return AudioProbe(
            duration_sec=3,
            sample_rate=48000,
            channels=1,
            audio_duration_sec=0.7,
            audio_start_sec=0.0,
        )

    monkeypatch.setattr(FFmpegEngine, "probe", probe)
    assert probe_wav_duration_sec(path) == 3
    assert probe_first_audio_duration_sec(path) == 0.7
    assert probe_first_audio_duration_sec(tmp_path / "." / "media.wav") == 0.7
    assert len(calls) == 1
    info = probe_media(path)
    assert info is not None
    info.audio_duration_sec = 9
    assert probe_first_audio_duration_sec(path) == 0.7
    stat = path.stat()
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
    assert probe_first_audio_duration_sec(path) == 0.7
    assert len(calls) == 2


def test_estimated_audio_extent_refuses_after_cached_container_lookup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "media.wav"
    path.write_bytes(b"probe fixture")
    monkeypatch.setattr(
        FFmpegEngine,
        "probe",
        lambda *_: AudioProbe(
            duration_sec=3,
            sample_rate=48000,
            channels=1,
            audio_duration_sec=3,
            duration_estimated=True,
            audio_start_sec=0.0,
        ),
    )
    assert probe_wav_duration_sec(path) == 3
    assert probe_first_audio_duration_sec(path) is None


def test_multistream_declared_extent_remains_conservative(tmp_path, monkeypatch):
    path = tmp_path / "multi.m4a"
    path.write_bytes(b"mock media")
    monkeypatch.setattr(
        FFmpegEngine,
        "probe",
        lambda *_: AudioProbe(
            3, 48000, 1, audio_duration_sec=3, audio_stream_count=2, audio_start_sec=0.0
        ),
    )
    assert probe_media(path).require_duration_sec() == 3
    assert probe_first_audio_duration_sec(path) is None


def test_failed_shared_probe_retries_on_later_calls(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "media.wav"
    path.write_bytes(b"probe fixture")
    calls = 0

    def probe(*_args) -> AudioProbe:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("unavailable media")
        return AudioProbe(
            duration_sec=3, sample_rate=48000, channels=1, audio_duration_sec=3, audio_start_sec=0.0
        )

    monkeypatch.setattr(FFmpegEngine, "probe", probe)
    assert probe_first_audio_duration_sec(path) is None
    assert probe_wav_duration_sec(path) == 3
    assert probe_first_audio_duration_sec(path) == 3
    assert calls == 2


def test_missing_media_does_not_probe(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def probe(*_args):
        pytest.fail("Missing media must not run ffprobe")

    monkeypatch.setattr(FFmpegEngine, "probe", probe)
    assert probe_first_audio_duration_sec(tmp_path / "missing.wav") is None


def test_first_audio_duration_refuses_ffprobe_na_extent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import json
    from types import SimpleNamespace

    path = tmp_path / "media.wav"
    path.write_bytes(b"probe fixture")
    result = SimpleNamespace(
        stdout=json.dumps(
            {
                "format": {"duration": "3"},
                "streams": [
                    {
                        "codec_type": "audio",
                        "duration": "N/A",
                        "sample_rate": "48000",
                        "channels": 1,
                    }
                ],
            }
        ),
        stderr="",
    )
    monkeypatch.setattr("podcast_mcp.engines.ffmpeg.run", lambda *_args, **_kwargs: result)
    assert probe_wav_duration_sec(path) == 3
    assert probe_first_audio_duration_sec(path) is None
