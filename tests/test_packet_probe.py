"""Packet probe resource, uncertainty, and revision contracts."""

from __future__ import annotations

import io
import json
import os
import sys
from types import SimpleNamespace

import pytest

from podcast_mcp.engines import ffmpeg as module
from podcast_mcp.engines.ffmpeg import AudioProbe, FFmpegEngine
from podcast_mcp.util.coded_error import CodedValueError


class PacketChild:
    def __init__(self, output=b"0,1\n1,1\n", *, returncode=0):
        self.stdout = io.BytesIO(output)
        self.returncode = None
        self.exit_code = returncode
        self.killed = False
        self.reaped = False

    def kill(self):
        self.killed = True
        self.returncode = -9

    def poll(self):
        return self.returncode

    def wait(self):
        self.reaped = True
        if self.returncode is None:
            self.returncode = self.exit_code
        return self.returncode


@pytest.fixture
def packet_probe(tmp_path, monkeypatch):
    path = tmp_path / "audio.mkv"
    path.write_bytes(b"media revision")
    metadata = {
        "format": {"duration": "5", "format_name": "matroska"},
        "streams": [{"codec_type": "audio", "sample_rate": "48000", "channels": 1}],
    }
    monkeypatch.setattr(
        module,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(stdout=json.dumps(metadata), stderr=""),
    )
    return FFmpegEngine(), path, metadata


def test_packet_reader_keeps_each_read_bounded(packet_probe, monkeypatch):
    class ManyPackets(io.BytesIO):
        def __init__(self):
            super().__init__()
            self.index = 0

        def readline(self, limit=-1):
            assert 0 < limit <= 4096
            if self.index == 50_000:
                return b""
            self.index += 1
            return f"{self.index - 1},1\n".encode()

        def read(self, *_args):
            pytest.fail("Packet output must not be read in aggregate")

    child = PacketChild()
    child.stdout = ManyPackets()
    monkeypatch.setattr(module, "popen", lambda *_args, **_kwargs: child)
    engine, path, _ = packet_probe
    assert engine.probe(path).require_duration_sec() == 50_000
    assert child.stdout.closed and child.reaped


@pytest.mark.parametrize(
    "packets",
    [b"0,1\n0,1\n", b"1,1\n0,1\n", b"0,-1\n", b"1e308,1e308\n", b"x" * 4096],
)
def test_incomplete_or_invalid_packet_scan_never_publishes_a_prefix(
    packet_probe, monkeypatch, packets
):
    engine, path, _ = packet_probe
    child = PacketChild(packets)
    monkeypatch.setattr(module, "popen", lambda *_args, **_kwargs: child)
    info = engine.probe(path)
    assert info.duration_estimated
    with pytest.raises(CodedValueError):
        info.require_duration_sec()
    assert child.killed and child.reaped and child.stdout.closed


@pytest.mark.parametrize("exit_code", [1, 0])
def test_scan_failure_retries_and_complete_scan_reuses_result(packet_probe, monkeypatch, exit_code):
    engine, path, _ = packet_probe
    children = []

    def spawn(*_args, **_kwargs):
        child = PacketChild(returncode=exit_code if not children else 0)
        children.append(child)
        return child

    monkeypatch.setattr(module, "popen", spawn)
    first = engine.probe(path)
    assert first.duration_estimated is bool(exit_code)
    assert engine.probe(path).require_duration_sec() == 2
    assert engine.probe(path).require_duration_sec() == 2
    assert len(children) == (2 if exit_code else 1)
    assert all(child.reaped and child.stdout.closed for child in children)


def test_scan_cache_partitions_trust_media_and_binary_revisions(
    packet_probe, monkeypatch, tmp_path
):
    engine, path, _ = packet_probe
    commands = []

    def spawn(cmd, **kwargs):
        commands.append(cmd)
        assert kwargs == {"stdout": module.PIPE, "stderr": module.DEVNULL}
        return PacketChild()

    monkeypatch.setattr(module, "popen", spawn)
    for _ in range(2):
        assert engine.probe(path).require_duration_sec() == 2
    assert len(commands) == 1
    assert engine.probe(path, untrusted=True).require_duration_sec() == 2
    assert len(commands) == 2
    assert commands[1][-3:] == ["-protocol_whitelist", "file,crypto,data", str(path)]
    assert "-protocol_whitelist" not in commands[0]
    stamp = path.stat()
    os.utime(path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns + 1))
    assert engine.probe(path).require_duration_sec() == 2
    assert len(commands) == 3
    binary = tmp_path / "other-ffprobe"
    binary.write_bytes(b"mock executable revision")
    engine.ffprobe = str(binary)
    assert engine.probe(path).require_duration_sec() == 2
    assert len(commands) == 4
    binary.write_bytes(b"changed mock executable revision")
    assert engine.probe(path).require_duration_sec() == 2
    assert len(commands) == 5


