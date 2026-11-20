"""Bound the exact case 15 context comparison to a fixed outcome."""

from __future__ import annotations

import hashlib
import json
import os
from contextlib import suppress
from datetime import datetime, timedelta
from pathlib import Path

from browser_public_report import project

PINNED = {
    "neighbor": (2, "3496fb078d0fa8a2d126ea931ad9aabc8829f0c190b1326a0d3e763316faa401"),
    "isolated": (1, "33552fae1550f8d5272bf3bd372ad7e6e91712b6a330074e98b10b6b685d2a89"),
}


def source_tests(suites: list) -> list[tuple[list, dict]]:
    rows = []
    for suite in suites:
        for spec in suite["specs"]:
            for test in spec["tests"]:
                rows.append(
                    (
                        [spec["id"], spec["file"], spec["line"], spec["column"], test["projectId"]],
                        test,
                    )
                )
        rows.extend(source_tests(suite.get("suites", [])))
    return rows


def outcome(raw: dict, scope: str) -> str | None:
    report = project(raw)
    if report["global_error_count"]:
        return None
    rows = source_tests(raw["suites"])
    count, digest = PINNED[scope]
    encoded = json.dumps([row for row, _ in rows], separators=(",", ":")).encode()
    if len(rows) != count or hashlib.sha256(encoded).hexdigest() != digest:
        return None
    tests = [spec["tests"][0] for spec in report["suites"][0]["specs"]]
    if any(
        test["expectedStatus"] != "passed"
        or len(test["results"]) != 1
        or test["results"][0]["retry"] != 0
        for test in tests
    ):
        return None
    if count == 2:
        neighbor = tests[0]
        if neighbor["status"] != "expected" or neighbor["results"][0]["status"] != "passed":
            return None
        first, second = (raw_test["results"][0] for _, raw_test in rows)
        start = datetime.fromisoformat(first["startTime"])
        after = datetime.fromisoformat(second["startTime"])
        duration = neighbor["results"][0]["duration"]
        if start + timedelta(milliseconds=duration) > after:
            return None
    case = tests[-1]
    attempt = case["results"][0]["status"]
    if case["status"] == "expected" and attempt == "passed":
        return "passed"
    if case["status"] == "unexpected" and attempt in {"failed", "timedOut"}:
        return "failed"
    return None


def main() -> None:
    with suppress(OSError, TypeError, ValueError, KeyError, RecursionError, OverflowError):
        scope = os.environ["CASE_CONTEXT"]
        if scope not in PINNED:
            return
        raw_path = Path(f"gui/web/playwright-report/neighbor-{scope}.json")
        receipt = Path(os.environ["BROWSER_CAPTURE_RECEIPT"])
        if (
            receipt.read_text(encoding="utf-8").strip()
            != f"{os.environ['GITHUB_RUN_ID']} {os.environ['GITHUB_RUN_ATTEMPT']}"
            or raw_path.stat().st_mtime_ns < receipt.stat().st_mtime_ns
        ):
            return
        result = outcome(json.loads(raw_path.read_text(encoding="utf-8")), scope)
        if result is not None:
            with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as stream:
                stream.write(f"case_outcome={result}\n")


if __name__ == "__main__":
    main()
