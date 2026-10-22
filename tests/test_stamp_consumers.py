"""The key parts each ``file_stamp`` consumer keeps, pinned by behavior (#2007).

``tests/test_fingerprint.py`` only pins which modules import the stamp. These fail when a
site drops or reorders a part it keys on.
"""

from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from podcast_mcp.engines import gate_fill, play_audit
from podcast_mcp.engines.alignment_audit import VADWindowRMSCache
from podcast_mcp.engines.decoded_source import _identity
from podcast_mcp.models import (
    EpisodeProject,
    GateFill,
    GateFillSource,
    MediaAsset,
    Track,
    TrackRole,
)

T0 = 1_700_000_000_000_000_000


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
    _file(path, b"abcd", mtime_ns=T0 + 1)
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
    _file(premix, b"abcd", mtime_ns=T0 + 1)
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
    _file(media, b"x" * 100, mtime_ns=T0 + 1)
    assert gate_fill.current_gate_fill_path(project, track) is None
    _file(media, b"x" * 101, mtime_ns=T0)
    assert gate_fill.current_gate_fill_path(project, track) is None
    media.unlink()
    assert gate_fill.current_gate_fill_path(project, track) is None


def test_gate_fill_payload_file_part_is_the_fill_files_size_and_mtime(tmp_path: Path) -> None:
    project, track, _media = _gate_filled_project(tmp_path)
    fill = tmp_path / "fill.wav"

    first = gate_fill.gate_fill_payload(project, track)
    _file(fill, b"fills", mtime_ns=T0 + 5)
    second = gate_fill.gate_fill_payload(project, track)

    assert first is not None
    assert second is not None
    assert first["file"] == [4, T0]
    assert second["file"] == [5, T0 + 5]


def test_plan_gate_fill_refuses_when_the_media_changes_while_it_is_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project, track, media = _gate_filled_project(tmp_path)
    holes = SimpleNamespace(bounds=[(0, 1)], sample_rate=16000, seconds=0.5)
    monkeypatch.setattr(gate_fill, "detect_gate_holes", lambda _path: holes)

    def fill_and_touch(*_args: object) -> SimpleNamespace:
        _file(media, b"x" * 100, mtime_ns=T0 + 7)
        return SimpleNamespace(samples=None, level_db=-60.0, noise_db=None, basis="test")

    monkeypatch.setattr(gate_fill, "FILL_SOURCES", [(GateFillSource.COMFORT_NOISE, fill_and_touch)])
    monkeypatch.setattr(gate_fill, "_write_fill", lambda *_args: "fill.wav")

    result = gate_fill.plan_gate_fill(project, track, fade_ms=5)

    assert result.fill is None
    assert result.reason == "media changed while read"
