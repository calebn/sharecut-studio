"""A track's level profile and its RMS cache share one decode of the file (#2359)."""

from __future__ import annotations

import os
import time
import wave

import pytest

from podcast_mcp.edits import audio_cache
from podcast_mcp.engines import audio_audit, decode_memo, level_profile
from podcast_mcp.engines.audio_audit import TrackRmsCache
from podcast_mcp.engines.level_profile import (
    frame_levels_db,
    load_mono_full,
    profile_from_levels,
)
from podcast_mcp.models import MediaAsset, Track, TrackRole
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.batch_scope import batch_scope
from podcast_mcp.util.tracks import track_audio_path

RATE = 8000


@pytest.fixture
def raw_decodes(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    calls: list[int] = []

    def counted(path, *, sample_rate=8000, ffmpeg=None):  # type: ignore[no-untyped-def]
        calls.append(sample_rate)
        return load_mono_full(path, sample_rate=sample_rate, ffmpeg=ffmpeg)

    monkeypatch.setattr(level_profile, "load_mono_full", counted)
    monkeypatch.setattr(audio_audit, "load_mono_full", counted)
    monkeypatch.setattr(decode_memo, "_now_ns", lambda: time.time_ns() + 3600 * 10**9)
    decode_memo._MEMO.clear()
    level_profile._FILE_PROFILES.clear()
    return calls


def test_the_rms_cache_after_a_track_profile_decodes_nothing_new(
    minimal_project, raw_decodes: list[int]
) -> None:
    project = ProjectWorkspace.open(minimal_project).project
    project.tracks = [
        Track(
            id="host",
            label="host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=1.0),
        )
    ]
    path = track_audio_path(project, "host")
    then = time.time_ns() - 3600 * 10**9
    os.utime(path, ns=(then, then))

    profile = audio_cache.track_level_profile(project, "host", sample_rate=RATE)
    assert raw_decodes == [RATE]
    cache = TrackRmsCache.from_recording(path, sample_rate=RATE)
    assert raw_decodes == [RATE]

    expected = profile_from_levels(
        frame_levels_db(load_mono_full(path, sample_rate=RATE), RATE), whole_track=True
    )
    assert profile == expected
    assert cache.profile == expected


def test_a_batch_reads_the_memos_decode_instead_of_decoding_again(
    minimal_project, raw_decodes: list[int]
) -> None:
    project = ProjectWorkspace.open(minimal_project).project
    project.tracks = [
        Track(
            id="host",
            label="host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=1.0),
        )
    ]
    path = track_audio_path(project, "host")
    then = time.time_ns() - 3600 * 10**9
    os.utime(path, ns=(then, then))

    audio_cache.track_level_profile(project, "host", sample_rate=RATE)
    with batch_scope():
        cache = TrackRmsCache.from_recording(path, sample_rate=RATE)
        assert load_mono_full(path.resolve(), sample_rate=RATE) is cache.samples
    assert raw_decodes == [RATE]


def test_a_batch_reads_the_decode_under_the_path_it_was_given(
    minimal_project, raw_decodes: list[int], tmp_path
) -> None:
    project = ProjectWorkspace.open(minimal_project).project
    project.tracks = [
        Track(
            id="host",
            label="host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=1.0),
        )
    ]
    real = track_audio_path(project, "host")
    then = time.time_ns() - 3600 * 10**9
    os.utime(real, ns=(then, then))
    link = tmp_path / "linked.wav"
    link.symlink_to(real)

    audio_cache.track_level_profile(project, "host", sample_rate=RATE)
    with batch_scope():
        cache = TrackRmsCache.from_recording(link, sample_rate=RATE)
        assert load_mono_full(link, sample_rate=RATE) is cache.samples
    assert raw_decodes == [RATE]


def _host_project(minimal_project):
    project = ProjectWorkspace.open(minimal_project).project
    project.tracks = [
        Track(
            id="host",
            label="host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=1.0),
        )
    ]
    path = track_audio_path(project, "host")
    then = time.time_ns() - 3600 * 10**9
    os.utime(path, ns=(then, then))
    return project, path


def test_a_file_rewritten_after_the_memo_decode_is_not_seeded_into_the_batch(
    minimal_project, raw_decodes: list[int], monkeypatch: pytest.MonkeyPatch
) -> None:
    _, path = _host_project(minimal_project)
    aged = path.stat().st_mtime_ns
    real_once = audio_audit.decode_once

    def rewrite_after(*args, **kwargs):  # type: ignore[no-untyped-def]
        result = real_once(*args, **kwargs)
        with wave.open(str(path), "wb") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(RATE)
            out.writeframes(b"\x01\x00" * (3 * RATE))
        os.utime(path, ns=(aged, aged))
        return result

    monkeypatch.setattr(audio_audit, "decode_once", rewrite_after)
    with batch_scope():
        TrackRmsCache.from_recording(path, sample_rate=RATE)
        assert load_mono_full(path, sample_rate=RATE).size == 3 * RATE


def test_the_batch_decode_is_seeded_at_the_rate_it_was_made(
    minimal_project, raw_decodes: list[int]
) -> None:
    project, path = _host_project(minimal_project)
    audio_cache.track_level_profile(project, "host", sample_rate=16000)

    with batch_scope():
        cache = TrackRmsCache.from_recording(path, sample_rate=16000)
        assert load_mono_full(path, sample_rate=16000) is cache.samples
        assert load_mono_full(path, sample_rate=RATE).size != cache.samples.size


def test_a_same_size_rewrite_with_a_new_mtime_is_not_seeded_into_the_batch(
    minimal_project, raw_decodes: list[int], monkeypatch: pytest.MonkeyPatch
) -> None:
    _, path = _host_project(minimal_project)
    real_once = audio_audit.decode_once
    old: list = []

    def rewrite_after(*args, **kwargs):  # type: ignore[no-untyped-def]
        result = real_once(*args, **kwargs)
        old.append(result.samples)
        data = bytearray(path.read_bytes())
        data[-400:] = bytes(255 - b for b in data[-400:])
        path.write_bytes(bytes(data))
        return result

    monkeypatch.setattr(audio_audit, "decode_once", rewrite_after)
    with batch_scope():
        TrackRmsCache.from_recording(path, sample_rate=RATE)
        assert not (load_mono_full(path, sample_rate=RATE) == old[0]).all()


def test_an_atomic_replacement_with_the_same_size_and_mtime_is_not_seeded_into_the_batch(
    minimal_project, raw_decodes: list[int], monkeypatch: pytest.MonkeyPatch
) -> None:
    project, path = _host_project(minimal_project)
    audio_cache.track_level_profile(project, "host", sample_rate=RATE)
    aged = path.stat().st_mtime_ns
    real_once = audio_audit.decode_once
    old: list = []

    def replace_after(*args, **kwargs):  # type: ignore[no-untyped-def]
        result = real_once(*args, **kwargs)
        old.append(result.samples)
        data = bytearray(path.read_bytes())
        data[-400:] = bytes(255 - b for b in data[-400:])
        staged = path.with_name("staged.wav")
        staged.write_bytes(bytes(data))
        os.utime(staged, ns=(aged, aged))
        os.replace(staged, path)
        return result

    monkeypatch.setattr(audio_audit, "decode_once", replace_after)
    with batch_scope():
        TrackRmsCache.from_recording(path, sample_rate=RATE)
        assert not (load_mono_full(path, sample_rate=RATE) == old[0]).all()
