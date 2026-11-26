"""A child that fails with a hf_xet error falls back to plain HTTP; nothing else does (#1998)."""

from __future__ import annotations

import errno
import os
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from tests.polling import wait_for
from tests.test_hf_fetch_child import PIN, _payload_pin, _stub

from podcast_mcp.services.pipeline.install_failure import classify
from podcast_mcp.util import hf_fetch_child, model_manifest, process
from podcast_mcp.util.asset_sources import DownloadProgress
from podcast_mcp.util.model_manifest import (
    HubChildError,
    PinnedSnapshot,
    download_pinned_snapshot,
)
from podcast_mcp.util.progress import CancelledProgress

SHA = "c" * 64
HOUR = 3600.0
MARGIN = 120.0


@pytest.fixture(autouse=True)
def _child_mode(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("PODCAST_HF_IN_PROCESS", raising=False)
    monkeypatch.setenv("HF_HOME", str(tmp_path / "home"))
    monkeypatch.setattr(model_manifest, "_POLL_SEC", 0.05)
    monkeypatch.setattr(model_manifest, "_dry_run_total", lambda *_a: 100)


REAL_XET_MESSAGE = (
    "Task error: File reconstruction error: CAS Client Error: Request error: HTTP status "
    "client error (401 Unauthorized), domain: "
    "https://cas-server.xethub.hf.co/v2/reconstructions/dc8d6759b5ee4be73e674a434ac73432b4cbc5027e8c2d86a24acda5e332001f"
)
"""Verbatim from huggingface_hub 2.4.0 + hf_xet when the Xet token is refused: a plain
``RuntimeError`` raised by ``session.new_file_download_group`` (no hf_xet frame, no hf_xet class)."""


class XetAuthenticationError(Exception):
    """Looks like the hf_xet error a blocked Xet host raises."""


XetAuthenticationError.__module__ = "hf_xet"


class XetFoo(ValueError):
    """Named like a Xet class but defined here and wrapping an unrelated error type."""


class _FromHfXet(RuntimeError):
    pass


_FromHfXet.__module__ = "hf_xet.errors"


# ---- describe() -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("make", "kind", "xet"),
    [
        (lambda: XetAuthenticationError("blocked"), "network", True),
        (lambda: _FromHfXet("data processing error"), "network", True),
        (lambda: RuntimeError(REAL_XET_MESSAGE), "network", True),
        (lambda: RuntimeError("Task error: worker panicked"), "network", True),
        (lambda: RuntimeError("File reconstruction error: x"), "network", True),
        (lambda: RuntimeError("CAS Client Error: x"), "network", True),
        (lambda: RuntimeError("Data processing error: x"), "network", True),
        (lambda: XetFoo("wraps a bug"), "other", False),
        (lambda: RuntimeError("the Task error: is mid-message"), "other", False),
        (lambda: ValueError(REAL_XET_MESSAGE), "other", False),
        (lambda: RuntimeError("a bug"), "other", False),
        (lambda: ValueError("a bug"), "other", False),
        (lambda: ConnectionResetError("reset"), "network", False),
    ],
    ids=[
        "xet-class-name",
        "hf_xet-module",
        "real-message",
        "task-error",
        "reconstruction-error",
        "cas-error",
        "data-processing-error",
        "xet-named-value-error",
        "prefix-mid-message",
        "value-error-with-real-message",
        "runtime-error",
        "value-error",
        "plain-network",
    ],
)
def test_describe_marks_only_xet_class_failures(
    make: Callable[[], BaseException], kind: str, xet: bool
) -> None:
    line = hf_fetch_child.describe(make())

    assert (line["kind"], line["xet"]) == (kind, xet)


def test_describe_finds_a_status_wrapped_in_local_entry_not_found_via_cause() -> None:
    from huggingface_hub.errors import LocalEntryNotFoundError
    from tests.test_hf_fetch_child import _http_error

    try:
        raise LocalEntryNotFoundError("listing failed") from _http_error(404)
    except LocalEntryNotFoundError as exc:
        line = hf_fetch_child.describe(exc)

    assert (line["kind"], line["status"], line["xet"]) == ("http", 404, False)


