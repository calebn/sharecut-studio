from __future__ import annotations

import os
import subprocess
import sys
import textwrap
import time
import types
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines import decoded_source
from podcast_mcp.engines.decoded_source import decoded_sources
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.ungated_audio import load_mono_full
from podcast_mcp.util.binaries import resolve_ffmpeg_pair

posix_only = pytest.mark.skipif(os.name == "nt", reason="spools are unlinked once opened on POSIX")


def _tone(path: Path, *, seconds: int = 3, rate: int = 44100) -> Path:
    if not FFmpegEngine().check_available()[0]:
        pytest.skip("ffmpeg not available")
    subprocess.run(
        [
            resolve_ffmpeg_pair().ffmpeg,
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=f=330:r={rate}:d={seconds}",
            str(path),
        ],
        check=True,
    )
    return path


def _spool_files(root: Path) -> list[Path]:
    return [p for p in root.rglob("*") if p.is_file() and p.suffix == ".f32"]


def test_ranges_read_back_the_decode(tmp_path: Path) -> None:
    source = _tone(tmp_path / "tone.wav")
    whole = load_mono_full(source, sample_rate=44100)

    with decoded_sources(44100) as reader:
        spool = reader(source)

        assert spool.size == whole.size
        np.testing.assert_array_equal(spool.read(1000, 5000), whole[1000:5000])
        assert spool.read(7, 7).size == 0
        tail = spool.read(whole.size - 10, whole.size)
        tail[:] = 0
        np.testing.assert_array_equal(spool.read(whole.size - 10, whole.size), whole[-10:])


WORKER = textwrap.dedent(
    """
    import os, signal, sys
    from pathlib import Path
    from podcast_mcp.engines.decoded_source import decoded_sources

    with decoded_sources(44100) as reader:
        reader(Path(sys.argv[1])).read(0, 100)
        if sys.argv[2] == "sigterm":
            os.kill(os.getpid(), signal.SIGTERM)
    """
)


def _run_worker(source: Path, tmp: Path, mode: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", WORKER, str(source), mode],
        env={**os.environ, "TMPDIR": str(tmp)},
        capture_output=True,
        text=True,
        check=False,
    )


@posix_only
def test_a_terminated_process_leaves_no_spool_behind(tmp_path: Path) -> None:
    source = _tone(tmp_path / "tone.wav")
    scratch = tmp_path / "tmp"
    scratch.mkdir()

    result = _run_worker(source, scratch, "sigterm")

    assert result.returncode != 0
    assert _spool_files(scratch) == []


def test_a_new_process_sweeps_spools_whose_owner_is_gone(tmp_path: Path) -> None:
    source = _tone(tmp_path / "tone.wav")
    scratch = tmp_path / "tmp"
    scratch.mkdir()
    dead = subprocess.Popen([sys.executable, "-c", "pass"])
    dead.wait()
    gone = scratch / f"sharecut-decoded-{dead.pid}-abc"
    live = scratch / f"sharecut-decoded-{os.getpid()}-abc"
    old_unowned = scratch / "sharecut-decoded-oldstyle"
    fresh_unowned = scratch / "sharecut-decoded-fresh"
    for directory in (gone, live, old_unowned, fresh_unowned):
        directory.mkdir()
        (directory / "0-1.f32").write_bytes(b"\0" * 64)
    day_ago = time.time() - 86400
    os.utime(old_unowned, (day_ago, day_ago))

    result = _run_worker(source, scratch, "exit")

    assert result.returncode == 0, result.stderr
    assert not gone.exists()
    assert not old_unowned.exists()
    assert live.exists()
    assert fresh_unowned.exists()


