"""#1998: a real Systran/faster-whisper-tiny.en download moves the bar and Cancel bites.

``e2e_real`` and gated on ``PODCAST_TEST_NETWORK=1``: it downloads the pinned 78 MB
snapshot from the real Hub on a default install (``hf_xet`` present, no
``HF_HUB_DISABLE_XET``), so the code under test must pick plain HTTP itself. Run with
``PODCAST_TEST_NETWORK=1 uv run pytest --no-cov -q -m e2e_real tests/test_hf_real_tiny.py``.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from tests.polling import wait_for

from podcast_mcp.engines.models.whisper import WHISPER_PINS
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


def _bytes_on_disk(root: Path) -> int:
    return sum(p.stat().st_size for p in root.rglob("*") if p.is_file() and not p.is_symlink())


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
    assert totals == {78_090_594}
    assert events[-1] == 78_090_594


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
