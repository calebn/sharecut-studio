from __future__ import annotations

import os
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import numpy as np
import pytest

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
    assert live.exists() or os.name == "nt"
    assert fresh_unowned.exists()
