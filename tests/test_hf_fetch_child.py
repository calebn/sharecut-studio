"""Pinned snapshot downloads run in a killable child the parent polls (#1998, option C)."""

from __future__ import annotations

import errno
import hashlib
import json
import os
import sys
import threading
import time
from collections.abc import Callable, Iterator
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest
from tests import test_hf_cancel as loopback
from tests.polling import wait_for

from podcast_mcp.services.pipeline.install_failure import classify
from podcast_mcp.util import model_manifest, process
from podcast_mcp.util.asset_sources import DownloadProgress
from podcast_mcp.util.model_manifest import (
    HubChildError,
    PinnedSnapshot,
    download_pinned_snapshot,
)
from podcast_mcp.util.progress import CancelledProgress

MIB = 1024 * 1024
FIRST_WRITE = 10 * MIB
KILL_WITHIN_SEC = 3.0
CHILD_MODULE = "podcast_mcp.util.hf_fetch_child"
PIN = PinnedSnapshot(loopback.REPO, loopback.REV, (("model.bin", loopback.SHA256),))


@pytest.fixture(autouse=True)
def _child_mode(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("PODCAST_HF_IN_PROCESS", raising=False)
    monkeypatch.setenv("HF_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("HF_HUB_DISABLE_TELEMETRY", "1")
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    monkeypatch.setattr(model_manifest, "_POLL_SEC", 0.05)


@pytest.fixture
def hub(monkeypatch: pytest.MonkeyPatch) -> Iterator[loopback._Hub]:
    """A loopback hub whose model.bin pauses after the hub's first 10 MiB write."""
    state = loopback._Hub()
    monkeypatch.setattr(loopback, "PAUSE_AT", 12 * MIB)
    server = ThreadingHTTPServer(("127.0.0.1", 0), loopback._handler(state))
    server.daemon_threads = True
    serving = threading.Thread(target=server.serve_forever, daemon=True)
    serving.start()
    monkeypatch.setenv("HF_ENDPOINT", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setattr(model_manifest, "_dry_run_total", lambda *_a: loopback.SIZE)
    try:
        yield state
    finally:
        state.release.set()
        server.shutdown()
        server.server_close()
        serving.join(timeout=5.0)


@pytest.fixture
def spawned(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    """Every child the parent starts, so a test can check it is gone."""
    procs: list[Any] = []
    real = process.popen

    def recording(*args: Any, **kwargs: Any) -> Any:
        proc = real(*args, **kwargs)
        procs.append(proc)
        return proc

    monkeypatch.setattr(process, "popen", recording)
    return procs


def _bytes_arrive(monkeypatch: pytest.MonkeyPatch) -> None:
    """The repo's blobs read 0 at the baseline and 7 afterwards: the child got bytes first."""
    sizes = iter([0])
    monkeypatch.setattr(model_manifest, "_cache_bytes", lambda *_a: next(sizes, 7))


def _stub(monkeypatch: pytest.MonkeyPatch, code: str) -> None:
    """Run ``code`` instead of the real child; it gets the spec path as ``sys.argv[1]``."""
    monkeypatch.setattr(
        model_manifest, "_child_argv", lambda spec: [sys.executable, "-c", code, str(spec)]
    )


def test_child_progress_moves_up_and_ends_at_the_total(
    hub: loopback._Hub, spawned: list[Any], tmp_path: Path
) -> None:
    events: list[DownloadProgress] = []

    def sink(progress: DownloadProgress) -> None:
        events.append(progress)
        if progress.bytes >= FIRST_WRITE:
            hub.release.set()

    path, mismatch = download_pinned_snapshot(PIN, tmp_path / "hub", on_progress=sink)

    sizes = [e.bytes for e in events]
    assert mismatch is None
    assert (path / "model.bin").stat().st_size == loopback.SIZE
    assert {e.total for e in events} == {loopback.SIZE}
    assert sizes[0] == 0
    assert sizes == sorted(sizes)
    assert sizes[-1] == loopback.SIZE
    assert len(set(sizes)) >= 3, sizes
    assert len(spawned) == 1
    assert spawned[0].poll() == 0
    assert not list((tmp_path / "hub").glob(".fetch-child-*"))


def test_cancel_kills_the_child_and_reraises(
    hub: loopback._Hub, spawned: list[Any], tmp_path: Path
) -> None:
    raised_at: list[float] = []

    def sink(progress: DownloadProgress) -> None:
        if progress.bytes > 0:
            raised_at.append(time.monotonic())
            raise CancelledProgress("cancelled")

    with pytest.raises(CancelledProgress):
        download_pinned_snapshot(PIN, tmp_path / "hub", on_progress=sink)

    assert time.monotonic() - raised_at[0] < KILL_WITHIN_SEC
    (child,) = spawned
    assert child.poll() is not None
    assert wait_for(lambda: not process.pid_is_alive(child.pid), timeout=5.0)
    hub.release.set()
    assert wait_for(hub.ended.is_set, timeout=5.0)
    assert hub.write_error is not None
    assert hub.sent < loopback.SIZE
    assert list((tmp_path / "hub").rglob("snapshots/*/model.bin")) == []


def test_cancel_with_a_hung_child_kills_it_without_waiting_for_the_transfer(
    monkeypatch: pytest.MonkeyPatch, spawned: list[Any], tmp_path: Path
) -> None:
    _stub(monkeypatch, "import threading; threading.Event().wait(60)")
    monkeypatch.setattr(model_manifest, "_dry_run_total", lambda *_a: 100)
    calls = 0

    def sink(progress: DownloadProgress) -> None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise CancelledProgress("cancelled")

    sizes = iter([0])
    monkeypatch.setattr(model_manifest, "_cache_bytes", lambda *_a: next(sizes, 7))

    with pytest.raises(CancelledProgress):
        download_pinned_snapshot(PIN, tmp_path / "hub", on_progress=sink)

    assert spawned[0].poll() is not None


@pytest.mark.parametrize(
    ("payload", "kind", "status", "plain"),
    [
        (
            {"error": "RepositoryNotFoundError", "status": 404, "message": "m", "kind": "http"},
            "http",
            404,
            "doesn't have",
        ),
        (
            {"error": "GatedRepoError", "status": 403, "message": "m", "kind": "http"},
            "http",
            403,
            "refused access",
        ),
        (
            {"error": "ConnectError", "status": None, "message": "m", "kind": "network"},
            "network",
            None,
            "Couldn't reach",
        ),
        (
            {
                "error": "OSError",
                "status": None,
                "message": "m",
                "kind": "disk",
                "errno": 28,
            },
            "disk",
            None,
            "free disk space",
        ),
    ],
)
def test_a_child_error_is_classified_like_the_in_process_hub_error(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    payload: dict[str, Any],
    kind: str,
    status: int | None,
    plain: str,
) -> None:
    _stub(monkeypatch, f"import json,sys; print(json.dumps({payload!r})); sys.exit(1)")
    monkeypatch.setattr(model_manifest, "_dry_run_total", lambda *_a: 100)

    _bytes_arrive(monkeypatch)
    with pytest.raises(HubChildError) as raised:
        download_pinned_snapshot(PIN, tmp_path / "hub", on_progress=lambda _p: None)

    failure = classify(raised.value, label="Whisper tiny.en", fix="podcast bootstrap")
    assert failure is not None
    assert (failure.kind, failure.status) == (kind, status)
    assert plain in failure.plain
    assert raised.value.status == status


def test_a_child_that_dies_after_bytes_arrived_is_a_network_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _stub(monkeypatch, "import os; os._exit(9)")
    monkeypatch.setattr(model_manifest, "_dry_run_total", lambda *_a: 100)
    sizes = iter([0])
    monkeypatch.setattr(model_manifest, "_cache_bytes", lambda *_a: next(sizes, 7))

    with pytest.raises(HubChildError) as raised:
        download_pinned_snapshot(PIN, tmp_path / "hub", on_progress=lambda _p: None)

    failure = classify(raised.value, label="Whisper tiny.en", fix="x")
    assert failure is not None
    assert failure.kind == "network"
    assert "9" in str(raised.value)


NO_RESULT_CHILDREN = {
    "exit-without-output": "import os; os._exit(9)",
    "exit-0-with-garbage": "print('not json at all')",
    "exit-0-with-a-list": "print('[1, 2]')",
    "exit-0-with-null-path": "print('{\"path\": null}')",
    "exit-0-silent": "pass",
}


@pytest.mark.parametrize("code", NO_RESULT_CHILDREN.values(), ids=NO_RESULT_CHILDREN)
def test_a_child_that_cannot_run_falls_back_in_process_and_logs_its_stderr(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
    code: str,
) -> None:
    calls = _fake_in_process_hub(monkeypatch, tmp_path / "snap")
    _stub(monkeypatch, "import sys; sys.stderr.write('child-trace-marker\\n'); " + code)
    monkeypatch.setattr(model_manifest, "_dry_run_total", lambda *_a: 100)

    with caplog.at_level("WARNING", logger=model_manifest.logger.name):
        _, mismatch = download_pinned_snapshot(
            _payload_pin(), tmp_path / "hub", on_progress=lambda _p: None
        )

    assert mismatch is None
    assert calls == ["snapshot_download"]
    assert "child-trace-marker" in caplog.text
    assert not list((tmp_path / "hub").glob(".fetch-child-*"))


def test_a_child_with_a_missing_module_falls_back_in_process(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls = _fake_in_process_hub(monkeypatch, tmp_path / "snap")
    monkeypatch.setattr(
        model_manifest,
        "_child_argv",
        lambda spec: [sys.executable, "-m", "podcast_mcp.util.no_such_child", str(spec)],
    )

    download_pinned_snapshot(_payload_pin(), tmp_path / "hub")

    assert calls == ["snapshot_download"]


def test_a_child_error_logs_the_stderr_tail_before_the_log_is_removed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    payload = {"error": "ValueError", "status": None, "message": "boom", "kind": "other"}
    _stub(
        monkeypatch,
        "import json,sys; sys.stderr.write('x' * 5000 + 'tail-marker'); "
        f"print(json.dumps({payload!r})); sys.exit(1)",
    )

    _bytes_arrive(monkeypatch)
    with (
        caplog.at_level("WARNING", logger=model_manifest.logger.name),
        pytest.raises(HubChildError),
    ):
        download_pinned_snapshot(PIN, tmp_path / "hub")

    assert "tail-marker" in caplog.text
    assert "x" * 3000 not in caplog.text


@pytest.mark.parametrize(
    "payload",
    [
        {"kind": "http", "status": "404", "message": "m", "error": "E"},
        {"kind": "disk", "status": None, "errno": "28", "message": "m", "error": "E"},
        {"kind": 5, "status": [], "errno": {}, "message": None, "error": None},
        {"kind": "http", "status": True, "message": "m", "error": "E"},
    ],
)
def test_a_malformed_child_error_never_breaks_the_classifier(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, payload: dict[str, Any]
) -> None:
    _stub(monkeypatch, f"import json,sys; print(json.dumps({payload!r})); sys.exit(1)")

    _bytes_arrive(monkeypatch)
    with pytest.raises(HubChildError) as raised:
        download_pinned_snapshot(PIN, tmp_path / "hub")

    assert classify(raised.value, label="x", fix="y") is None


def test_progress_is_reported_on_every_poll_even_when_no_bytes_arrive(
    monkeypatch: pytest.MonkeyPatch, spawned: list[Any], tmp_path: Path
) -> None:
    _stub(monkeypatch, "import threading; threading.Event().wait(60)")
    monkeypatch.setattr(model_manifest, "_dry_run_total", lambda *_a: 100)
    monkeypatch.setattr(model_manifest, "_cache_bytes", lambda *_a: 0)
    seen: list[int] = []

    def sink(progress: DownloadProgress) -> None:
        seen.append(progress.bytes)
        if len(seen) == 5:
            raise CancelledProgress("cancelled")

    with pytest.raises(CancelledProgress):
        download_pinned_snapshot(PIN, tmp_path / "hub", on_progress=sink)

    assert seen == [0] * 5
    assert spawned[0].poll() is not None


def test_cancel_during_a_paused_hub_kills_the_child_within_a_second(
    hub: loopback._Hub, spawned: list[Any], tmp_path: Path
) -> None:
    cancel = threading.Event()
    stalled = 0
    cancelled_at: list[float] = []
    raised_at: list[float] = []

    def sink(progress: DownloadProgress) -> None:
        nonlocal stalled
        if cancel.is_set():
            raised_at.append(time.monotonic())
            raise CancelledProgress("cancelled")
        if progress.bytes >= FIRST_WRITE:
            stalled += 1
            if stalled == 4:  # the hub is paused, so these ticks carry no new bytes
                cancelled_at.append(time.monotonic())
                cancel.set()

    with pytest.raises(CancelledProgress):
        download_pinned_snapshot(PIN, tmp_path / "hub", on_progress=sink)

    assert raised_at[0] - cancelled_at[0] < 1.0
    (child,) = spawned
    assert wait_for(lambda: not process.pid_is_alive(child.pid), timeout=5.0)
    assert hub.sent < loopback.SIZE


def test_a_chatty_child_cannot_fill_the_stdout_pipe(
    monkeypatch: pytest.MonkeyPatch, spawned: list[Any], tmp_path: Path
) -> None:
    snapshot = tmp_path / "snap"
    snapshot.mkdir()
    (snapshot / "model.bin").write_bytes(b"model")
    _stub(
        monkeypatch,
        "import json, sys\n"
        "chunk = b'x' * 65536 + b'\\n'\n"
        "for _ in range(128):\n"
        "    sys.stdout.buffer.write(chunk)\n"
        "sys.stdout.buffer.flush()\n"
        f"print(json.dumps({{'path': {str(snapshot)!r}}}))\n",
    )
    outcome: list[Any] = []

    def run() -> None:
        try:
            outcome.append(download_pinned_snapshot(_payload_pin(), tmp_path / "hub"))
        except BaseException as exc:
            outcome.append(exc)

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    try:
        assert wait_for(lambda: outcome, timeout=30.0), "the parent hung on the child's stdout"
    finally:
        for child in spawned:
            process.kill_child(child)
        worker.join(timeout=5.0)
    assert outcome[0][1] is None


def test_an_oserror_from_the_progress_sink_propagates_and_never_restarts_in_process(
    monkeypatch: pytest.MonkeyPatch, spawned: list[Any], tmp_path: Path
) -> None:
    calls = _fake_in_process_hub(monkeypatch, tmp_path / "snap")
    _stub(monkeypatch, "import threading; threading.Event().wait(60)")
    monkeypatch.setattr(model_manifest, "_dry_run_total", lambda *_a: 100)
    sizes = iter([0])
    monkeypatch.setattr(model_manifest, "_cache_bytes", lambda *_a: next(sizes, 7))
    seen = 0

    def sink(_progress: DownloadProgress) -> None:
        nonlocal seen
        seen += 1
        if seen == 3:
            raise BrokenPipeError("sink closed")

    with pytest.raises(BrokenPipeError):
        download_pinned_snapshot(_payload_pin(), tmp_path / "hub", on_progress=sink)

    assert calls == []
    assert spawned[0].poll() is not None


def test_a_child_fetch_removes_stale_scratch_files_but_not_fresh_ones(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cache = tmp_path / "hub"
    cache.mkdir()
    old = [cache / ".fetch-child-old1.json", cache / ".fetch-child-old2.log"]
    fresh = cache / ".fetch-child-fresh.log"
    other = cache / "keep.json"
    long_ago = time.time() - 2 * 3600
    for path in (*old, fresh, other):
        path.write_text("x")
    for path in old:
        os.utime(path, (long_ago, long_ago))
    os.utime(other, (long_ago, long_ago))
    snapshot = tmp_path / "snap"
    snapshot.mkdir()
    (snapshot / "model.bin").write_bytes(b"model")
    _stub(monkeypatch, f"import json; print(json.dumps({{'path': {str(snapshot)!r}}}))")

    download_pinned_snapshot(_payload_pin(), cache)

    assert not any(path.exists() for path in old)
    assert fresh.exists()
    assert other.exists()


def test_a_child_error_the_classifier_does_not_know_is_not_a_known_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    payload = {"error": "ValueError", "status": None, "message": "boom", "kind": "other"}
    _stub(monkeypatch, f"import json,sys; print(json.dumps({payload!r})); sys.exit(1)")

    _bytes_arrive(monkeypatch)
    with pytest.raises(HubChildError) as raised:
        download_pinned_snapshot(PIN, tmp_path / "hub")

    assert classify(raised.value, label="x", fix="y") is None
    assert "boom" in str(raised.value)


def test_a_missing_revision_the_child_cannot_read_is_retried_in_process_and_reported_by_the_hub(
    hub: loopback._Hub, tmp_path: Path
) -> None:
    pin = PinnedSnapshot(loopback.REPO, "no-such-revision", PIN.file_sha256)

    # The child fails with no bytes (kind network), so the fetch retries in-process over
    # plain HTTP, where the hub raises its own error (a network or an http 404 failure
    # depending on what the library cached earlier in the process); never a child error.
    with pytest.raises(OSError) as raised:
        download_pinned_snapshot(pin, tmp_path / "hub", on_progress=lambda _p: None)

    failure = classify(raised.value, label="x", fix="y")
    assert not isinstance(raised.value, HubChildError)
    assert failure is not None
    assert failure.kind in {"network", "http"}


@pytest.mark.parametrize(
    ("make", "kind", "status", "code"),
    [
        (lambda: _http_error(404), "http", 404, None),
        (lambda: _hub_error("LocalEntryNotFoundError"), "network", None, None),
        (lambda: _hub_error("OfflineModeIsEnabled"), "network", None, None),
        (
            lambda: ConnectionResetError(errno.ECONNRESET, "reset"),
            "network",
            None,
            errno.ECONNRESET,
        ),
        (lambda: OSError(errno.ENOSPC, "full"), "disk", None, errno.ENOSPC),
        (lambda: OSError(errno.EACCES, "denied"), "disk", None, errno.EACCES),
        (lambda: ValueError("bug"), "other", None, None),
    ],
)
def test_the_child_describes_each_failure_with_a_kind(
    make: Callable[[], BaseException], kind: str, status: int | None, code: int | None
) -> None:
    from podcast_mcp.util import hf_fetch_child

    line = hf_fetch_child.describe(make())

    assert (line["kind"], line["status"], line["errno"]) == (kind, status, code)
    assert line["error"] == type(make()).__name__


def _http_error(status: int) -> BaseException:
    import httpx
    from huggingface_hub.errors import HfHubHTTPError

    request = httpx.Request("GET", "http://hub.invalid/x")
    return HfHubHTTPError("boom", response=httpx.Response(status, request=request))


def _hub_error(name: str) -> BaseException:
    from huggingface_hub import errors

    return getattr(errors, name)("x")


def _fake_in_process_hub(monkeypatch: pytest.MonkeyPatch, root: Path) -> list[str]:
    import huggingface_hub

    payload = b"model"
    calls: list[str] = []

    def fake(*_args: object, **_kwargs: object) -> str:
        calls.append("snapshot_download")
        root.mkdir(parents=True, exist_ok=True)
        (root / "model.bin").write_bytes(payload)
        return str(root)

    monkeypatch.setattr(huggingface_hub, "snapshot_download", fake)
    return calls


def _payload_pin() -> PinnedSnapshot:
    return PinnedSnapshot(
        "acme/model", "a" * 40, (("model.bin", hashlib.sha256(b"model").hexdigest()),)
    )


@pytest.mark.parametrize("failure", [process.SpawnUnavailableError(38, "no"), OSError("nope")])
def test_a_child_that_cannot_start_falls_back_to_the_in_process_hub(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, failure: OSError
) -> None:
    calls = _fake_in_process_hub(monkeypatch, tmp_path / "snap")

    def refuse(*_a: Any, **_k: Any) -> None:
        raise failure

    monkeypatch.setattr(process, "popen", refuse)

    _, mismatch = download_pinned_snapshot(_payload_pin(), tmp_path / "hub")

    assert mismatch is None
    assert calls == ["snapshot_download"]


def test_the_escape_hatch_env_keeps_the_download_in_process(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls = _fake_in_process_hub(monkeypatch, tmp_path / "snap")
    monkeypatch.setenv("PODCAST_HF_IN_PROCESS", "1")
    monkeypatch.setattr(process, "popen", lambda *_a, **_k: pytest.fail("spawned a child"))

    download_pinned_snapshot(_payload_pin(), tmp_path / "hub")

    assert calls == ["snapshot_download"]


def test_a_missing_hf_xet_keeps_the_download_in_process(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls = _fake_in_process_hub(monkeypatch, tmp_path / "snap")
    monkeypatch.setattr(model_manifest, "_xet_importable", lambda: False)
    monkeypatch.setattr(process, "popen", lambda *_a, **_k: pytest.fail("spawned a child"))

    download_pinned_snapshot(_payload_pin(), tmp_path / "hub")

    assert calls == ["snapshot_download"]


def test_a_forced_refetch_reports_bytes_from_zero(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    snapshot = tmp_path / "snap"
    snapshot.mkdir()
    (snapshot / "model.bin").write_bytes(b"model")
    pin = _payload_pin()
    go = tmp_path / "go"
    _stub(
        monkeypatch,
        "import json, pathlib, threading\n"
        f"go = pathlib.Path({str(go)!r})\n"
        "while not go.exists():\n"
        "    threading.Event().wait(0.01)\n"
        f"print(json.dumps({{'path': {str(snapshot)!r}}}))\n",
    )
    monkeypatch.setattr(model_manifest, "_dry_run_total", lambda *_a: 1000)
    sizes = iter([5000, 5000, 5100, 5300])
    last = 5300

    def gauge(*_a: Any) -> int:
        nonlocal last
        value = next(sizes, None)
        if value is None:
            go.touch()
            return last
        last = value
        return value

    monkeypatch.setattr(model_manifest, "_cache_bytes", gauge)
    events: list[int] = []

    _, mismatch = download_pinned_snapshot(
        pin, tmp_path / "hub", force=True, on_progress=lambda p: events.append(p.bytes)
    )

    assert mismatch is None
    assert events == sorted(events)
    assert list(dict.fromkeys(events)) == [0, 100, 300, 1000]


def _run_child(spec: dict[str, Any], tmp_path: Path) -> Any:
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec))
    return process.popen(
        [sys.executable, "-m", CHILD_MODULE, str(spec_path)],
        stdin=process.PIPE,
        stdout=process.PIPE,
        stderr=(tmp_path / "child.log").open("wb"),
    )


def _finish(proc: Any) -> bytes:
    """Everything the child wrote to stdout, read with its stdin pipe still open."""
    assert proc.stdout is not None
    out = proc.stdout.read()
    proc.wait(timeout=60)
    proc.stdout.close()
    proc.stdin.close()
    return out


def _spec(tmp_path: Path, revision: str = loopback.REV) -> dict[str, Any]:
    return {
        "repo": loopback.REPO,
        "revision": revision,
        "allow_patterns": ["model.bin"],
        "cache_dir": str(tmp_path / "hub"),
        "force_download": False,
    }


def test_the_child_prints_one_json_line_with_the_snapshot_path(
    hub: loopback._Hub, tmp_path: Path
) -> None:
    hub.release.set()
    proc = _run_child(_spec(tmp_path), tmp_path)

    out = _finish(proc)

    lines = out.decode().splitlines()
    assert proc.returncode == 0
    assert len(lines) == 1
    assert (Path(json.loads(lines[0])["path"]) / "model.bin").stat().st_size == loopback.SIZE


def test_the_child_prints_one_json_error_line_and_exits_1(
    hub: loopback._Hub, tmp_path: Path
) -> None:
    proc = _run_child(_spec(tmp_path, revision="no-such-revision"), tmp_path)

    out = _finish(proc)

    lines = out.decode().splitlines()
    assert proc.returncode == 1
    assert len(lines) == 1
    result = json.loads(lines[0])
    assert result["error"] == "LocalEntryNotFoundError"
    assert result["kind"] == "network"
    assert result["status"] is None
    assert "message" in result


def test_the_child_exits_when_its_parent_closes_stdin(hub: loopback._Hub, tmp_path: Path) -> None:
    proc = _run_child(_spec(tmp_path), tmp_path)
    assert wait_for(lambda: hub.sent > 0 or proc.poll() is not None, timeout=60)
    assert proc.poll() is None

    assert proc.stdin is not None
    proc.stdin.close()

    assert wait_for(lambda: proc.poll() is not None, timeout=10)
    hub.release.set()
    assert wait_for(hub.ended.is_set, timeout=10)
    assert hub.sent < loopback.SIZE
    assert proc.stdout is not None
    proc.stdout.close()


def test_the_child_argv_keeps_the_callers_cwd_off_sys_path_like_the_launcher(
    tmp_path: Path,
) -> None:
    argv = model_manifest._child_argv(tmp_path / "spec.json")

    assert argv[0] == sys.executable
    assert argv.index("-P") < argv.index("-m")
    assert argv[argv.index("-m") + 1] == CHILD_MODULE


def test_a_decoy_huggingface_hub_in_the_cwd_is_not_imported_by_a_real_child(
    hub: loopback._Hub, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    decoy_dir = tmp_path / "decoy"
    decoy_dir.mkdir()
    marker = tmp_path / "decoy-imported"
    (decoy_dir / "huggingface_hub.py").write_text(
        f"import pathlib\npathlib.Path({str(marker)!r}).write_text('x')\nraise SystemExit(7)\n"
    )
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(_spec(tmp_path, revision="no-such-revision")))
    monkeypatch.chdir(decoy_dir)

    proc = process.popen(
        model_manifest._child_argv(spec_path),
        stdin=process.PIPE,
        stdout=process.PIPE,
        stderr=(tmp_path / "child.log").open("wb"),
    )
    out = _finish(proc)

    assert not marker.exists()
    assert json.loads(out.decode().splitlines()[-1])["error"] == "LocalEntryNotFoundError"


def _hang_until(go: Path) -> str:
    return (
        "import pathlib, threading\n"
        f"go = pathlib.Path({str(go)!r})\n"
        "while not go.exists():\n"
        "    threading.Event().wait(0.01)\n"
    )


def _gauge(monkeypatch: pytest.MonkeyPatch, values: list[int], go: Path, after: int) -> None:
    """Cache bytes: ``values`` in order, then let the child finish and report ``after``."""
    queue = iter(values)

    def gauge(*_a: Any) -> int:
        value = next(queue, None)
        if value is None:
            go.touch()
            return after
        return value

    monkeypatch.setattr(model_manifest, "_cache_bytes", gauge)


def test_progress_never_exceeds_the_total_when_the_cache_holds_more(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    go = tmp_path / "go"
    _stub(monkeypatch, _hang_until(go) + "import sys; sys.exit(1)")
    monkeypatch.setattr(model_manifest, "_dry_run_total", lambda *_a: 100)
    _gauge(monkeypatch, [0, 5000, 5000], go, after=5000)
    events: list[int] = []

    with pytest.raises(HubChildError):
        download_pinned_snapshot(
            PIN, tmp_path / "hub", on_progress=lambda p: events.append(p.bytes)
        )

    assert max(events) == 100, events


def test_progress_never_goes_backwards_when_the_cache_shrinks(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    go = tmp_path / "go"
    _stub(monkeypatch, _hang_until(go) + "import sys; sys.exit(1)")
    monkeypatch.setattr(model_manifest, "_dry_run_total", lambda *_a: None)
    # Baseline 0, a tick at 50, then the cache shrinks (an .incomplete file replaced) to 30.
    _gauge(monkeypatch, [0, 50, 50], go, after=30)
    events: list[int] = []

    with pytest.raises(HubChildError):
        download_pinned_snapshot(
            PIN, tmp_path / "hub", on_progress=lambda p: events.append(p.bytes)
        )

    assert events == sorted(events), events
    assert events[-1] == 50


@pytest.mark.parametrize("force", [True, False])
def test_force_download_reaches_the_child_spec(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, force: bool
) -> None:
    seen = tmp_path / "seen.json"
    _stub(
        monkeypatch,
        f"import shutil, sys; shutil.copy(sys.argv[1], {str(seen)!r}); "
        'print(\'{"error": "E", "kind": "other"}\'); sys.exit(1)',
    )
    monkeypatch.setattr(model_manifest, "_dry_run_total", lambda *_a: 100)

    _bytes_arrive(monkeypatch)
    with pytest.raises(HubChildError):
        download_pinned_snapshot(PIN, tmp_path / "hub", force=force)

    assert json.loads(seen.read_text())["force_download"] is force


@pytest.mark.skipif(os.name == "nt", reason="process groups are POSIX; Windows uses a new group")
def test_the_child_is_its_own_process_group_leader(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    seen = tmp_path / "group"
    _stub(
        monkeypatch,
        f"import os, sys; open({str(seen)!r}, 'w').write(f'{{os.getpgrp()}} {{os.getpid()}}'); "
        'print(\'{"error": "E", "kind": "other"}\'); sys.exit(1)',
    )
    monkeypatch.setattr(model_manifest, "_dry_run_total", lambda *_a: 100)

    _bytes_arrive(monkeypatch)
    with pytest.raises(HubChildError):
        download_pinned_snapshot(PIN, tmp_path / "hub")

    group, pid = seen.read_text().split()
    assert group == pid
    assert int(group) != os.getpgrp()


def test_the_parent_closes_the_childs_stdin_when_the_child_finishes(
    monkeypatch: pytest.MonkeyPatch, spawned: list[Any], tmp_path: Path
) -> None:
    _stub(monkeypatch, 'import sys; print(\'{"error": "E", "kind": "other"}\'); sys.exit(1)')
    monkeypatch.setattr(model_manifest, "_dry_run_total", lambda *_a: 100)

    _bytes_arrive(monkeypatch)
    with pytest.raises(HubChildError):
        download_pinned_snapshot(PIN, tmp_path / "hub")

    assert spawned[0].stdin.closed


def test_the_parent_closes_the_childs_stdin_on_cancel(
    monkeypatch: pytest.MonkeyPatch, spawned: list[Any], tmp_path: Path
) -> None:
    _stub(monkeypatch, "import threading; threading.Event().wait(60)")
    monkeypatch.setattr(model_manifest, "_dry_run_total", lambda *_a: 100)

    ticks: list[int] = []

    def sink(progress: DownloadProgress) -> None:
        ticks.append(progress.bytes)
        if len(ticks) == 3:  # past the first report and into the polling loop
            raise CancelledProgress("cancelled")

    with pytest.raises(CancelledProgress):
        download_pinned_snapshot(PIN, tmp_path / "hub", on_progress=sink)

    assert spawned[0].stdin.closed


@pytest.mark.parametrize(
    ("kind", "expected"),
    [
        ("http", "http"),
        ("network", "network"),
        ("disk", "disk"),
        ("other", "other"),
        ("odd", "other"),
    ],
)
def test_a_hub_child_error_keeps_only_known_kinds(kind: str, expected: str) -> None:
    assert HubChildError(kind, "m").kind == expected


@pytest.mark.parametrize("kind", [5, None, ["http"], {"kind": "http"}])
def test_a_child_result_with_a_non_string_kind_is_an_other_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, kind: object
) -> None:
    payload = {"error": "E", "message": "m", "kind": kind}
    _stub(monkeypatch, f"import json,sys; print(json.dumps({payload!r})); sys.exit(1)")
    monkeypatch.setattr(model_manifest, "_dry_run_total", lambda *_a: 100)

    _bytes_arrive(monkeypatch)
    with pytest.raises(HubChildError) as raised:
        download_pinned_snapshot(PIN, tmp_path / "hub")

    assert raised.value.kind == "other"


def test_the_final_report_keeps_the_high_water_mark_when_the_cache_shrank(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    snapshot = tmp_path / "snap"
    snapshot.mkdir()
    (snapshot / "model.bin").write_bytes(b"model")
    go = tmp_path / "go"
    _stub(
        monkeypatch,
        _hang_until(go) + f"import json; print(json.dumps({{'path': {str(snapshot)!r}}}))\n",
    )
    monkeypatch.setattr(model_manifest, "_dry_run_total", lambda *_a: None)
    _gauge(monkeypatch, [0, 50, 50], go, after=30)
    events: list[int] = []

    download_pinned_snapshot(
        _payload_pin(), tmp_path / "hub", on_progress=lambda p: events.append(p.bytes)
    )

    assert events == sorted(events), events
    assert events[-1] == 50
