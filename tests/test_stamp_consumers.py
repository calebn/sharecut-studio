"""The key parts each ``file_stamp`` consumer keeps, pinned by behavior (#2007).

``tests/test_fingerprint.py`` only pins which modules import the stamp. These fail when a
site drops or reorders a part it keys on. Consumers pinned here: decoded_source, the alignment
audit cache, ``master_source_hash``, ``proxy_render_hash``, gate fill, the prosody profile cache
and the word aligner's local-source identity.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits import prosody_profile as pp
from podcast_mcp.edits import transcript_reuse
from podcast_mcp.engines import gate_fill, play_audit
from podcast_mcp.engines.alignment_audit import VADWindowRMSCache
from podcast_mcp.engines.decoded_source import _identity
from podcast_mcp.engines.word_align import WordAligner
from podcast_mcp.models import (
    EpisodeProject,
    GateFill,
    GateFillSource,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
)
from test_prosody_profile import _project_with_host
from test_word_align import _fake_onnxruntime, _snapshot

T0 = 1_700_000_000_000_000_000
SEC = 1_000_000_000


def _file(path: Path, data: bytes = b"abc", mtime_ns: int = T0) -> Path:
    path.write_bytes(data)
    os.utime(path, ns=(mtime_ns, mtime_ns))
    return path


def _replace_keeping_size_and_mtime(path: Path) -> None:
    stat = path.stat()
    other = path.with_name("replacement.bin")
    other.write_bytes(b"x" * stat.st_size)
    os.utime(other, ns=(stat.st_mtime_ns, stat.st_mtime_ns))
    os.replace(other, path)


def test_decoded_source_key_follows_the_file_and_the_sample_rate(tmp_path: Path) -> None:
    path = _file(tmp_path / "a.wav")
    key = _identity(path, 16000)

    assert key[0] == str(path.resolve())
    assert key[-1] == 16000
    assert _identity(path, 16000) == key
    assert _identity(path, 48000) != key
    _file(path, b"abcd")
    assert _identity(path, 16000) != key
    changed = _identity(path, 16000)
    _file(path, b"abcd", mtime_ns=T0 + 2 * SEC)
    assert _identity(path, 16000) != changed
    before = _identity(path, 16000)
    _replace_keeping_size_and_mtime(path)
    assert _identity(path, 16000) != before


def test_alignment_audit_identity_notices_a_replaced_file_and_a_missing_one(
    tmp_path: Path,
) -> None:
    path = _file(tmp_path / "a.wav")
    key = VADWindowRMSCache.file_identity(path)

    assert key is not None
    assert key[0] == str(path.absolute())
    assert len(key) == 7
    assert VADWindowRMSCache.file_identity(path) == key
    _replace_keeping_size_and_mtime(path)
    assert VADWindowRMSCache.file_identity(path) != key
    assert VADWindowRMSCache.file_identity(tmp_path / "missing.wav") is None


def test_alignment_audit_identity_moves_with_size_and_with_mtime(tmp_path: Path) -> None:
    path = _file(tmp_path / "a.wav")
    key = VADWindowRMSCache.file_identity(path)

    _file(path, b"abcd")
    resized = VADWindowRMSCache.file_identity(path)
    _file(path, b"abcd", mtime_ns=T0 + 2 * SEC)
    touched = VADWindowRMSCache.file_identity(path)

    assert resized is not None
    assert touched is not None
    assert key is not None
    assert resized[4] == 4
    assert key[4] == 3
    assert touched[5] == T0 + 2 * SEC
    assert len({key, resized, touched}) == 3


def test_master_source_hash_moves_with_the_premix_size_and_mtime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    premix = _file(tmp_path / "premix.wav", b"abc")
    monkeypatch.setattr(play_audit, "premix_path", lambda _project: premix)
    monkeypatch.setattr(play_audit, "read_premix_hash", lambda _project: "mixhash")
    project = EpisodeProject.create("hash", str(tmp_path))

    base = play_audit.master_source_hash(project)

    assert base is not None
    assert play_audit.master_source_hash(project) == base
    _file(premix, b"abcd")
    resized = play_audit.master_source_hash(project)
    assert resized != base
    _file(premix, b"abcd", mtime_ns=T0 + 2 * SEC)
    assert play_audit.master_source_hash(project) != resized
    premix.unlink()
    assert play_audit.master_source_hash(project) is None


def _gate_filled_project(tmp_path: Path) -> tuple[EpisodeProject, Track, Path]:
    (tmp_path / "raw").mkdir()
    media = _file(tmp_path / "raw" / "guest.wav", b"x" * 100)
    project = EpisodeProject.create("gate", str(tmp_path))
    track = Track(
        id="guest",
        label="Guest",
        role=TrackRole.DIALOGUE,
        media=MediaAsset(path="raw/guest.wav", duration_sec=1.0, sample_rate=16000, channels=1),
    )
    _file(tmp_path / "fill.wav", b"fill")
    track.gate_fill = GateFill(
        source=GateFillSource.COMFORT_NOISE,
        path="fill.wav",
        media_size=100,
        media_mtime_ns=T0,
        holes=1,
        filled_sec=0.5,
        level_db=-60.0,
        fade_ms=5,
    )
    project.tracks.append(track)
    return project, track, media


def test_gate_fill_applies_only_while_the_media_size_and_mtime_match(tmp_path: Path) -> None:
    project, track, media = _gate_filled_project(tmp_path)

    assert gate_fill.current_gate_fill_path(project, track) == tmp_path / "fill.wav"
    payload = gate_fill.gate_fill_payload(project, track)
    assert payload is not None
    assert payload["file"] == [4, T0]
    _file(media, b"x" * 100, mtime_ns=T0 + 2 * SEC)
    assert gate_fill.current_gate_fill_path(project, track) is None
    _file(media, b"x" * 101, mtime_ns=T0)
    assert gate_fill.current_gate_fill_path(project, track) is None
    media.unlink()
    assert gate_fill.current_gate_fill_path(project, track) is None


def test_gate_fill_payload_file_part_is_the_fill_files_size_and_mtime(tmp_path: Path) -> None:
    project, track, _media = _gate_filled_project(tmp_path)
    fill = tmp_path / "fill.wav"

    first = gate_fill.gate_fill_payload(project, track)
    _file(fill, b"fills", mtime_ns=T0 + 6 * SEC)
    second = gate_fill.gate_fill_payload(project, track)

    assert first is not None
    assert second is not None
    assert first["file"] == [4, T0]
    assert second["file"] == [5, T0 + 6 * SEC]


def test_plan_gate_fill_refuses_when_the_media_changes_while_it_is_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project, track, media = _gate_filled_project(tmp_path)
    holes = SimpleNamespace(bounds=[(0, 1)], sample_rate=16000, seconds=0.5)
    monkeypatch.setattr(gate_fill, "detect_gate_holes", lambda _path: holes)

    def fill_and_touch(*_args: object) -> SimpleNamespace:
        _file(media, b"x" * 100, mtime_ns=T0 + 8 * SEC)
        return SimpleNamespace(samples=None, level_db=-60.0, noise_db=None, basis="test")

    monkeypatch.setattr(gate_fill, "FILL_SOURCES", [(GateFillSource.COMFORT_NOISE, fill_and_touch)])
    monkeypatch.setattr(gate_fill, "_write_fill", lambda *_args: "fill.wav")

    result = gate_fill.plan_gate_fill(project, track, fade_ms=5)

    assert result.fill is None
    assert result.reason == "media changed while read"


def _prosody(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    path = _project_with_host(tmp_path)
    media = tmp_path / "raw" / "host.wav"
    _file(media, media.read_bytes(), T0)
    monkeypatch.setattr(pp, "parselmouth_version", lambda: "test")
    monkeypatch.setattr(
        pp,
        "analyze_prosody_file",
        lambda *_args, **_kwargs: {"engine": {"version": "test"}, "segments": []},
    )
    return path, media


def test_prosody_reuse_rehashes_only_on_stat_change(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path, media = _prosody(tmp_path, monkeypatch)
    project = load_project(path)
    hashes: list[Path] = []
    real_sha256 = transcript_reuse.sha256_file

    def counting_sha256(audio: Path) -> str:
        hashes.append(audio)
        return real_sha256(audio)

    monkeypatch.setattr(transcript_reuse, "sha256_file", counting_sha256)

    assert pp.run_prosody_analysis(project, {}).computed == ["host"]
    hashes.clear()
    again = pp.run_prosody_analysis(project, {})

    assert again.reused == ["host"]
    assert len(hashes) == 0
    _file(media, media.read_bytes(), T0 + 2 * SEC)
    touched = pp.run_prosody_analysis(project, {})
    assert touched.reused == ["host"]
    assert len(hashes) == 1
    profile = pp.load_track_profile(project, "host").profile
    assert profile is not None
    assert profile.audio_mtime_ns == T0 + 2 * SEC


def test_prosody_stale_on_size_alone_and_mtime_alone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path, media = _prosody(tmp_path, monkeypatch)
    project = load_project(path)
    data = media.read_bytes()
    pp.run_prosody_analysis(project, {})
    assert pp.load_track_profile(project, "host").status == "fresh"

    _file(media, data, T0 + 2 * SEC)
    touched = pp.load_track_profile(project, "host")
    _file(media, data + b"x", T0)
    resized = pp.load_track_profile(project, "host")

    assert touched.status == "stale"
    assert touched.hint is not None
    assert "audio changed" in touched.hint
    assert resized.status == "stale"
    assert resized.hint is not None
    assert "audio changed" in resized.hint

    def rewrite(size_delta: bytes, mtime_ns: int) -> None:
        def analyze(*_args: object, **_kwargs: object) -> dict[str, Any]:
            _file(media, media.read_bytes() + size_delta, mtime_ns)
            return {"engine": {"version": "test"}, "segments": []}

        monkeypatch.setattr(pp, "analyze_prosody_file", analyze)
        for old in pp.prosody_dir(project).glob("host_*.json"):
            old.unlink()
        with pytest.raises(RuntimeError, match="media changed"):
            pp.run_prosody_analysis(project, {})
        assert list(pp.prosody_dir(project).glob("host_*.json")) == []

    rewrite(b"y", T0)
    rewrite(b"", T0 + SEC)


def test_prosody_reads_the_newest_cached_profile(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path, _media = _prosody(tmp_path, monkeypatch)
    project = load_project(path)
    pp.run_prosody_analysis(project, {})
    (original,) = pp.prosody_dir(project).glob("host_*.json")
    copy = original.with_name(f"host_{'0' * 16}_{'0' * 16}.json")
    data = json.loads(original.read_text(encoding="utf-8"))
    data["audio_size"] = 999
    copy.write_text(json.dumps(data), encoding="utf-8")

    os.utime(original, ns=(T0, T0))
    os.utime(copy, ns=(T0 + 2 * SEC, T0 + 2 * SEC))
    newer_copy = pp.load_track_profile(project, "host").profile
    os.utime(original, ns=(T0 + 4 * SEC, T0 + 4 * SEC))
    newer_original = pp.load_track_profile(project, "host").profile

    assert newer_copy is not None
    assert newer_copy.audio_size == 999
    assert newer_original is not None
    assert newer_original.audio_size == 205484


def _proxy_project(tmp_path: Path) -> tuple[EpisodeProject, Path]:
    (tmp_path / "raw").mkdir()
    media = _file(tmp_path / "raw" / "host.wav", b"abc")
    project = EpisodeProject.create("proxy", str(tmp_path))
    project.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=1.0, sample_rate=16000, channels=1),
        )
    )
    return project, media


def test_proxy_render_hash_moves_with_name_size_and_mtime(tmp_path: Path) -> None:
    project, media = _proxy_project(tmp_path)
    defaults = load_defaults()

    base = play_audit.proxy_render_hash(project, "host", defaults=defaults)

    assert play_audit.proxy_render_hash(project, "host", defaults=defaults) == base
    _file(media, b"abcd")
    resized = play_audit.proxy_render_hash(project, "host", defaults=defaults)
    assert resized != base
    _file(media, b"abcd", mtime_ns=T0 + 2 * SEC)
    assert play_audit.proxy_render_hash(project, "host", defaults=defaults) != resized
    _file(media, b"abc")
    assert play_audit.proxy_render_hash(project, "host", defaults=defaults) == base
    other = _file(tmp_path / "raw" / "other.wav", b"abc")
    assert project.tracks[0].media is not None
    project.tracks[0].media.path = "raw/other.wav"
    assert other.stat().st_size == 3
    assert play_audit.proxy_render_hash(project, "host", defaults=defaults) != base
    other.unlink()
    assert play_audit.proxy_render_hash(project, "host", defaults=defaults) != base


def test_word_aligner_local_source_is_onnx_size_and_mtime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    model_dir = _snapshot(tmp_path / "snapshot")
    onnx = _file(model_dir / "onnx" / "model.onnx", b"abc")
    monkeypatch.setenv("PODCAST_MCP_WORD_ALIGNER_MODEL", str(model_dir))
    fake, _sessions = _fake_onnxruntime()
    monkeypatch.setitem(sys.modules, "onnxruntime", fake)

    def local_source() -> dict[str, Any]:
        return WordAligner.load().cache_identity()["local_source"]

    assert local_source() == {
        "dir": str(model_dir.resolve()),
        "onnx_size": 3,
        "onnx_mtime_ns": T0,
    }
    _file(onnx, b"abcd")
    resized = local_source()
    _file(onnx, b"abcd", mtime_ns=T0 + 2 * SEC)
    touched = local_source()

    assert resized["onnx_size"] == 4
    assert resized["onnx_mtime_ns"] == T0
    assert touched["onnx_size"] == 4
    assert touched["onnx_mtime_ns"] == T0 + 2 * SEC


def test_plan_gate_fill_success_records_media_stamp(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project, track, media = _gate_filled_project(tmp_path)
    holes = SimpleNamespace(bounds=[(0, 1)], sample_rate=16000, seconds=0.5)
    monkeypatch.setattr(gate_fill, "detect_gate_holes", lambda _path: holes)
    made = SimpleNamespace(samples=None, level_db=-60.0, noise_db=None, basis="test")
    monkeypatch.setattr(
        gate_fill, "FILL_SOURCES", [(GateFillSource.COMFORT_NOISE, lambda *_a: made)]
    )
    monkeypatch.setattr(gate_fill, "_write_fill", lambda *_args: "fill.wav")
    track.gate_fill = None

    result = gate_fill.plan_gate_fill(project, track, fade_ms=5)

    assert result.fill == GateFill(
        source=GateFillSource.COMFORT_NOISE,
        path="fill.wav",
        media_size=100,
        media_mtime_ns=T0,
        holes=1,
        filled_sec=0.5,
        level_db=-60.0,
        noise_db=None,
        fade_ms=5,
    )
    track.gate_fill = result.fill
    assert gate_fill.current_gate_fill_path(project, track) == tmp_path / "fill.wav"
    _file(media, b"x" * 100, mtime_ns=T0 + 2 * SEC)
    assert gate_fill.current_gate_fill_path(project, track) is None