@pytest.mark.parametrize("changed_file", ["media", "binary"])
def test_file_changed_during_scan_does_not_cache_old_extent(
    packet_probe, monkeypatch, tmp_path, changed_file
):
    engine, path, _ = packet_probe
    binary = tmp_path / "ffprobe-revision"
    binary.write_bytes(b"mock executable")
    engine.ffprobe = str(binary)
    changed = path if changed_file == "media" else binary
    calls = 0

    def spawn(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            changed.write_bytes(b"replacement revision")
        return PacketChild()

    monkeypatch.setattr(module, "popen", spawn)
    assert engine.probe(path).duration_estimated
    assert engine.probe(path).require_duration_sec() == 2
    assert engine.probe(path).require_duration_sec() == 2
    assert calls == 2


def test_timer_start_failure_still_kills_and_reaps_child(packet_probe, monkeypatch):
    engine, path, _ = packet_probe
    child = PacketChild()

    class BrokenTimer:
        def __init__(self, *_args):
            self.daemon = False

        def start(self):
            raise RuntimeError("thread resource unavailable")

        def cancel(self):
            pass

    monkeypatch.setattr(module, "popen", lambda *_args, **_kwargs: child)
    monkeypatch.setattr(module.threading, "Timer", BrokenTimer)
    with pytest.raises(RuntimeError, match="thread resource unavailable"):
        engine.probe(path)
    assert child.killed and child.reaped and child.stdout.closed


@pytest.mark.parametrize(
    "script",
    [
        "import threading; threading.Event().wait()",
        "import os, threading; os.close(1); threading.Event().wait()",
        "import os\ni = 0\nwhile True:\n os.write(1, f'{i / 1000000},0.000001\\n'.encode()); i += 1",
    ],
)
def test_packet_deadline_kills_and_reaps_stalled_or_busy_child(packet_probe, monkeypatch, script):
    engine, path, _ = packet_probe
    children = []
    real_popen = module.popen

    def spawn(_cmd, **kwargs):
        child = real_popen([sys.executable, "-c", script], **kwargs)
        children.append(child)
        return child

    monkeypatch.setattr(module, "popen", spawn)
    monkeypatch.setattr(module, "_PACKET_SCAN_TIMEOUT_SEC", 0.2)
    assert engine.probe(path).duration_estimated
    assert len(children) == 1
    assert children[0].returncode is not None
    assert children[0].stdout.closed


@pytest.mark.parametrize("duration", [0, -1, float("nan"), float("inf")])
def test_writer_duration_gate_rejects_invalid_extent(duration):
    with pytest.raises(CodedValueError):
        AudioProbe(duration, 48000, 1).require_duration_sec()


@pytest.mark.parametrize("declaration", ["nan", "inf", "-inf"])
def test_nonfinite_declarations_require_a_scan(packet_probe, monkeypatch, declaration):
    engine, path, metadata = packet_probe
    metadata["streams"][0]["duration"] = declaration
    monkeypatch.setattr(module, "popen", lambda *_args, **_kwargs: PacketChild())
    info = engine.probe(path)
    assert info.require_duration_sec() == 2
    assert info.audio_duration_sec is None


def test_video_matroska_scan_retains_declared_pcm_shortfall_check(packet_probe, monkeypatch):
    engine, path, metadata = packet_probe
    metadata["streams"][0]["duration"] = "4"
    metadata["streams"].append({"codec_type": "video"})
    real_popen = module.popen

    def spawn(cmd, **kwargs):
        if "packet=pts_time,duration_time" in cmd:
            return PacketChild(b"0,2\n2,2\n")
        script = "import os; os.write(2, b'out_time_us=1000000\\nprogress=end\\n')"
        return real_popen([sys.executable, "-c", script], **kwargs)

    monkeypatch.setattr(module, "popen", spawn)
    assert engine.probe(path).audio_duration_sec == 4
    with pytest.raises(RuntimeError, match="ended short"):
        list(engine.stream_pcm_f32(path)[2])
