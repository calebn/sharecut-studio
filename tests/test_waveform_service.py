from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

from podcast_mcp.engines import waveform_media as wm
from podcast_mcp.engines import waveform_pyramid as wm_pyramid
from podcast_mcp.engines.waveform_pyramid import (
    pyramid_path,
    read_bins,
    read_meta,
    read_pcm_minmax,
    ref_slug,
    wait_pyramid_jobs,
)
from podcast_mcp.models import MediaAsset, Track, load_project, save_project
from podcast_mcp.services import waveform as svc
from podcast_mcp.services.waveform import (
    MediaEntry,
    StaleWaveformKeyError,
    current_key,
    ensure_track_waveforms,
    gc_pyramids,
    media_index,
    parse_ref,
    pcm_block,
    schedule_stem_waveforms,
    schedule_track_waveforms,
    tile_bytes,
    waveform_status,
)
from waveform_helpers import SR, reset_waveform_caches, waveform_project, write_wav


@pytest.fixture(autouse=True)
def _fresh_caches():
    reset_waveform_caches()
    yield
    wait_pyramid_jobs()


# --- Refs -----------------------------------------------------------------------------


def test_parse_ref_grammar():
    assert parse_ref("track:host") == ("track", "host")
    assert parse_ref("source:a:b") == ("source", "a:b")
    assert parse_ref("stem:t1") == ("stem", "t1")
    for bad in ("host", "track:", "clip:x", "", "TRACK:x"):
        with pytest.raises(ValueError):
            parse_ref(bad)


def test_media_index_lists_raw_refs(tmp_path):
    project_path = waveform_project(tmp_path)
    index = media_index(project_path)
    assert index.artifacts_dir == project_path.parent.resolve() / "artifacts"
    assert set(index.refs) == {"track:host", "track:guest", "source:s_host"}
    assert index.unavailable == {"track:gone": "no-media", "source:ghost": "no-media"}
    host, pinned = index.refs["track:host"], index.refs["source:s_host"]
    assert host.rel_path == pinned.rel_path == "raw/host.wav"
    assert current_key(host) == current_key(pinned)  # cross-lane pin shares the pyramid
    artifacts = project_path.parent.resolve() / "artifacts"
    assert wm.pyramid_target(artifacts, "track:host", host).key == current_key(host)


def test_media_index_stems_fresh_only_and_unsafe_ids(tmp_path):
    project_path = waveform_project(tmp_path)
    project = load_project(project_path)
    project.timeline.tracks.append(
        Track(id="bad id", label="Bad", media=MediaAsset(path="raw/guest.wav"))
    )
    save_project(project)
    stems = project_path.parent / "artifacts" / "tracks"
    write_wav(stems / "host.wav", 640)
    write_wav(stems / "guest.wav", 640)
    with patch.object(wm, "stem_is_fresh", lambda _p, tid: tid in {"host", "gone"}):
        index = media_index(project_path)
    assert index.refs["stem:host"].kind == "stem"
    assert index.refs["stem:host"].rel_path == "artifacts/tracks/host.wav"
    assert "stem:guest" not in index.refs  # stale stem excluded
    assert "stem:gone" not in index.refs  # fresh but no file
    assert index.unavailable["stem:bad id"] == "unsafe-id"
    assert "track:bad id" in index.refs
    assert ref_slug("track", "bad id").startswith("track-h")


def test_media_index_cache_hits_and_revision_race(tmp_path, monkeypatch):
    project_path = waveform_project(tmp_path)
    real_open = svc.open_project
    calls: list[int] = []

    def counting(path):
        calls.append(1)
        return real_open(path)

    monkeypatch.setattr(svc, "open_project", counting)
    first = media_index(project_path)
    assert media_index(project_path) is first
    assert len(calls) == 1

    def racing(path):
        calls.append(1)
        result = real_open(path)
        os.utime(path, ns=(time.time_ns(), time.time_ns() + 5_000_000))
        return result

    monkeypatch.setattr(svc, "open_project", racing)
    save_project(load_project(project_path))  # new revision -> miss
    media_index(project_path)
    monkeypatch.setattr(svc, "open_project", counting)
    media_index(project_path)
    assert len(calls) == 3  # the racing parse was not cached


