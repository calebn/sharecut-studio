#!/usr/bin/env python3
"""Check that the Hugging Face download child runs under a given Python (#1998).

Spawns ``<python> -P -m podcast_mcp.util.hf_fetch_child <spec.json>`` against the pinned
``Systran/faster-whisper-tiny.en`` snapshot (``WHISPER_PINS``) in a temporary cache, and
fails unless (1) the child prints one ``{"path": ...}`` line with every pinned file present
and (2) a second child, cancelled the moment a ``model.bin`` ``.incomplete`` blob exists in the
repo's blobs dir (any size, polled every 10 ms), is gone within a few seconds, leaves no
completed ``model.bin`` blob and no ``.incomplete`` file of that fetch on disk. Needs the
network (about 78 MB).

Exit codes: 0 passed, 1 failed, 2 inconclusive (on a very fast link ``model.bin`` finished
before the trigger could fire, so Cancel was not exercised; retry on a slower link), 64
usage error (a bad flag; argparse's own 2 would read as inconclusive).

    .venv/bin/python scripts/check_hf_child.py
    .venv/bin/python scripts/check_hf_child.py --python <runtime>/venv/bin/python

The second form is the frozen-sidecar check: ``--python`` is the venv interpreter the
launcher execs (``<runtime>/venv/bin/python``, not the ``<runtime>/python`` directory) (see docs/desktop-packaging.md, "Download child"); pass the launcher's
``PYTHONHOME`` as ``--python-home`` when the interpreter needs it. It exits non-zero on any failure.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, NoReturn

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from podcast_mcp.engines.models.whisper import WHISPER_PINS
from podcast_mcp.util import process
from podcast_mcp.util.asset_sources import DownloadProgress
from podcast_mcp.util.model_manifest import PinnedSnapshot

MIB = 1024 * 1024
KILL_WITHIN_SEC = 3.0
POLL_SEC = 0.01
INCONCLUSIVE = 2
USAGE = 64
RUN_TIMEOUT_SEC = 300.0


class CheckError(RuntimeError):
    pass


class InconclusiveError(RuntimeError):
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


def _partials(blobs: Path) -> list[str]:
    with contextlib.suppress(OSError):
        return sorted(e.name for e in os.scandir(blobs) if e.name.endswith(".incomplete"))
    return []


def check_kill(python: str, pin: PinnedSnapshot, work: Path, env: dict[str, str]) -> None:
    """Cancel through the real fetch path as soon as model.bin's ``.incomplete`` blob exists."""
    from podcast_mcp.util import model_manifest
    from podcast_mcp.util.progress import CancelledProgress

    cache = work / "killed"
    sha = dict(pin.file_sha256)["model.bin"]
    blobs = cache / f"models--{pin.hf_repo.replace('/', '--')}" / "blobs"
    children: list[process.Child] = []
    real_popen = process.popen
    seen = {"partial": False, "cancelled_at": 0.0}

    def recording(*args: Any, **kwargs: Any) -> process.Child:
        child = real_popen(*args, **kwargs)
        children.append(child)
        return child

    def sink(_progress: DownloadProgress) -> None:
        if any(n.startswith(f"{sha}.") for n in _partials(blobs)):
            seen["partial"] = True
            seen["cancelled_at"] = time.monotonic()
            raise CancelledProgress("cancel")
        if (blobs / sha).exists():
            raise CancelledProgress("model.bin finished before any .incomplete was seen")

    # A cold Xet chunk cache of its own: the first download warmed the other one.
    os.environ.update({**env, "HF_HOME": str(work / "hf-home-kill")})  # the child inherits it
    patched = (model_manifest._POLL_SEC, model_manifest._child_argv, process.popen)
    model_manifest._POLL_SEC = POLL_SEC
    model_manifest._child_argv = lambda spec: [python, *patched[1](spec)[1:]]
    process.popen = recording  # type: ignore[assignment]
    try:
        model_manifest.download_pinned_snapshot(pin, cache, on_progress=sink)
        raise InconclusiveError("the download finished before Cancel could land")
    except CancelledProgress:
        pass
    finally:
        model_manifest._POLL_SEC, model_manifest._child_argv, process.popen = patched
    if not seen["partial"]:
        raise InconclusiveError(
            "model.bin finished before its .incomplete blob could be seen (a very fast link); "
            "Cancel was not exercised"
        )
    elapsed = time.monotonic() - seen["cancelled_at"]
    if elapsed > KILL_WITHIN_SEC or not children or children[0].poll() is None:
        raise CheckError(f"the child was still running {elapsed:.1f} s after Cancel")
    if (blobs / sha).exists():
        raise CheckError("model.bin was already complete at the kill")
    left = _partials(blobs)
    if left:
        raise CheckError(f".incomplete files left on disk after Cancel: {left}")
    print(
        f"ok: cancelled at the first model.bin .incomplete, child gone in {elapsed:.2f} s, none left"
    )


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        """A usage error is not an inconclusive run: exit 64, not argparse's 2."""
        self.print_usage(sys.stderr)
        self.exit(USAGE, f"{self.prog}: error: {message}\n")


def main(argv: list[str] | None = None) -> int:
    parser = _Parser(description=__doc__.split("\n\n")[0])
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
        # A fresh Xet chunk cache (under HF_HOME): a warm one makes the download finish
        # before the kill lands.
        env["HF_HOME"] = str(work / "hf-home")
        try:
            check_download(args.python, pin, work, env)
            check_kill(args.python, pin, work, env)
        except InconclusiveError as exc:
            print(f"INCONCLUSIVE: {exc}", file=sys.stderr)
            return INCONCLUSIVE
        except (CheckError, OSError) as exc:
            print(f"FAIL: {exc}", file=sys.stderr)
            return 1
    print("hf_fetch_child check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
