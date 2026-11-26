"""A child that fails before any bytes falls back to plain HTTP; surviving-mutant guards (#1998)."""

from __future__ import annotations

import errno
import os
import time
from pathlib import Path
from typing import Any

import pytest
from tests.polling import wait_for
from tests.test_hf_fetch_child import PIN, _payload_pin, _stub

from podcast_mcp.services.pipeline.install_failure import classify
from podcast_mcp.util import hf_fetch_child, model_manifest, process
from podcast_mcp.util.asset_sources import DownloadProgress
from podcast_mcp.util.model_manifest import HubChildError, download_pinned_snapshot
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


class XetAuthenticationError(Exception):
    """Looks like the hf_xet error a blocked Xet host raises."""


class _FromHfXet(RuntimeError):
    pass


_FromHfXet.__module__ = "hf_xet.errors"


# ---- describe() -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("exc", "kind"),
    [
        (XetAuthenticationError("blocked"), "network"),
        (_FromHfXet("data processing error"), "network"),
        (RuntimeError("a bug"), "other"),
        (ValueError("a bug"), "other"),
    ],
    ids=["xet-class-name", "hf_xet-module", "plain-runtime-error", "value-error"],
)
def test_describe_classifies_xet_errors_as_network(exc: BaseException, kind: str) -> None:
    assert hf_fetch_child.describe(exc)["kind"] == kind


def test_describe_keeps_disk_and_http_ahead_of_the_xet_rule() -> None:
    class XetDisk(OSError):
        pass

    line = hf_fetch_child.describe(XetDisk(errno.ENOSPC, "full"))

    assert line["kind"] == "disk"


# ---- fallback on a zero-byte child failure ----------------------------------------------


XET_CHILD = (
    "import json, sys\n"
    "from podcast_mcp.util import hf_fetch_child\n"
    "class XetAuthenticationError(Exception): pass\n"
    "line = hf_fetch_child.describe(XetAuthenticationError('blocked host'))\n"
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
    monkeypatch.setattr(model_manifest, "_cache_bytes", lambda *_a: 0)

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


def test_a_xet_error_after_bytes_is_the_network_failure_and_never_falls_back(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls = _hub(monkeypatch, tmp_path / "snap")
    _stub(monkeypatch, XET_CHILD)
    sizes = iter([0])
    monkeypatch.setattr(model_manifest, "_cache_bytes", lambda *_a: next(sizes, 7))

    with pytest.raises(HubChildError) as raised:
        download_pinned_snapshot(_payload_pin(), tmp_path / "hub", on_progress=lambda _p: None)

    failure = classify(raised.value, label="Whisper tiny.en", fix="podcast bootstrap")
    assert failure is not None
    assert failure.kind == "network"
    assert "Couldn't reach" in failure.plain
    assert raised.value.bytes_seen == 7
    assert calls == []


def test_a_child_error_before_bytes_carries_zero_bytes_seen(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    payload = {"error": "E", "message": "m", "kind": "http", "status": 403}
    _stub(monkeypatch, f"import json,sys; print(json.dumps({payload!r})); sys.exit(1)")
    monkeypatch.setattr(model_manifest, "_cache_bytes", lambda *_a: 0)

    with pytest.raises(HubChildError) as raised:
        download_pinned_snapshot(PIN, tmp_path / "hub", on_progress=lambda _p: None)

    assert raised.value.bytes_seen == 0


def test_a_child_that_dies_after_bytes_carries_the_bytes_seen(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _stub(monkeypatch, "import os; os._exit(9)")
    sizes = iter([0])
    monkeypatch.setattr(model_manifest, "_cache_bytes", lambda *_a: next(sizes, 9))

    with pytest.raises(HubChildError) as raised:
        download_pinned_snapshot(PIN, tmp_path / "hub", on_progress=lambda _p: None)

    assert raised.value.bytes_seen == 9


@pytest.mark.parametrize(
    "payload",
    [
        {"error": "GatedRepoError", "status": 403, "message": "m", "kind": "http"},
        {"error": "OSError", "status": None, "message": "m", "kind": "disk", "errno": 28},
    ],
    ids=["http-403", "disk-enospc"],
)
def test_http_and_disk_errors_before_bytes_do_not_fall_back(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, payload: dict[str, Any]
) -> None:
    calls = _hub(monkeypatch, tmp_path / "snap")
    _stub(monkeypatch, f"import json,sys; print(json.dumps({payload!r})); sys.exit(1)")
    monkeypatch.setattr(model_manifest, "_cache_bytes", lambda *_a: 0)

    with pytest.raises(HubChildError) as raised:
        download_pinned_snapshot(PIN, tmp_path / "hub", on_progress=lambda _p: None)

    assert raised.value.kind == payload["kind"]
    assert calls == []


def test_a_pin_mismatch_error_does_not_fall_back(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls = _hub(monkeypatch, tmp_path / "snap")
    _stub(monkeypatch, "pass")

    def watch(*_a: object) -> Path:
        exc = HubChildError("other", "the pin does not match")
        exc.kind = "pin_mismatch"
        raise exc

    monkeypatch.setattr(model_manifest, "_watch_child", watch)

    with pytest.raises(HubChildError):
        download_pinned_snapshot(PIN, tmp_path / "hub", on_progress=lambda _p: None)

    assert calls == []


def test_cancel_during_the_fallback_propagates_and_restores_the_hub(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls = _hub(monkeypatch, tmp_path / "snap", report=10)
    _stub(monkeypatch, XET_CHILD)
    monkeypatch.setattr(model_manifest, "_cache_bytes", lambda *_a: 0)

    def sink(progress: DownloadProgress) -> None:
        if progress.bytes > 0:
            raise CancelledProgress("cancel")

    with pytest.raises(CancelledProgress):
        download_pinned_snapshot(_payload_pin(), tmp_path / "hub", on_progress=sink)

    assert len(calls) == 1
    assert model_manifest._plain_http_depth == 0
    assert not (tmp_path / "snap" / "model.bin").exists()


def test_the_fallback_progress_starts_at_zero_and_never_goes_backwards(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _hub(monkeypatch, tmp_path / "snap", report=40)
    _stub(monkeypatch, XET_CHILD)
    monkeypatch.setattr(model_manifest, "_cache_bytes", lambda *_a: 0)
    events: list[int] = []

    download_pinned_snapshot(
        _payload_pin(), tmp_path / "hub", on_progress=lambda p: events.append(p.bytes)
    )

    assert events[0] == 0
    assert events == sorted(events)
    assert events[-1] == 40


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