def test_media_index_reparses_after_stem_render_and_evicts(tmp_path, monkeypatch):
    project_path = waveform_project(tmp_path)
    first = media_index(project_path)
    write_wav(project_path.parent / "artifacts" / "tracks" / "host.wav", 640)
    assert media_index(project_path) is not first  # stems folder changed
    monkeypatch.setattr(svc, "_INDEX_MAX", 1)
    other = waveform_project(tmp_path / "other")
    media_index(other)
    assert len(svc._INDEX) == 1


def test_keys_change_with_size_and_mtime(tmp_path):
    project_path = waveform_project(tmp_path)
    entry = media_index(project_path).refs["track:host"]
    key = current_key(entry)
    st = entry.abs_path.stat()
    os.utime(entry.abs_path, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
    touched = current_key(entry)
    assert touched != key
    with entry.abs_path.open("ab") as fh:
        fh.write(b"\0\0")
    os.utime(entry.abs_path, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
    assert current_key(entry) not in {key, touched}


# --- Status ---------------------------------------------------------------------------


def test_status_generating_then_ready_and_links_shared_media(tmp_path):
    project_path = waveform_project(tmp_path)
    status = waveform_status(project_path, "raw")
    assert status["format_version"] == 1
    media = status["media"]
    assert media["track:host"] == {"status": "generating"}
    assert media["source:s_host"] == {"status": "generating"}
    assert media["track:gone"] == {"status": "unavailable", "reason": "no-media"}
    assert media["source:ghost"] == {"status": "unavailable", "reason": "no-media"}
    wait_pyramid_jobs()
    ready = waveform_status(project_path, "raw")["media"]
    host = ready["track:host"]
    assert host["status"] == "ready"
    assert host["sample_rate"] == SR
    assert host["channels"] == 1
    assert host["total_frames"] == 64 * 300
    assert host["base_spp"] == 64
    assert host["level_factor"] == 4
    assert host["bins_per_tile"] == 4096
    assert host["levels"] == [{"spp": 64, "bins": 300}]
    assert ready["source:s_host"]["key"] == host["key"]
    peaks = project_path.parent / "artifacts" / "peaks"
    a = pyramid_path(peaks, "track-host", host["key"])
    b = pyramid_path(peaks, "source-s_host", host["key"])
    assert a.stat().st_size == b.stat().st_size
    assert a.read_bytes() == b.read_bytes()


def test_status_pending_then_failed(tmp_path):
    project_path = waveform_project(tmp_path, frames=64 * 301)
    release = threading.Event()
    real_decode = wm_pyramid.decode_media

    def blocked(path, **kw):
        if path.name != "guest.wav":
            return real_decode(path, **kw)
        release.wait(timeout=5)
        raise RuntimeError("decode boom")

    with patch.object(wm_pyramid, "decode_media", side_effect=blocked):
        first = waveform_status(project_path, "raw")["media"]["track:guest"]
        assert first == {"status": "generating"}
        again = waveform_status(project_path, "raw")["media"]["track:guest"]
        assert again == {"status": "generating"}  # pending, not rescheduled
        release.set()
        wait_pyramid_jobs()
    failed = waveform_status(project_path, "raw")["media"]["track:guest"]
    assert failed == {"status": "unavailable", "reason": "decode-failed"}


def test_status_drops_and_rebuilds_corrupt_pyramid(tmp_path):
    project_path = waveform_project(tmp_path, frames=64 * 302)
    entry = media_index(project_path).refs["track:host"]
    peaks = project_path.parent / "artifacts" / "peaks"
    out = pyramid_path(peaks, "track-host", current_key(entry))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(b"garbage")
    assert waveform_status(project_path, "raw")["media"]["track:host"] == {"status": "generating"}
    wait_pyramid_jobs()
    assert read_meta(out).total_frames == 64 * 302


def test_status_schedule_refused_and_vanished_media(tmp_path):
    project_path = waveform_project(tmp_path)
    with patch.object(svc, "schedule_pyramid_build", return_value=False):
        media = waveform_status(project_path, "raw")["media"]
    assert media["track:host"] == {"status": "unavailable", "reason": "decode-failed"}
    (project_path.parent / "raw" / "guest.wav").unlink()  # after the index was cached
    media = waveform_status(project_path, "raw")["media"]
    assert media["track:guest"] == {"status": "unavailable", "reason": "no-media"}


def test_status_stem_kind(tmp_path):
    project_path = waveform_project(tmp_path)
    write_wav(project_path.parent / "artifacts" / "tracks" / "host.wav", 640)
    with patch.object(wm, "stem_is_fresh", lambda _p, tid: tid == "host"):
        media = waveform_status(project_path, "stem")["media"]
    assert media == {"stem:host": {"status": "generating"}}


# --- Tiles and PCM --------------------------------------------------------------------


def _ready(project_path: Path, ref: str = "track:host") -> tuple[str, Path]:
    waveform_status(project_path, "raw")
    wait_pyramid_jobs()
    key = waveform_status(project_path, "raw")["media"][ref]["key"]
    kind, ref_id = parse_ref(ref)
    return key, pyramid_path(
        project_path.parent / "artifacts" / "peaks", ref_slug(kind, ref_id), key
    )


def test_tile_bytes_match_read_bins_without_parsing(tmp_path, monkeypatch):
    project_path = waveform_project(tmp_path)
    key, path = _ready(project_path)
    monkeypatch.setattr(svc, "open_project", lambda _p: pytest.fail("tiles must not parse"))
    meta = read_meta(path)
    body = tile_bytes(project_path, "track:host", key, 0, 0, 16)
    assert body == read_bins(path, meta, 0, 0, 16 * 4096)
    assert len(body) == 300 * 6
    assert all(isinstance(k, tuple) and k[0].endswith(".wfpk") for k in svc._META)


@pytest.mark.parametrize(
    ("ref", "key", "level", "start", "count", "exc"),
    [
        ("track:host", "NOTAKEY", 0, 0, 1, ValueError),
        ("bogus", None, 0, 0, 1, ValueError),
        ("track:host", None, 1, 0, 1, ValueError),
        ("track:host", None, 0, 0, 0, ValueError),
        ("track:host", None, 0, 0, 17, ValueError),
        ("track:host", None, 0, -1, 1, ValueError),
        ("track:host", None, 0, 1, 1, ValueError),
        ("track:guest", None, 0, 0, 1, LookupError),
        ("track:host", "0" * 20, 0, 0, 1, LookupError),
    ],
)
def test_tile_bytes_rejects_bad_input(tmp_path, ref, key, level, start, count, exc):
    project_path = waveform_project(tmp_path)
    live, _ = _ready(project_path)
    if ref == "track:guest":
        for p in (project_path.parent / "artifacts" / "peaks").glob("track-guest.*"):
            p.unlink()
    with pytest.raises(exc):
        tile_bytes(project_path, ref, key or live, level, start, count)


def test_pcm_block_bounds_and_stale_key(tmp_path, monkeypatch):
    monkeypatch.setattr(svc, "pcm_block_frames", lambda: 256)
    project_path = waveform_project(tmp_path)
    key, _ = _ready(project_path)
    audio = project_path.parent / "raw" / "host.wav"
    first = pcm_block(project_path, "track:host", key, 0)
    np.testing.assert_array_equal(
        np.frombuffer(first, "<i2").reshape(-1, 2), read_pcm_minmax(audio, 0, 256)
    )
    last = pcm_block(project_path, "track:host", key, 74)  # 19200 frames = 75 blocks
    assert len(last) == 256 * 4
    for block in (-1, 75):
        with pytest.raises(ValueError):
            pcm_block(project_path, "track:host", key, block)
    with pytest.raises(StaleWaveformKeyError):
        pcm_block(project_path, "track:host", "0" * 20, 0)
    with pytest.raises(LookupError):
        pcm_block(project_path, "track:nope", key, 0)
    with pytest.raises(ValueError):
        pcm_block(project_path, "nope", key, 0)


# --- Hooks ----------------------------------------------------------------------------


def test_schedule_track_waveforms_covers_lane_sources(tmp_path):
    project_path = waveform_project(tmp_path)
    project = load_project(project_path)
    guest = project.track_by_id("guest")
    assert guest is not None
    assert schedule_track_waveforms(project, guest) == 2  # track:guest + source:s_host
    wait_pyramid_jobs()
    peaks = project.artifacts_dir() / "peaks"
    assert sorted(p.name.split(".")[0] for p in peaks.glob("*.wfpk")) == [
        "source-s_host",
        "track-guest",
    ]
    assert schedule_track_waveforms(project, guest) == 2  # already on disk
    gone = project.track_by_id("gone")
    assert gone is not None
    assert schedule_track_waveforms(project, gone) == 0


def test_schedule_media_ref_missing_file_is_false(tmp_path):
    entry = wm.MediaEntry(kind="raw", abs_path=tmp_path / "missing.wav", rel_path="missing.wav")
    assert wm.schedule_media_ref(tmp_path, "track:x", entry) is False


def test_schedule_stem_waveforms(tmp_path):
    project_path = waveform_project(tmp_path)
    project = load_project(project_path)
    write_wav(project.artifacts_dir() / "tracks" / "host.wav", 640)
    assert schedule_stem_waveforms(project, ["host", "guest", "../evil"]) == 1
    wait_pyramid_jobs()
    assert [p.name.split(".")[0] for p in (project.artifacts_dir() / "peaks").glob("*.wfpk")] == [
        "stem-host"
    ]


def test_ensure_track_waveforms_builds_inline(tmp_path):
    project_path = waveform_project(tmp_path)
    project = load_project(project_path)
    host = project.track_by_id("host")
    assert host is not None
    assert ensure_track_waveforms(project, host) == 1
    assert list((project.artifacts_dir() / "peaks").glob("track-host.*.wfpk"))
    with patch.object(wm, "build_pyramid") as build:
        assert ensure_track_waveforms(project, host) == 1  # already there
    build.assert_not_called()
    guest = project.track_by_id("guest")
    assert guest is not None
    with patch.object(wm, "build_pyramid", side_effect=RuntimeError("boom")):
        assert ensure_track_waveforms(project, guest) == 0  # both guest-lane builds fail
    assert not list((project.artifacts_dir() / "peaks").glob("track-guest.*.wfpk"))


# --- GC -------------------------------------------------------------------------------


def test_gc_pyramids_drops_week_old_orphans_once(tmp_path):
    project_path = waveform_project(tmp_path)
    peaks = project_path.parent / "artifacts" / "peaks"
    peaks.mkdir(parents=True)
    old = time.time() - 8 * 86_400
    names = {
        "orphan_old": "track-deleted.0123456789abcdef0123.wfpk",
        "orphan_new": "track-deleted2.0123456789abcdef0123.wfpk",
        "live_old": "track-host.0123456789abcdef0123.wfpk",
        "odd": "not-a-pyramid.wfpk",
    }
    for label, name in names.items():
        path = peaks / name
        path.write_bytes(b"x")
        if label != "orphan_new":
            os.utime(path, (old, old))
    assert gc_pyramids(project_path) == 1
    assert not (peaks / names["orphan_old"]).exists()
    assert all((peaks / names[k]).exists() for k in ("orphan_new", "live_old", "odd"))
    (peaks / names["orphan_new"]).touch()
    os.utime(peaks / names["orphan_new"], (old, old))
    assert gc_pyramids(project_path) == 0  # once per process per project


def test_episode_service_hooks_schedule_waveforms(minimal_project, sample_wav, tmp_path):
    from podcast_mcp.services.episode import EpisodeService
    from podcast_mcp.services.workspace import ProjectWorkspace

    ws = ProjectWorkspace.open(minimal_project)
    EpisodeService(ws).add_track("host2", str(sample_wav), speaker="Host")
    wait_pyramid_jobs()
    peaks = ws.project.artifacts_dir() / "peaks"
    assert len(list(peaks.glob("track-host2.*.wfpk"))) == 1
    other = write_wav(tmp_path / "other.wav", 64 * 50, seed=7)
    EpisodeService(ws).set_track_media("host2", str(other))
    wait_pyramid_jobs()
    assert len(list(peaks.glob("track-host2.*.wfpk"))) == 2  # live + previous key


def test_stem_symlinked_outside_workspace_is_skipped(tmp_path):
    project_path = waveform_project(tmp_path)
    project = load_project(project_path)
    outside = write_wav(tmp_path / "outside.wav", 640)
    stems = project.artifacts_dir() / "tracks"
    stems.mkdir(parents=True)
    (stems / "host.wav").symlink_to(outside)
    assert schedule_stem_waveforms(project, ["host"]) == 0


def test_meta_cache_is_bounded(tmp_path, monkeypatch):
    monkeypatch.setattr(svc, "_META_MAX", 1)
    project_path = waveform_project(tmp_path)
    waveform_status(project_path, "raw")
    wait_pyramid_jobs()
    media = waveform_status(project_path, "raw")["media"]
    assert media["track:host"]["status"] == media["track:guest"]["status"] == "ready"
    assert len(svc._META) == 1


def test_live_key_maps_missing_media_to_lookup_error(tmp_path):
    entry = MediaEntry(kind="raw", abs_path=tmp_path / "nope.wav", rel_path="nope.wav")
    with pytest.raises(LookupError):
        svc.live_key(entry)


def test_pcm_block_decode_failure_is_lookup_error(tmp_path, monkeypatch):
    monkeypatch.setattr(svc, "pcm_block_frames", lambda: 256)
    project_path = waveform_project(tmp_path)
    key, _ = _ready(project_path)

    def boom(*_a, **_k):
        raise RuntimeError("ffmpeg failed")

    monkeypatch.setattr(svc, "read_pcm_minmax", boom)
    with pytest.raises(svc.WaveformDecodeError):
        pcm_block(project_path, "track:host", key, 0)


def test_pcm_block_stale_when_media_changes_mid_read(tmp_path, monkeypatch):
    monkeypatch.setattr(svc, "pcm_block_frames", lambda: 256)
    project_path = waveform_project(tmp_path)
    key, _ = _ready(project_path)
    audio = project_path.parent / "raw" / "host.wav"
    real = svc.read_pcm_minmax

    def swapping(*a, **k):
        out = real(*a, **k)
        st = audio.stat()
        os.utime(audio, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
        return out

    monkeypatch.setattr(svc, "read_pcm_minmax", swapping)
    with pytest.raises(StaleWaveformKeyError):
        pcm_block(project_path, "track:host", key, 0)


def test_media_index_sees_media_that_appears_later(tmp_path):
    project_path = waveform_project(tmp_path)
    assert media_index(project_path).unavailable["track:gone"] == "no-media"
    write_wav(project_path.parent / "raw" / "missing.wav", 640)
    assert "track:gone" in media_index(project_path).refs


def test_media_index_sees_stem_hash_rewritten_in_place(tmp_path):
    project_path = waveform_project(tmp_path)
    stems = project_path.parent / "artifacts" / "tracks"
    write_wav(stems / "host.wav", 640)
    (stems / "host.hash").write_text("old")

    def fresh(_p, tid):
        h = stems / f"{tid}.hash"
        return h.read_text() == "new" if h.is_file() else False

    with patch.object(wm, "stem_is_fresh", fresh):
        assert "stem:host" not in media_index(project_path).refs
        st = (stems / "host.hash").stat()
        (stems / "host.hash").write_text("new")
        os.utime(stems / "host.hash", ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
        assert "stem:host" in media_index(project_path).refs


def test_media_index_stem_written_during_parse_is_not_kept(tmp_path, monkeypatch):
    project_path = waveform_project(tmp_path)
    stems = project_path.parent / "artifacts" / "tracks"
    real = svc.collect_media_refs

    def racing(project):
        write_wav(stems / "host.wav", 640)
        return real(project)

    monkeypatch.setattr(svc, "collect_media_refs", racing)
    first = media_index(project_path)
    monkeypatch.setattr(svc, "collect_media_refs", real)
    assert media_index(project_path) is not first


def test_gc_failure_is_retried_and_does_not_break_status(tmp_path, monkeypatch):
    project_path = waveform_project(tmp_path)

    def gone(_p):
        raise FileNotFoundError("x")

    monkeypatch.setattr(svc, "media_index", gone)
    with pytest.raises(FileNotFoundError):
        gc_pyramids(project_path)
    assert str(project_path.resolve()) not in svc._GC_DONE
    monkeypatch.undo()
    assert gc_pyramids(project_path) == 0
    assert str(project_path.resolve()) in svc._GC_DONE


def test_status_survives_gc_error(tmp_path, monkeypatch):
    project_path = waveform_project(tmp_path)

    def boom(*_a, **_k):
        raise RuntimeError("x")

    monkeypatch.setattr(svc, "gc_pyramids", boom)
    assert "track:host" in waveform_status(project_path, "raw")["media"]


def test_source_ref_resolves_like_clip_render(tmp_path):
    from podcast_mcp.engines.timeline_render import resolve_clip_audio_path

    project = load_project(waveform_project(tmp_path))
    clip = next(c for c in project.clips if c.source_id == "s_host")
    track = project.track_by_id(clip.track_id)
    entry = wm.collect_media_refs(project).refs["source:s_host"]
    assert entry.abs_path == resolve_clip_audio_path(project, track, clip)
