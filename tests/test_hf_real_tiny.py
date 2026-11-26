"""#1998: a real Systran/faster-whisper-tiny.en download moves the bar and Cancel bites.

``e2e_real`` and gated on ``PODCAST_TEST_NETWORK=1``: it downloads the pinned 78 MB
snapshot from the real Hub on a default install (``hf_xet`` present, no
``HF_HUB_DISABLE_XET``). The child-process tests run the Xet child
(``util/hf_fetch_child.py``); the in-process tests set ``PODCAST_HF_IN_PROCESS=1`` so the code
under test picks plain HTTP itself. Run with
``PODCAST_TEST_NETWORK=1 uv run pytest --no-cov -q -m e2e_real tests/test_hf_real_tiny.py``.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest
from tests.polling import wait_for

from podcast_mcp.engines.models.whisper import WHISPER_PINS
from podcast_mcp.util import model_manifest, process
from podcast_mcp.util.asset_sources import DownloadProgress
from podcast_mcp.util.model_manifest import download_pinned_snapshot
from podcast_mcp.util.progress import CancelledProgress

pytestmark = [
    pytest.mark.e2e_real,
    pytest.mark.timeout(300),
    pytest.mark.skipif(
        os.environ.get("PODCAST_TEST_NETWORK") != "1",
        reason="real Hugging Face download; set PODCAST_TEST_NETWORK=1",
    ),
]

MIB = 1024 * 1024
CANCEL_AT_BYTES = 5 * MIB
ON_DISK_LIMIT_BYTES = 10 * MIB
TINY_MODEL_BYTES = 78_090_594
CHILD_KILL_WITHIN_SEC = 3.0
CHILD_CANCEL_AT_BYTES = 8 * MIB  # past the ~2.5 MB of small files: model.bin has started
CHILD_ON_DISK_LIMIT_BYTES = TINY_MODEL_BYTES
"""Cancel must beat the finish: model.bin arrives in one ~70 ms burst after ~3 s of fetching."""
CHILD_POLL_SEC = 0.02


def _bytes_on_disk(root: Path) -> int:
    return sum(p.stat().st_size for p in root.rglob("*") if p.is_file() and not p.is_symlink())


@pytest.fixture
def in_process(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_HF_IN_PROCESS", "1")


@pytest.fixture
def xet_child(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("PODCAST_HF_IN_PROCESS", raising=False)
    # A fresh Xet chunk cache (it lives under HF_HOME): a warm one finishes 78 MB inside one
    # poll, so Cancel would land after the download is over.
    monkeypatch.setenv("HF_HOME", str(tmp_path / "hf-home"))


@pytest.mark.usefixtures("xet_child")
def test_child_progress_reaches_the_total_in_several_steps(tmp_path: Path) -> None:
    pin = WHISPER_PINS["tiny.en"]
    events: list[int] = []

    def sink(progress: DownloadProgress) -> None:
        assert progress.total == TINY_MODEL_BYTES
        events.append(progress.bytes)

    _, mismatch = download_pinned_snapshot(pin, tmp_path, on_progress=sink)

    assert mismatch is None
    assert events == sorted(events), "bytes must never decrease"
    assert events[0] == 0
    assert events[-1] == TINY_MODEL_BYTES
    assert len(set(events)) >= 3, f"bar never moved between 0 and total: {events}"


@pytest.mark.usefixtures("xet_child")
def test_child_cancel_kills_the_transfer_within_seconds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(model_manifest, "_POLL_SEC", CHILD_POLL_SEC)
    pin = WHISPER_PINS["tiny.en"]
    children: list[process.Child] = []
    real_popen = process.popen

    def recording(*args: object, **kwargs: object) -> process.Child:
        child = real_popen(*args, **kwargs)  # type: ignore[arg-type]
        children.append(child)
        return child

    monkeypatch.setattr(process, "popen", recording)
    cancelled_at: list[float] = []

    def sink(progress: DownloadProgress) -> None:
        if progress.bytes >= CHILD_CANCEL_AT_BYTES:
            cancelled_at.append(time.monotonic())
            raise CancelledProgress("cancel")

    with pytest.raises(CancelledProgress):
        download_pinned_snapshot(pin, tmp_path, on_progress=sink)

    assert time.monotonic() - cancelled_at[0] < CHILD_KILL_WITHIN_SEC
    (child,) = children
    assert child.pid is not None
    assert wait_for(lambda: not process.pid_is_alive(child.pid or 0), timeout=CHILD_KILL_WITHIN_SEC)
    at_return = _bytes_on_disk(tmp_path)
    assert at_return < CHILD_ON_DISK_LIMIT_BYTES
    stable = wait_for(lambda: _bytes_on_disk(tmp_path) != at_return, timeout=1.0)
    assert not stable, "files kept growing after Cancel"


@pytest.mark.usefixtures("in_process")
def test_progress_moves_while_model_bin_downloads(tmp_path: Path) -> None:
    pin = WHISPER_PINS["tiny.en"]
    events: list[int] = []
    totals: set[int | None] = set()

    def sink(progress: DownloadProgress) -> None:
        events.append(progress.bytes)
        totals.add(progress.total)

    _, mismatch = download_pinned_snapshot(pin, tmp_path, on_progress=sink)

    assert mismatch is None
    assert len(events) >= 20
    assert events == sorted(events), "bytes must never decrease"
    before_final = events[:-1]
    distinct_big = {b for b in before_final if b > 3 * MIB}
    assert len(distinct_big) >= 5, f"model.bin progress stuck: {sorted(set(events))[:12]}"
    assert totals == {TINY_MODEL_BYTES}
    assert events[-1] == TINY_MODEL_BYTES


@pytest.mark.usefixtures("in_process")
def test_cancel_stops_the_transfer_within_a_few_mib(tmp_path: Path) -> None:
    pin = WHISPER_PINS["tiny.en"]

    def sink(progress: DownloadProgress) -> None:
        if progress.bytes >= CANCEL_AT_BYTES:
            raise CancelledProgress("cancel")

    with pytest.raises(CancelledProgress):
        download_pinned_snapshot(pin, tmp_path, on_progress=sink)

    # The download runs in-process, so it is over on return; check that, then that nothing
    # keeps writing for a 1 s window (state check, no fixed sleep).
    at_return = _bytes_on_disk(tmp_path)
    assert at_return < ON_DISK_LIMIT_BYTES
    stable = wait_for(lambda: _bytes_on_disk(tmp_path) != at_return, timeout=1.0)
    assert not stable, "files kept growing after Cancel"
    assert _bytes_on_disk(tmp_path) < ON_DISK_LIMIT_BYTES
