"""Fail unexpected skips in the in-process FFmpeg suite."""

from pathlib import Path

import pytest

_IN_PROCESS_SUITE = Path(__file__).with_name("test_ffmpeg_engine_in_process.py")


@pytest.hookimpl(wrapper=True, tryfirst=True)
def pytest_runtest_makereport(item: pytest.Item, call: pytest.CallInfo):
    report = yield
    if item.path == _IN_PROCESS_SUITE and report.skipped:
        detail = report.longreprtext
        report.outcome = "failed"
        report.longrepr = f"In-process FFmpeg coverage skipped during {call.when}: {detail}"
        if hasattr(report, "wasxfail"):
            del report.wasxfail
    return report
