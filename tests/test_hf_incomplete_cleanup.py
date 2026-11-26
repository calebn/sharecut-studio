"""A child fetch removes the Xet ``.incomplete`` partials it leaves behind (#1998)."""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

import pytest
from tests.polling import wait_for
from tests.test_hf_fetch_child import PIN, _payload_pin, _stub

from podcast_mcp.util import model_manifest, process
from podcast_mcp.util.asset_sources import DownloadProgress
from podcast_mcp.util.model_manifest import HubChildError, download_pinned_snapshot
from podcast_mcp.util.progress import CancelledProgress

SHA = "b" * 64


@pytest.fixture(autouse=True)
def _child_mode(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("PODCAST_HF_IN_PROCESS", raising=False)
    monkeypatch.setenv("HF_HOME", str(tmp_path / "home"))
    monkeypatch.setattr(model_manifest, "_POLL_SEC", 0.05)
    monkeypatch.setattr(model_manifest, "_dry_run_total", lambda *_a: 1000)


def _blobs(cache: Path, pin: model_manifest.PinnedSnapshot = PIN) -> Path:
    blobs = model_manifest._blobs_dir(pin, cache)
    blobs.mkdir(parents=True, exist_ok=True)
    return blobs


def _age(path: Path, seconds: float) -> None:
    then = time.time() - seconds
    os.utime(path, (then, then))


def _names(blobs: Path, suffix: str = ".incomplete") -> set[str]:
    return {p.name for p in blobs.iterdir() if p.name.endswith(suffix)}


def _writes_partial(go: Path, name: str, then: str) -> str:
    """Child code: write a partial in the repo's blobs dir, then ``then`` (a code snippet)."""
    return (
        "import json, pathlib, sys, threading\n"
        "cache = json.load(open(sys.argv[1]))['cache_dir']\n"
        f"blobs = pathlib.Path(cache) / 'models--{PIN.hf_repo.replace('/', '--')}' / 'blobs'\n"
        "blobs.mkdir(parents=True, exist_ok=True)\n"
        f"(blobs / {name!r}).write_bytes(b'x' * 100)\n"
        f"pathlib.Path({str(go)!r}).touch()\n" + then
    )


HANG = "threading.Event().wait(60)\n"


def test_cancel_removes_this_fetchs_partial_and_keeps_a_pre_existing_one(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cache = tmp_path / "hub"
    blobs = _blobs(cache)
    (blobs / f"{SHA}.old1.incomplete").write_bytes(b"older")
    go = tmp_path / "go"
    _stub(monkeypatch, _writes_partial(go, f"{SHA}.new1.incomplete", HANG))

    def sink(progress: DownloadProgress) -> None:
        if go.exists() and progress.bytes > 0:
            raise CancelledProgress("cancel")

    with pytest.raises(CancelledProgress):
        download_pinned_snapshot(PIN, cache, on_progress=sink)

    assert _names(blobs) == {f"{SHA}.old1.incomplete"}


def test_a_child_that_dies_without_a_result_leaves_none_of_its_partials(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cache = tmp_path / "hub"
    blobs = _blobs(cache)
    (blobs / f"{SHA}.old1.incomplete").write_bytes(b"older")
    _stub(
        monkeypatch,
        _writes_partial(tmp_path / "go", f"{SHA}.new1.incomplete", "import os; os._exit(9)\n"),
    )

    with pytest.raises(HubChildError):
        download_pinned_snapshot(PIN, cache, on_progress=lambda _p: None)

    assert _names(blobs) == {f"{SHA}.old1.incomplete"}


def test_a_child_that_reports_an_error_leaves_none_of_its_partials(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cache = tmp_path / "hub"
    blobs = _blobs(cache)
    payload = {"error": "ConnectError", "message": "m", "kind": "network"}
    _stub(
        monkeypatch,
        _writes_partial(
            tmp_path / "go",
            f"{SHA}.new1.incomplete",
            f"print(json.dumps({payload!r})); sys.exit(1)\n",
        ),
    )

    with pytest.raises(HubChildError):
        download_pinned_snapshot(PIN, cache, on_progress=lambda _p: None)

    assert _names(blobs) == set()


def test_a_fake_watch_that_is_cancelled_cleans_up_after_the_child_is_reaped(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cache = tmp_path / "hub"
    blobs = _blobs(cache)
    _stub(monkeypatch, "pass")

    def watch(*_a: object) -> Path:
        (blobs / f"{SHA}.new1.incomplete").write_bytes(b"x")
        raise CancelledProgress("cancel")

    monkeypatch.setattr(model_manifest, "_watch_child", watch)

    with pytest.raises(CancelledProgress):
        download_pinned_snapshot(PIN, cache, on_progress=lambda _p: None)

    assert _names(blobs) == set()


def test_a_successful_child_fetch_leaves_no_incomplete_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    pin = _payload_pin()
    cache = tmp_path / "hub"
    blobs = _blobs(cache, pin)
    snapshot = tmp_path / "snap"
    snapshot.mkdir()
    (snapshot / "model.bin").write_bytes(b"model")
    code = (
        "import json, pathlib, sys\n"
        "cache = json.load(open(sys.argv[1]))['cache_dir']\n"
        "blobs = pathlib.Path(cache) / 'models--acme--model' / 'blobs'\n"
        f"part = blobs / {SHA + '.r4nd.incomplete'!r}\n"
        "part.write_bytes(b'model')\n"
        f"part.rename(blobs / {SHA!r})\n"
        f"print(json.dumps({{'path': {str(snapshot)!r}}}))\n"
    )
    _stub(monkeypatch, code)

    path, _ = download_pinned_snapshot(pin, cache, on_progress=lambda _p: None)

    assert path == snapshot
    assert _names(blobs) == set()
    assert (blobs / SHA).read_bytes() == b"model"


def test_the_start_of_a_child_fetch_sweeps_only_old_xet_style_partials(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    pin = _payload_pin()
    cache = tmp_path / "hub"
    blobs = _blobs(cache, pin)
    other = _blobs(cache, model_manifest.PinnedSnapshot("acme/other", "c" * 40, ()))
    stale = blobs / f"{SHA}.stale1.incomplete"
    fresh = blobs / f"{SHA}.fresh1.incomplete"
    plain = blobs / f"{SHA}.incomplete"
    done = blobs / SHA
    elsewhere = other / f"{SHA}.stale1.incomplete"
    for path in (stale, fresh, plain, done, elsewhere):
        path.write_bytes(b"x")
    for path in (stale, plain, done, elsewhere):
        _age(path, 2 * 3600)
    snapshot = tmp_path / "snap"
    snapshot.mkdir()
    (snapshot / "model.bin").write_bytes(b"model")
    _stub(monkeypatch, f"import json; print(json.dumps({{'path': {str(snapshot)!r}}}))")

    download_pinned_snapshot(pin, cache)

    assert not stale.exists()
    assert wait_for(lambda: all(p.exists() for p in (fresh, plain, done, elsewhere)))


def test_the_partial_is_removed_only_after_the_cancelled_child_is_dead(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cache = tmp_path / "hub"
    blobs = _blobs(cache)
    go = tmp_path / "go"
    _stub(monkeypatch, _writes_partial(go, f"{SHA}.new1.incomplete", HANG))
    children: list[Any] = []
    real_popen = process.popen
    real_remove = model_manifest._remove_new_partials
    child_dead: list[bool] = []

    def recording(*args: Any, **kwargs: Any) -> Any:
        children.append(real_popen(*args, **kwargs))
        return children[-1]

    def spy(blobs_dir: Path, before: set[str]) -> None:
        child_dead.append(children[0].poll() is not None)
        real_remove(blobs_dir, before)

    monkeypatch.setattr(process, "popen", recording)
    monkeypatch.setattr(model_manifest, "_remove_new_partials", spy)

    def sink(progress: DownloadProgress) -> None:
        if go.exists():
            raise CancelledProgress("cancel")

    with pytest.raises(CancelledProgress):
        download_pinned_snapshot(PIN, cache, on_progress=sink)

    assert child_dead == [True]
    assert _names(blobs) == set()
