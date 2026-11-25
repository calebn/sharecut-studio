"""``test_ffmpeg_engine.py`` run again on an ``in_process`` host row with a fake backend.

The guard in ``tests/ffmpeg_in_process_guard.py`` fails skipped cases. Shared cases run
with sentinel argv and cannot spawn a subprocess. Source cases
marked ``desktop_ffmpeg`` keep exercising real media or binary selection in the desktop
suite. The fake backend also covers stream and cache behavior specific to this row.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from dataclasses import replace
from functools import partial
from pathlib import Path

import numpy as np
import pytest

import test_ffmpeg_engine as desktop
from ffmpeg_in_process_support import FakeBackend, shared_ffmpeg_tests
from podcast_mcp.engines import ffmpeg as module
from podcast_mcp.engines.ffmpeg import probe as probe_module
from podcast_mcp.util import process
from podcast_mcp.util.host_platform import IOS

pytest_plugins = ("ffmpeg_in_process_guard",)


@pytest.fixture
def sample_wav():
    pytest.fail("Use a local fake path for shared tests or classify real media as desktop-only")


@pytest.fixture(autouse=True)
def in_process_row(host, monkeypatch):
    monkeypatch.setattr(subprocess, "Popen", lambda *_a, **_k: pytest.fail("Spawned a subprocess"))
    host(replace(IOS, media_tools="in_process"))
    with process.using_in_process_backend(FakeBackend()):
        yield


globals().update(shared_ffmpeg_tests(vars(desktop)))


def test_replay_includes_default_and_opted_in_test_functions():
    def ordinary():
        pass

    def explicit():
        pass

    explicit.__test__ = True
    assert shared_ffmpeg_tests({"testOrdinary": ordinary, "helper": explicit}) == {
        "testOrdinary": ordinary,
        "helper": explicit,
    }


def test_replay_refuses_pytest_and_unittest_test_classes():
    class TestCoverageProbe:
        def test_needs_media(self, sample_wav):
            assert sample_wav.is_file()

    class CoverageProbe(unittest.TestCase):
        def test_probe(self):
            self.assertTrue(True)

    cases = {"TestCoverageProbe": TestCoverageProbe, "CoverageProbe": CoverageProbe}
    for name, case in cases.items():
        with pytest.raises(TypeError, match=f"{name} must be a module-level function"):
            shared_ffmpeg_tests({name: case})
        for opt_out in (False, None, 0):
            case.__test__ = opt_out
            assert shared_ffmpeg_tests({name: case}) == {}

    assert shared_ffmpeg_tests({"TestCase": unittest.TestCase}) == {}


@pytest.mark.parametrize("wrap", [classmethod, staticmethod, partial])
def test_replay_refuses_non_function_wrappers(wrap):
    def probe():
        pass

    with pytest.raises(TypeError, match="testWrappedProbe must be a module-level function"):
        shared_ffmpeg_tests({"testWrappedProbe": wrap(probe)})


class MediaBackend(FakeBackend):
    """Answers ffprobe's metadata and packet scan and ffmpeg's decode; ``route_progress`` sends ``-progress pipe:2`` to stderr."""

    def __init__(
        self, metadata: dict, *, route_progress: bool = True, scan: bytes = b"0,2\n2,2\n"
    ) -> None:
        super().__init__()
        self.scan = scan
        self.metadata = metadata
        self.route_progress = route_progress

    def run(self, argv, streams, cancel):
        self.calls.append(argv)
        if argv[0] == process.IN_PROCESS_FFPROBE:
            scan = "packet=pts_time,duration_time" in argv
            streams.stdout.write(self.scan if scan else json.dumps(self.metadata).encode())
        else:
            streams.stdout.write(np.zeros(48000, np.float32).tobytes())
            if self.route_progress and argv[1:3] == ["-progress", "pipe:2"]:
                streams.stderr.write(b"out_time_us=1000000\nprogress=end\n")
        return 0


@pytest.fixture
def sentinel_media(tmp_path, monkeypatch):
    path = tmp_path / "audio.mkv"
    path.write_bytes(b"media revision")
    metadata = {
        "format": {"duration": "5", "format_name": "matroska"},
        "streams": [
            {"codec_type": "audio", "sample_rate": "48000", "channels": 1, "duration": "4"},
            {"codec_type": "video"},
        ],
    }
    real_stat = Path.stat

    def stat(self, *args, **kwargs):
        if "in-process:" in str(self):
            pytest.fail(f"stat of the sentinel {self}")
        return real_stat(self, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", stat)
    monkeypatch.setattr(shutil, "which", lambda *_a, **_k: pytest.fail("which"))
    probe_module._cached_audio_extent.cache_clear()

    def install(backend):
        monkeypatch.setattr(process._in_process_backend, "run", backend.run)

    return path, metadata, install


def test_in_process_video_matroska_keeps_the_pcm_shortfall_check(sentinel_media):
    path, metadata, install = sentinel_media
    backend = MediaBackend(metadata)
    engine = module.FFmpegEngine()
    install(backend)
    assert engine.probe(path).audio_duration_sec == 4
    with pytest.raises(RuntimeError, match="ended short"):
        list(engine.stream_pcm_f32(path)[2])


def test_in_process_progress_is_argv_pipe2_and_an_unrouted_progress_fails_closed(sentinel_media):
    path, metadata, install = sentinel_media
    engine = module.FFmpegEngine()
    routed = MediaBackend(metadata)
    install(routed)
    with pytest.raises(RuntimeError, match="ended short"):
        list(engine.stream_pcm_f32(path)[2])
    decode = routed.calls[-1]
    assert decode[:3] == [process.IN_PROCESS_FFMPEG, "-progress", "pipe:2"]
    install(MediaBackend(metadata, route_progress=False))
    with pytest.raises(RuntimeError, match="no final timestamp"):
        list(engine.stream_pcm_f32(path)[2])


def test_in_process_extent_is_not_cached_across_backend_installs(sentinel_media):
    path, metadata, install = sentinel_media
    engine = module.FFmpegEngine()
    install(MediaBackend(metadata, scan=b"0,2\n2,2\n"))
    assert engine.probe(path).duration_sec == 4
    install(MediaBackend(metadata, scan=b"0,1\n"))
    assert engine.probe(path).duration_sec == 1