def test_a_sweep_on_windows_asks_whether_the_owner_is_alive_not_how_old_the_directory_is(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    dead = subprocess.Popen([sys.executable, "-c", "pass"])
    dead.wait()
    gone = tmp_path / f"sharecut-decoded-{dead.pid}-abc"
    idle = tmp_path / "sharecut-decoded-4242-abc"
    for directory in (gone, idle):
        directory.mkdir()
        (directory / "0-1.f32").write_bytes(b"\0" * 64)
    day_ago = time.time() - 86400
    os.utime(idle, (day_ago, day_ago))
    monkeypatch.setattr(decoded_source.tempfile, "gettempdir", lambda: str(tmp_path))
    monkeypatch.setattr(decoded_source, "pid_is_alive", lambda pid: pid == 4242)
    monkeypatch.setattr(decoded_source, "os", types.SimpleNamespace(**{**vars(os), "name": "nt"}))

    decoded_source._sweep_orphans()

    assert not gone.exists()
    assert idle.exists()


def _fd_count() -> int:
    return len(os.listdir("/dev/fd"))


def _write_tone(path: Path, frequency: float) -> None:
    import wave

    t = np.arange(48000) / 48000
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(48000)
        handle.writeframes(
            (0.3 * np.sin(2 * np.pi * frequency * t) * 32767).astype("<i2").tobytes()
        )


@posix_only
def test_a_spill_reads_back_the_array_bit_for_bit_and_leaves_no_file() -> None:
    array = np.random.default_rng(3).normal(size=100_003).astype(np.float32)
    array[:3] = (-0.0, np.nan, np.inf)

    spilled = decoded_source.spill(array)

    assert type(spilled) is np.ndarray
    assert not spilled.flags.writeable
    assert spilled.shape == array.shape
    np.testing.assert_array_equal(spilled.view(np.uint32), array.view(np.uint32))
    assert _spool_files(decoded_source._spool_directory()) == []


def test_an_empty_array_is_spilled_as_an_empty_read_only_array() -> None:
    spilled = decoded_source.spill(np.empty((0,), dtype=np.float32))

    assert spilled.shape == (0,) and spilled.dtype == np.float32 and not spilled.flags.writeable


@posix_only
def test_a_spill_that_hits_a_full_disk_raises_and_leaves_no_file_or_descriptor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import errno

    real = os.write

    def full(fd: int, data: object) -> int:
        if fd > 2:
            raise OSError(errno.ENOSPC, "No space left on device")
        return real(fd, data)  # type: ignore[arg-type]

    before = _fd_count()
    monkeypatch.setattr(decoded_source.os, "write", full)
    with pytest.raises(OSError):
        decoded_source.spill(np.ones(1000, dtype=np.float32))
    monkeypatch.undo()

    assert _fd_count() == before
    assert _spool_files(decoded_source._spool_directory()) == []


@posix_only
def test_a_short_write_is_finished_before_the_map_is_made(monkeypatch: pytest.MonkeyPatch) -> None:
    real = os.write
    monkeypatch.setattr(
        decoded_source.os,
        "write",
        lambda fd, data: real(fd, bytes(data)[:7]) if fd > 2 else real(fd, data),
    )
    array = np.arange(5000, dtype=np.float32)

    np.testing.assert_array_equal(decoded_source.spill(array), array)


def test_a_temp_directory_on_tmpfs_is_a_memory_filesystem(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mountinfo = tmp_path / "mountinfo"
    mountinfo.write_text(
        "22 1 8:1 / / rw - ext4 /dev/vda rw\n"
        "30 22 0:25 / /tmp rw - tmpfs tmpfs rw\n"
        "31 22 0:26 / /tmpfoo rw - ext4 /dev/vdb rw\n"
        "32 30 0:27 / /tmp/with\\040space rw - ext4 /dev/vdc rw\n"
        "33 22 0:28 / /scratch rw - tmpfs tmpfs rw\n"
        "34 22 0:29 / /scratch rw - ext4 /dev/vdd rw\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(decoded_source, "_MOUNTINFO", mountinfo)

    assert decoded_source._in_memory_filesystem(Path("/tmp/spool"))
    assert not decoded_source._in_memory_filesystem(Path("/tmpfoo/spool"))
    assert not decoded_source._in_memory_filesystem(Path("/tmp/with space/spool"))
    assert not decoded_source._in_memory_filesystem(Path("/home/spool"))
    assert not decoded_source._in_memory_filesystem(Path("/scratch/spool"))
    monkeypatch.setattr(decoded_source, "_MOUNTINFO", tmp_path / "missing")
    assert not decoded_source._in_memory_filesystem(Path("/tmp/spool"))


@posix_only
def test_a_spill_wants_disk_headroom_and_a_disk_backed_directory(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    free = types.SimpleNamespace(free=decoded_source.SPILL_HEADROOM_BYTES + 1000)
    monkeypatch.setattr(decoded_source.shutil, "disk_usage", lambda path: free)
    monkeypatch.setattr(decoded_source, "_in_memory_filesystem", lambda directory: False)

    assert decoded_source.spill_allowed(1000)
    assert not decoded_source.spill_allowed(1001)
    monkeypatch.setattr(decoded_source, "_in_memory_filesystem", lambda directory: True)
    assert not decoded_source.spill_allowed(1)
    monkeypatch.setattr(decoded_source, "_in_memory_filesystem", lambda directory: False)
    monkeypatch.setattr(decoded_source.os, "name", "nt")
    assert not decoded_source.spill_allowed(1)


def test_a_source_overwritten_in_place_with_its_size_and_mtime_is_decoded_again(
    tmp_path: Path,
) -> None:
    source = tmp_path / "tone.wav"
    _write_tone(source, 330)
    stat = source.stat()
    with decoded_sources(48000) as reader:
        before = reader(source).read(0, 4800).copy()

    other = tmp_path / "other.wav"
    _write_tone(other, 660)
    with source.open("r+b") as handle:
        handle.write(other.read_bytes())
    os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    assert source.stat().st_size == stat.st_size and source.stat().st_mtime_ns == stat.st_mtime_ns
    assert source.stat().st_ino == stat.st_ino

    with decoded_sources(48000) as reader:
        after = reader(source).read(0, 4800)

    assert not np.array_equal(before, after)
    np.testing.assert_array_equal(after, load_mono_full(other, sample_rate=48000)[:4800])


def test_a_changed_ffmpeg_build_decodes_an_unchanged_file_again(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "tone.wav"
    _write_tone(source, 330)
    decodes: list[Path] = []
    real = decoded_source._decode

    def counting(path: Path, sample_rate: int, target: Path) -> int:
        decodes.append(path)
        return real(path, sample_rate, target)

    monkeypatch.setattr(decoded_source, "_decode", counting)
    monkeypatch.setattr(decoded_source, "ffmpeg_build_id", lambda: ("build", "A"))
    with decoded_sources(48000) as reader:
        reader(source)
    with decoded_sources(48000) as reader:
        reader(source)
    assert len(decodes) == 1  # the same build is served from the spool

    monkeypatch.setattr(decoded_source, "ffmpeg_build_id", lambda: ("build", "B"))
    with decoded_sources(48000) as reader:
        reader(source)

    assert len(decodes) == 2


@posix_only
def test_a_spill_that_comes_up_a_sample_short_raises_and_leaves_no_file_or_descriptor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    real = os.fstat

    def short(fd: int) -> os.stat_result:
        result = real(fd)
        fields = list(result)
        fields[6] -= 4  # st_size
        return os.stat_result(fields)

    before = _fd_count()
    monkeypatch.setattr(decoded_source.os, "fstat", short)
    with pytest.raises(OSError, match="short write"):
        decoded_source.spill(np.ones(1000, dtype=np.float32))
    monkeypatch.undo()

    assert _fd_count() == before
    assert _spool_files(decoded_source._spool_directory()) == []