def test_describe_keeps_disk_and_http_ahead_of_the_xet_rule() -> None:
    class XetDisk(OSError):
        pass

    line = hf_fetch_child.describe(XetDisk(errno.ENOSPC, "full"))

    assert (line["kind"], line["xet"]) == ("disk", False)


# ---- fallback on an hf_xet child failure ----------------------------------------------


XET_CHILD = (
    "import json, sys\n"
    "from podcast_mcp.util import hf_fetch_child\n"
    f"line = hf_fetch_child.describe(RuntimeError({REAL_XET_MESSAGE!r}))\n"
    "sys.stderr.write('xet-stderr-marker\\n')\n"
    "print(json.dumps(line)); sys.exit(1)\n"
)


def _hub(monkeypatch: pytest.MonkeyPatch, root: Path, *, report: int = 0) -> list[dict[str, Any]]:
    """An in-process hub; ``report`` bytes go through the progress bar like a real download."""
    import huggingface_hub

    calls: list[dict[str, Any]] = []

    def fake(*_args: object, **kwargs: Any) -> str:
        calls.append(dict(kwargs))
        if report and "tqdm_class" in kwargs:
            bar = kwargs["tqdm_class"](total=100, unit="B", desc="Reconstructing", initial=0)
            bar.update(report)
        root.mkdir(parents=True, exist_ok=True)
        (root / "model.bin").write_bytes(b"model")
        return str(root)

    monkeypatch.setattr(huggingface_hub, "snapshot_download", fake)
    return calls


