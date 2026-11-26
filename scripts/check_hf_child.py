#!/usr/bin/env python3
"""Check that the Hugging Face download child runs under a given Python (#1998).

Spawns ``<python> -P -m podcast_mcp.util.hf_fetch_child <spec.json>`` against the pinned
``Systran/faster-whisper-tiny.en`` snapshot (``WHISPER_PINS``) in a temporary cache, and
fails unless (1) the child prints one ``{"path": ...}`` line with every pinned file present
and (2) a second child, killed once model.bin has started (the cache holds more than the small files), is gone within a few seconds
with most of ``model.bin`` unwritten. Needs the network (about 78 MB).

    .venv/bin/python scripts/check_hf_child.py
    .venv/bin/python scripts/check_hf_child.py --python <runtime>/venv/bin/python

The second form is the frozen-sidecar check: ``--python`` is the venv interpreter the
launcher execs (``<runtime>/venv/bin/python``, not the ``<runtime>/python`` directory) (see docs/desktop-packaging.md, "Download child"); pass the launcher's
``PYTHONHOME`` as ``--python-home`` when the interpreter needs it. It exits non-zero on any failure.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from podcast_mcp.engines.models.whisper import WHISPER_PINS
from podcast_mcp.util import process
from podcast_mcp.util.model_manifest import PinnedSnapshot

MIB = 1024 * 1024
MODEL_BYTES = 78_090_594
KILL_WITHIN_SEC = 3.0
KILL_AT_BYTES = 8 * MIB
"""Past the ~2.5 MB of small files, so the kill lands while model.bin is transferring."""
UNWRITTEN_AT_KILL = 0.25
RUN_TIMEOUT_SEC = 300.0
STEP_SEC = 0.05


class CheckError(RuntimeError):
    pass


def _spec(pin: PinnedSnapshot, cache_dir: Path, spec_dir: Path) -> Path:
    path = spec_dir / "spec.json"
    path.write_text(
        json.dumps(
            {
                "repo": pin.hf_repo,
                "revision": pin.revision,
                "allow_patterns": pin.allow_patterns,
                "cache_dir": str(cache_dir),
                "force_download": False,
            }
        )
    )
    return path


def _start(python: str, spec: Path, log: Path, env: dict[str, str]) -> process.Popen[bytes]:
    with log.open("wb") as err:
        return process.popen(
            [python, "-P", "-m", "podcast_mcp.util.hf_fetch_child", str(spec)],
            stdin=process.PIPE,
            stdout=process.PIPE,
            stderr=err,
            env=env,
            start_new_session=True,
        )


def _blob_bytes(cache_dir: Path) -> int:
    total = 0
    for blob in cache_dir.glob("models--*/blobs/*"):
        try:
            total += blob.stat().st_size
        except OSError:
            continue
    return total


def _wait(check, timeout: float) -> bool:  # type: ignore[no-untyped-def]
    gate = threading.Event()
    deadline = time.monotonic() + timeout
    while not check():
        if time.monotonic() >= deadline:
            return False
        gate.wait(STEP_SEC)
    return True


def check_download(python: str, pin: PinnedSnapshot, work: Path, env: dict[str, str]) -> None:
    cache = work / "full"
    proc = _start(python, _spec(pin, cache, work), work / "full.log", env)
    assert proc.stdout is not None
    lines: list[bytes] = []
    reader = threading.Thread(target=lambda: lines.extend(proc.stdout), daemon=True)  # type: ignore[arg-type]
    reader.start()
    try:
        code = proc.wait(timeout=RUN_TIMEOUT_SEC)
    except process.TimeoutExpired as exc:
        process.kill_child(proc)
        raise CheckError("the download child did not finish in time") from exc
    reader.join(timeout=5.0)
    if code != 0 or len(lines) != 1:
        log = (work / "full.log").read_text(errors="replace")[-800:]
        raise CheckError(f"child exit {code}, stdout {lines!r}, log tail: {log}")
    path = Path(json.loads(lines[0])["path"])
    missing = [name for name, _ in pin.file_sha256 if not (path / name).is_file()]
    if missing:
        raise CheckError(f"snapshot {path} lacks {missing}")
    print(f"ok: child printed the snapshot path ({_blob_bytes(cache) / MIB:.0f} MiB cached)")


def check_kill(python: str, pin: PinnedSnapshot, work: Path, env: dict[str, str]) -> None:
    cache = work / "killed"
    proc = _start(python, _spec(pin, cache, work), work / "killed.log", env)
    if not _wait(lambda: _blob_bytes(cache) >= KILL_AT_BYTES or proc.poll() is not None, 120.0):
        process.kill_child(proc)
        raise CheckError("the cache never started to grow")
    if proc.poll() is not None:
        raise CheckError("the child finished before it could be killed; use a slower link")
    started = time.monotonic()
    process.kill_child(proc)
    if not _wait(lambda: proc.poll() is not None, KILL_WITHIN_SEC):
        raise CheckError(f"the child was still running {KILL_WITHIN_SEC:.0f} s after the kill")
    elapsed = time.monotonic() - started
    left = _blob_bytes(cache)
    if left > MODEL_BYTES * (1 - UNWRITTEN_AT_KILL):
        raise CheckError(f"{left / MIB:.0f} MiB were already on disk at the kill")
    print(f"ok: killed mid-download in {elapsed:.2f} s with {left / MIB:.1f} MiB on disk")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--python",
        default=sys.executable,
        help="interpreter to run the child (<runtime>/venv/bin/python for a frozen runtime)",
    )
    parser.add_argument("--python-home", help="PYTHONHOME to give the child (a frozen runtime)")
    args = parser.parse_args(argv)
    env = dict(os.environ)
    if args.python_home:
        env["PYTHONHOME"] = args.python_home
    pin = WHISPER_PINS["tiny.en"]
    with tempfile.TemporaryDirectory(prefix="hf-child-check-") as tmp:
        work = Path(tmp)
        try:
            check_download(args.python, pin, work, env)
            check_kill(args.python, pin, work, env)
        except (CheckError, OSError) as exc:
            print(f"FAIL: {exc}", file=sys.stderr)
            return 1
    print("hf_fetch_child check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
