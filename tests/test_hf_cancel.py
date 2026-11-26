"""Cancelling a real huggingface_hub snapshot download stops the transfer (#1998 G7)."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import threading
from collections.abc import Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from tests.polling import wait_for

MIB = 1024 * 1024
CHUNK = 64 * 1024
SIZE = 40 * MIB
PAUSE_AT = 4 * MIB
FIRST_EVENT_MAX = 2 * MIB
SLACK = 4 * MIB
MIN_EVENTS = 8
FAIL_SAFE_SEC = 10.0
START_SEC = 60.0
REPO = "x/y"
REV = "a" * 40
SRC = Path(__file__).resolve().parents[1] / "src"


def _body() -> Iterator[bytes]:
    chunk = b"x" * CHUNK
    for _ in range(SIZE // CHUNK):
        yield chunk


SHA256 = hashlib.sha256(b"".join(_body())).hexdigest()

DRIVER = """
import json, sys
sys.path.insert(0, sys.argv[1])
cfg = json.loads(sys.argv[2])
from podcast_mcp.util.model_manifest import PinnedSnapshot, download_pinned_snapshot
from podcast_mcp.util.progress import CancelledProgress

def sink(progress):
    if progress.bytes <= 0:
        return
    print("EVENT", progress.bytes, flush=True)
    if cfg["cancel"]:
        raise CancelledProgress("cancelled")

pin = PinnedSnapshot(cfg["repo"], cfg["rev"], (("model.bin", cfg["sha256"]),))
try:
    _, mismatch = download_pinned_snapshot(pin, cfg["cache"], on_progress=sink)
except CancelledProgress as exc:
    print("RAISED", type(exc).__name__, flush=True)
else:
    print("DONE", mismatch, flush=True)
"""


@dataclass
class _Hub:
    sent: int = 0
    write_error: OSError | None = None
    release: threading.Event = field(default_factory=threading.Event)
    ended: threading.Event = field(default_factory=threading.Event)


def _handler(hub: _Hub) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:
            return

        def _json(self, payload: Any) -> None:
            data = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_HEAD(self) -> None:
            self.do_GET(head=True)

        def do_GET(self, head: bool = False) -> None:
            path = self.path.split("?")[0]
            if path.endswith(f"/revision/{REV}"):
                self._json({"id": REPO, "sha": REV, "siblings": [{"rfilename": "model.bin"}]})
            elif "/tree/" in path:
                self._json([{"type": "file", "path": "model.bin", "size": SIZE, "oid": "o"}])
            elif path.endswith("/model.bin"):
                self._model(head)
            else:
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()

        def _model(self, head: bool) -> None:
            self.send_response(200)
            self.send_header("Content-Length", str(SIZE))
            self.send_header("ETag", '"abc"')
            self.send_header("X-Repo-Commit", REV)
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            if head:
                return
            try:
                for chunk in _body():
                    if hub.sent == PAUSE_AT:
                        hub.release.wait(timeout=FAIL_SAFE_SEC)
                    self.wfile.write(chunk)
                    hub.sent += len(chunk)
            except OSError as exc:
                hub.write_error = exc
            finally:
                self.close_connection = True
                hub.ended.set()

    return Handler


@dataclass
class _Run:
    hub: _Hub
    lines: list[str]
    events: list[int]
    first_bytes: int
    returncode: int
    snapshot_files: list[Path]
    stderr: str

    @property
    def outcome(self) -> str:
        return self.lines[-1] if self.lines else ""


def _env(endpoint: str, home: Path) -> dict[str, str]:
    inherited = {k: v for k, v in os.environ.items() if k in ("SYSTEMROOT", "TEMP", "TMP", "PATH")}
    return {
        **inherited,
        "HF_ENDPOINT": endpoint,
        "NO_PROXY": "127.0.0.1,localhost",
        "no_proxy": "127.0.0.1,localhost",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "HF_HOME": str(home),
        "HOME": str(home),
    }


def _run(tmp_path: Path, *, cancel: bool) -> _Run:
    hub = _Hub()
    server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(hub))
    server.daemon_threads = True
    serving = threading.Thread(target=server.serve_forever, daemon=True)
    serving.start()
    cache = tmp_path / "hub"
    config = json.dumps(
        {"repo": REPO, "rev": REV, "sha256": SHA256, "cache": str(cache), "cancel": cancel}
    )
    stderr_path = tmp_path / "child.err"
    lines: list[str] = []
    event_seen = threading.Event()
    proc: subprocess.Popen[str] | None = None
    reader: threading.Thread | None = None
    try:
        with stderr_path.open("w") as err:
            proc = subprocess.Popen(
                [sys.executable, "-I", "-c", DRIVER, str(SRC), config],
                env=_env(f"http://127.0.0.1:{server.server_port}", tmp_path / "home"),
                stdout=subprocess.PIPE,
                stderr=err,
                text=True,
            )
            assert proc.stdout is not None
            stdout = proc.stdout

            def read() -> None:
                for line in stdout:
                    lines.append(line.strip())
                    if line.startswith("EVENT"):
                        event_seen.set()

            reader = threading.Thread(target=read, daemon=True)
            reader.start()
            wait_for(lambda: event_seen.is_set() or proc.poll() is not None, timeout=START_SEC)
            if not cancel or not event_seen.is_set():
                hub.release.set()
            returncode = proc.wait(timeout=START_SEC)
        reader.join(timeout=FAIL_SAFE_SEC)
        hub.release.set()
        wait_for(hub.ended.is_set, timeout=5.0)
    finally:
        hub.release.set()
        if proc is not None and proc.poll() is None:
            proc.kill()
            proc.wait()
        server.shutdown()
        server.server_close()
        serving.join(timeout=5.0)
        if reader is not None:
            reader.join(timeout=5.0)
    events = [int(line.split()[1]) for line in lines if line.startswith("EVENT")]
    return _Run(
        events=events,
        hub=hub,
        lines=lines,
        first_bytes=events[0] if events else 0,
        returncode=returncode,
        snapshot_files=sorted(cache.rglob("snapshots/*/model.bin")),
        stderr=stderr_path.read_text(),
    )


def test_cancel_from_sink_stops_the_real_transfer(tmp_path: Path) -> None:
    run = _run(tmp_path, cancel=True)
    hub = run.hub

    assert run.outcome == "RAISED CancelledProgress", run.stderr
    assert 0 < run.first_bytes <= FIRST_EVENT_MAX, run.lines
    assert hub.ended.is_set()
    assert hub.write_error is not None
    assert hub.sent <= run.first_bytes + SLACK, (
        f"server wrote {hub.sent} bytes, first event at {run.first_bytes}"
    )
    assert run.snapshot_files == []


def test_without_cancel_the_whole_file_arrives(tmp_path: Path) -> None:
    run = _run(tmp_path, cancel=False)
    hub = run.hub

    assert run.outcome == "DONE None", run.stderr
    assert 0 < run.first_bytes <= FIRST_EVENT_MAX, run.lines
    assert len(run.events) >= MIN_EVENTS, run.events
    assert run.events[-1] == SIZE
    assert hub.ended.is_set()
    assert hub.write_error is None
    assert hub.sent == SIZE
    assert len(run.snapshot_files) == 1
