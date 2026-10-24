from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import pytest

from podcast_mcp.edits import audio_cache
from podcast_mcp.edits.audio_cache import build_track_audio_caches
from podcast_mcp.models import EpisodeProject, MediaAsset, Track, TrackRole
from podcast_mcp.util.batch_scope import batch_scope

BARRIER_TIMEOUT_SEC = 5


def _project(tmp_path: Path, files: dict[str, str]) -> EpisodeProject:
    project = EpisodeProject.create("concurrent decode", str(tmp_path))
    project.tracks = []
    for track_id, name in files.items():
        path = tmp_path / "raw" / name
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(b"audio")
        project.tracks.append(
            Track(
                id=track_id,
                label=track_id,
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=f"raw/{name}", duration_sec=1),
            )
        )
    return project


def _stub_decode(monkeypatch: pytest.MonkeyPatch, decode: Any) -> list[Path]:
    seen: list[Path] = []
    lock = threading.Lock()

    def record(path: Path) -> Any:
        with lock:
            seen.append(path)
        return decode(path)

    monkeypatch.setattr(audio_cache, "decode_track", record)
    return seen


def test_tracks_decode_at_the_same_time(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    project = _project(tmp_path, {"a": "a.wav", "b": "b.wav", "c": "c.wav"})
    meet = threading.Barrier(3, timeout=BARRIER_TIMEOUT_SEC)

    def decode(path: Path) -> Path:
        meet.wait()
        return path

    _stub_decode(monkeypatch, decode)

    caches = build_track_audio_caches(project, ["a", "b", "c"])

    assert list(caches) == ["a", "b", "c"]
    assert [caches[t] for t in caches] == [tmp_path / "raw" / f"{t}.wav" for t in caches]


def test_a_track_that_fails_to_decode_is_skipped_and_the_rest_keep_their_order(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, {"a": "a.wav", "b": "b.wav", "c": "c.wav"})

    def decode(path: Path) -> Path:
        if path.name == "b.wav":
            raise OSError("unreadable")
        return path

    _stub_decode(monkeypatch, decode)

    caches = build_track_audio_caches(project, ["c", "b", "a"])

    assert list(caches) == ["c", "a"]


def test_an_unknown_track_is_skipped_and_a_repeated_id_decodes_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, {"a": "a.wav", "b": "b.wav"})
    seen = _stub_decode(monkeypatch, lambda path: path)

    caches = build_track_audio_caches(project, ["a", "missing", "b", "a"])

    assert list(caches) == ["a", "b"]
    assert sorted(p.name for p in seen) == ["a.wav", "b.wav"]


def test_tracks_that_share_a_file_decode_it_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, {"a": "same.wav", "b": "same.wav", "c": "c.wav"})
    seen = _stub_decode(monkeypatch, lambda path: object())

    with batch_scope():
        caches = build_track_audio_caches(project, ["a", "b", "c"])

    assert caches["a"] is caches["b"]
    assert sorted(p.name for p in seen) == ["c.wav", "same.wav"]


def test_the_batch_scope_reaches_the_workers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, {"a": "a.wav", "b": "b.wav", "c": "c.wav"})
    seen = _stub_decode(monkeypatch, lambda path: object())

    with batch_scope():
        first = build_track_audio_caches(project, ["a", "b", "c"])
        second = build_track_audio_caches(project, ["c", "b", "a"])

    assert len(seen) == 3
    assert all(second[t] is first[t] for t in first)