def test_a_xet_error_before_any_bytes_falls_back_and_succeeds(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    calls = _hub(monkeypatch, tmp_path / "snap")
    _stub(monkeypatch, XET_CHILD)

    with caplog.at_level("WARNING", logger=model_manifest.logger.name):
        path, mismatch = download_pinned_snapshot(
            _payload_pin(), tmp_path / "hub", on_progress=lambda _p: None
        )

    assert mismatch is None
    assert path == tmp_path / "snap"
    assert len(calls) == 1
    assert "xet-stderr-marker" in caplog.text
    assert not list((tmp_path / "hub").glob(".fetch-child-*"))


@pytest.mark.parametrize("force", [True, False])
def test_the_fallback_gets_the_same_force_download(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, force: bool
) -> None:
    calls = _hub(monkeypatch, tmp_path / "snap")
    _stub(monkeypatch, XET_CHILD)

    download_pinned_snapshot(_payload_pin(), tmp_path / "hub", force=force)

    assert [c["force_download"] for c in calls] == [force]


def test_the_fallback_runs_with_xet_turned_off(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import huggingface_hub
    from huggingface_hub import constants

    seen: list[object] = []

    def fake(*_a: object, **_k: object) -> str:
        seen.append(constants.HF_HUB_DISABLE_XET)
        root = tmp_path / "snap"
        root.mkdir(exist_ok=True)
        (root / "model.bin").write_bytes(b"model")
        return str(root)

    monkeypatch.setattr(huggingface_hub, "snapshot_download", fake)
    _stub(monkeypatch, XET_CHILD)

    download_pinned_snapshot(_payload_pin(), tmp_path / "hub")

    assert seen == [True]
    assert model_manifest._plain_http_depth == 0


def _blob_child(then: str, *, size: int = 4) -> str:
    """Child code: complete a small blob in ``blobs/`` (a config over plain HTTP), then ``then``."""
    return (
        "import json, pathlib, sys\n"
        "from podcast_mcp.util import hf_fetch_child\n"
        "cache = json.load(open(sys.argv[1]))['cache_dir']\n"
        "blobs = pathlib.Path(cache) / 'models--acme--model' / 'blobs'\n"
        "blobs.mkdir(parents=True, exist_ok=True)\n"
        f"(blobs / {SHA!r}).write_bytes(b'x' * {size})\n" + then
    )


XET_AFTER_BLOB = (
    f"print(json.dumps(hf_fetch_child.describe(RuntimeError({REAL_XET_MESSAGE!r}))))\nsys.exit(1)\n"
)
NETWORK_AFTER_BLOB = (
    "print(json.dumps(hf_fetch_child.describe(ConnectionResetError('reset'))))\nsys.exit(1)\n"
)


def test_a_xet_failure_after_small_blobs_still_falls_back_and_succeeds(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    pin = _payload_pin()
    cache = tmp_path / "hub"
    calls = _hub(monkeypatch, tmp_path / "snap")
    _stub(monkeypatch, _blob_child(XET_AFTER_BLOB))

    path, mismatch = download_pinned_snapshot(pin, cache, on_progress=lambda _p: None)

    assert (path, mismatch) == (tmp_path / "snap", None)
    assert len(calls) == 1
    assert (model_manifest._blobs_dir(pin, cache) / SHA).read_bytes() == b"x" * 4


def test_a_plain_network_failure_after_small_blobs_never_falls_back(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls = _hub(monkeypatch, tmp_path / "snap")
    _stub(monkeypatch, _blob_child(NETWORK_AFTER_BLOB))

    with pytest.raises(HubChildError) as raised:
        download_pinned_snapshot(_payload_pin(), tmp_path / "hub", on_progress=lambda _p: None)

    assert (raised.value.kind, raised.value.xet) == ("network", False)
    assert calls == []


def test_a_plain_network_failure_with_no_bytes_never_falls_back(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls = _hub(monkeypatch, tmp_path / "snap")
    _stub(monkeypatch, _blob_child(NETWORK_AFTER_BLOB, size=0))

    with pytest.raises(HubChildError):
        download_pinned_snapshot(_payload_pin(), tmp_path / "hub")

    assert calls == []


def test_a_xet_error_that_surfaces_anyway_has_the_network_text(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import huggingface_hub

    def fail(*_a: object, **_k: object) -> str:
        raise HubChildError("network", "XetAuthenticationError: blocked", xet=True)

    monkeypatch.setattr(huggingface_hub, "snapshot_download", fail)
    _stub(monkeypatch, XET_CHILD)

    with pytest.raises(HubChildError) as raised:
        download_pinned_snapshot(_payload_pin(), tmp_path / "hub")

    failure = classify(raised.value, label="Whisper tiny.en", fix="podcast bootstrap")
    assert failure is not None
    assert failure.kind == "network"
    assert "Couldn't reach" in failure.plain


@pytest.mark.parametrize(
    "payload",
    [
        {"error": "GatedRepoError", "status": 403, "message": "m", "kind": "http", "xet": False},
        {"error": "OSError", "status": None, "message": "m", "kind": "disk", "errno": 28},
        {"error": "E", "status": 404, "message": "m", "kind": "http", "xet": True},
    ],
    ids=["http-403", "disk-enospc", "http-even-if-marked-xet"],
)
def test_http_and_disk_errors_do_not_fall_back(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, payload: dict[str, Any]
) -> None:
    calls = _hub(monkeypatch, tmp_path / "snap")
    _stub(monkeypatch, f"import json,sys; print(json.dumps({payload!r})); sys.exit(1)")

    with pytest.raises(HubChildError) as raised:
        download_pinned_snapshot(PIN, tmp_path / "hub", on_progress=lambda _p: None)

    assert raised.value.kind == payload["kind"]
    assert calls == []


def test_a_force_mismatch_fetch_spawns_the_child_once_before_falling_back(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls = _hub(monkeypatch, tmp_path / "snap")
    pin = PinnedSnapshot("acme/model", "a" * 40, (("model.bin", "0" * 64),))  # never matches
    _stub(monkeypatch, XET_CHILD)
    spawned: list[Any] = []
    real = process.popen

    def recording(*args: Any, **kwargs: Any) -> Any:
        spawned.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr(process, "popen", recording)

    _path, mismatch = download_pinned_snapshot(pin, tmp_path / "hub")

    assert mismatch is not None
    assert [c["force_download"] for c in calls] == [False, True]
    assert len(spawned) == 1


def test_cancel_during_the_fallback_is_honoured_while_the_hub_is_paused(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import threading

    import huggingface_hub

    started, release, finished = threading.Event(), threading.Event(), threading.Event()
    outcome: list[str] = []
    snap = tmp_path / "snap"

    def paused_hub(*_a: object, **kwargs: Any) -> str:
        bar = kwargs["tqdm_class"](total=100, unit="B", desc="Reconstructing", initial=0)
        started.set()
        release.wait(10)
        try:
            bar.update(5)  # the next byte after the pause: stops here once Cancel was raised
            snap.mkdir(exist_ok=True)
            (snap / "model.bin").write_bytes(b"model")
            outcome.append("completed")
        except CancelledProgress:
            outcome.append("stopped")
        finally:
            finished.set()
        return str(snap)

    monkeypatch.setattr(huggingface_hub, "snapshot_download", paused_hub)
    _stub(monkeypatch, XET_CHILD)

    def sink(_progress: DownloadProgress) -> None:
        if started.is_set():
            raise CancelledProgress("cancel")

    try:
        t0 = time.monotonic()
        with pytest.raises(CancelledProgress):
            download_pinned_snapshot(_payload_pin(), tmp_path / "hub", on_progress=sink)
        assert time.monotonic() - t0 < 5.0
        assert not release.is_set()
    finally:
        release.set()
    assert finished.wait(5.0)
    assert outcome == ["stopped"]
    assert not (snap / "model.bin").exists()
    assert wait_for(lambda: model_manifest._plain_http_depth == 0, timeout=5.0)


def test_a_force_refetch_after_the_fallback_still_honours_cancel_on_a_paused_hub(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The mismatch refetch (``fetch(True)``) runs plain HTTP with no child: it needs the heartbeat too."""
    import threading

    import huggingface_hub

    release = threading.Event()
    calls: list[bool] = []
    snap = tmp_path / "snap"
    pin = PinnedSnapshot("acme/model", "a" * 40, (("model.bin", "0" * 64),))  # never matches

    def hub(*_a: object, **kwargs: Any) -> str:
        calls.append(bool(kwargs["force_download"]))
        snap.mkdir(exist_ok=True)
        (snap / "model.bin").write_bytes(b"model")
        if kwargs["force_download"]:
            release.wait(10)  # the paused hub: no byte, so no bar update
        return str(snap)

    monkeypatch.setattr(huggingface_hub, "snapshot_download", hub)
    _stub(monkeypatch, XET_CHILD)

    def sink(_progress: DownloadProgress) -> None:
        if calls == [False, True]:
            raise CancelledProgress("cancel")

    try:
        t0 = time.monotonic()
        with pytest.raises(CancelledProgress):
            download_pinned_snapshot(pin, tmp_path / "hub", on_progress=sink)
        assert time.monotonic() - t0 < 5.0
        assert not release.is_set()
    finally:
        release.set()
    assert wait_for(lambda: model_manifest._plain_http_depth == 0, timeout=5.0)


def test_a_keyboard_interrupt_in_join_stops_the_worker_at_its_next_update(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import threading

    started, release, outcome = threading.Event(), threading.Event(), []
    stop = model_manifest._Stop()
    report = model_manifest._MonotonicProgress(lambda _p: None, 100)
    guarded = stop.guard(report)

    def download() -> Path:
        started.set()
        release.wait(10)
        try:
            guarded(DownloadProgress(5, 100))  # the next byte after the pause
            outcome.append("completed")
        except KeyboardInterrupt:
            outcome.append("stopped")
        return Path()

    real_join = threading.Thread.join

    def interrupted(self: threading.Thread, timeout: float | None = None) -> None:
        if self.name == "plain-http-fallback" and started.wait(5.0):
            raise KeyboardInterrupt
        real_join(self, timeout)

    monkeypatch.setattr(threading.Thread, "join", interrupted)
    worker_done = threading.Event()

    def call() -> Path:
        try:
            return download()
        finally:
            worker_done.set()

    try:
        with pytest.raises(KeyboardInterrupt):
            model_manifest._run_with_heartbeat(call, report, stop)
        assert isinstance(stop.error, KeyboardInterrupt)
    finally:
        release.set()
    assert worker_done.wait(5.0)
    assert outcome == ["stopped"]


def test_a_child_that_left_no_result_falls_back_but_a_force_refetch_may_spawn_again(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Only a real Xet failure turns the child off for the rest of the download."""
    calls = _hub(monkeypatch, tmp_path / "snap")
    pin = PinnedSnapshot("acme/model", "a" * 40, (("model.bin", "0" * 64),))  # never matches
    _stub(monkeypatch, "import sys; sys.exit(3)")
    spawned: list[Any] = []
    real = process.popen

    def recording(*args: Any, **kwargs: Any) -> Any:
        spawned.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr(process, "popen", recording)

    download_pinned_snapshot(pin, tmp_path / "hub")

    assert [c["force_download"] for c in calls] == [False, True]
    assert len(spawned) == 2


def test_the_fallback_progress_never_goes_backwards_after_the_child_showed_bytes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _hub(monkeypatch, tmp_path / "snap", report=20)
    _stub(monkeypatch, _blob_child(XET_AFTER_BLOB, size=50))
    events: list[int] = []

    download_pinned_snapshot(
        _payload_pin(), tmp_path / "hub", on_progress=lambda p: events.append(p.bytes)
    )

    assert events[0] == 0
    assert 50 in events
    assert events == sorted(events)
    assert events[-1] >= 50


# ---- the progress bar's first event -----------------------------------------------------


def test_the_first_progress_event_is_zero_bytes_against_the_total(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    snapshot = tmp_path / "snap"
    snapshot.mkdir()
    (snapshot / "model.bin").write_bytes(b"model")
    _stub(monkeypatch, f"import json; print(json.dumps({{'path': {str(snapshot)!r}}}))")
    monkeypatch.setattr(model_manifest, "_dry_run_total", lambda *_a: 4321)
    events: list[DownloadProgress] = []

    download_pinned_snapshot(_payload_pin(), tmp_path / "hub", on_progress=events.append)

    assert events[0] == DownloadProgress(0, 4321)


# ---- Cancel on BaseException ------------------------------------------------------------


@pytest.mark.parametrize("stop", [KeyboardInterrupt, SystemExit, CancelledProgress])
def test_a_base_exception_from_the_sink_kills_the_child_and_never_falls_back(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, stop: type[BaseException]
) -> None:
    calls = _hub(monkeypatch, tmp_path / "snap")
    _stub(monkeypatch, "import threading; threading.Event().wait(60)")
    procs: list[Any] = []
    real = process.popen

    def recording(*args: Any, **kwargs: Any) -> Any:
        procs.append(real(*args, **kwargs))
        return procs[-1]

    monkeypatch.setattr(process, "popen", recording)
    ticks = 0

    def sink(_progress: DownloadProgress) -> None:
        nonlocal ticks
        ticks += 1
        if ticks == 3:
            raise stop("stop")

    try:
        with pytest.raises(stop):
            download_pinned_snapshot(_payload_pin(), tmp_path / "hub", on_progress=sink)
        assert procs[0].poll() is not None
        assert wait_for(lambda: not process.pid_is_alive(procs[0].pid), timeout=5.0)
        assert calls == []
    finally:
        for proc in procs:
            process.kill_child(proc)


# ---- the child honours force_download ---------------------------------------------------


@pytest.mark.parametrize("force", [True, False])
def test_the_child_passes_force_download_to_the_hub(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, force: bool
) -> None:
    import huggingface_hub

    seen: dict[str, Any] = {}

    def fake(*args: object, **kwargs: Any) -> str:
        seen.update(kwargs)
        return str(tmp_path)

    monkeypatch.setattr(huggingface_hub, "snapshot_download", fake)

    hf_fetch_child.run(
        {
            "repo": "acme/model",
            "revision": "a" * 40,
            "allow_patterns": ["model.bin"],
            "cache_dir": str(tmp_path),
            "force_download": force,
        }
    )

    assert seen["force_download"] is force
    assert seen["allow_patterns"] == ["model.bin"]


# ---- the stale sweeps' one-hour boundary ------------------------------------------------


def _age(path: Path, seconds: float) -> None:
    then = time.time() - seconds
    os.utime(path, (then, then))


def _done_child(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    snapshot = tmp_path / "snap"
    snapshot.mkdir(exist_ok=True)
    (snapshot / "model.bin").write_bytes(b"model")
    _stub(monkeypatch, f"import json; print(json.dumps({{'path': {str(snapshot)!r}}}))")


def test_a_partial_just_over_an_hour_old_is_swept_and_just_under_is_kept(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    pin = _payload_pin()
    cache = tmp_path / "hub"
    blobs = model_manifest._blobs_dir(pin, cache)
    blobs.mkdir(parents=True)
    over = blobs / f"{SHA}.over1.incomplete"
    under = blobs / f"{SHA}.under.incomplete"
    for path, age in ((over, HOUR + MARGIN), (under, HOUR - MARGIN)):
        path.write_bytes(b"x")
        _age(path, age)
    _done_child(monkeypatch, tmp_path)

    download_pinned_snapshot(pin, cache)

    assert not over.exists()
    assert under.exists()


def test_a_scratch_file_just_over_an_hour_old_is_swept_and_just_under_is_kept(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cache = tmp_path / "hub"
    cache.mkdir()
    over = cache / ".fetch-child-over.log"
    under = cache / ".fetch-child-under.log"
    for path, age in ((over, HOUR + MARGIN), (under, HOUR - MARGIN)):
        path.write_text("x")
        _age(path, age)
    _done_child(monkeypatch, tmp_path)

    download_pinned_snapshot(_payload_pin(), cache)

    assert not over.exists()
    assert under.exists()


# ---- cleanup never deletes what the child finished --------------------------------------


def _completes_a_blob(go: Path, then: str) -> str:
    """Child code: finish ``<sha>`` and leave a ``<sha>.new1.incomplete`` partial, then ``then``."""
    return (
        "import json, pathlib, sys, threading\n"
        "cache = json.load(open(sys.argv[1]))['cache_dir']\n"
        "blobs = pathlib.Path(cache) / 'models--acme--model' / 'blobs'\n"
        "blobs.mkdir(parents=True, exist_ok=True)\n"
        f"(blobs / {SHA!r}).write_bytes(b'done')\n"
        f"(blobs / {SHA + '.new1.incomplete'!r}).write_bytes(b'part')\n"
        f"pathlib.Path({str(go)!r}).touch()\n" + then
    )


def test_cancel_deletes_the_partial_but_never_a_blob_the_child_completed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    pin = _payload_pin()
    cache = tmp_path / "hub"
    blobs = model_manifest._blobs_dir(pin, cache)
    go = tmp_path / "go"
    _stub(monkeypatch, _completes_a_blob(go, "threading.Event().wait(60)\n"))

    def sink(progress: DownloadProgress) -> None:
        if go.exists() and progress.bytes > 0:
            raise CancelledProgress("cancel")

    with pytest.raises(CancelledProgress):
        download_pinned_snapshot(pin, cache, on_progress=sink)

    assert (blobs / SHA).read_bytes() == b"done"
    assert not (blobs / f"{SHA}.new1.incomplete").exists()


def test_a_failure_after_the_child_completed_a_blob_keeps_that_blob(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    pin = _payload_pin()
    cache = tmp_path / "hub"
    blobs = model_manifest._blobs_dir(pin, cache)
    payload = {"error": "ConnectError", "message": "m", "kind": "network"}
    _stub(
        monkeypatch,
        _completes_a_blob(tmp_path / "go", f"print(json.dumps({payload!r})); sys.exit(1)\n"),
    )

    with pytest.raises(HubChildError):
        download_pinned_snapshot(pin, cache, on_progress=lambda _p: None)

    assert (blobs / SHA).read_bytes() == b"done"
    assert not (blobs / f"{SHA}.new1.incomplete").exists()


def test_a_successful_child_fetch_runs_no_cleanup_and_deletes_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    pin = _payload_pin()
    cache = tmp_path / "hub"
    blobs = model_manifest._blobs_dir(pin, cache)
    snapshot = tmp_path / "snap"
    snapshot.mkdir()
    (snapshot / "model.bin").write_bytes(b"model")
    _stub(
        monkeypatch,
        _completes_a_blob(tmp_path / "go", f"print(json.dumps({{'path': {str(snapshot)!r}}}))\n"),
    )
    removed: list[object] = []
    monkeypatch.setattr(model_manifest, "_remove_new_partials", lambda *a: removed.append(a))

    download_pinned_snapshot(pin, cache, on_progress=lambda _p: None)

    assert removed == []
    assert (blobs / SHA).exists()
    assert (blobs / f"{SHA}.new1.incomplete").exists()
