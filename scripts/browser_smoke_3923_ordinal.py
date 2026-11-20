"""Emit a fixed first-failure ordinal for one pinned smoke catalogue."""

from __future__ import annotations

import hashlib
import json
import os
from contextlib import suppress
from pathlib import Path

from browser_public_report import project

CATALOGUE = "8def7d1789b6f289b28efb1ab48209d76f97d45ebcde9a3716a3aca727a4746e"
CASE_COUNT = 42


def catalogue_rows(suites: list) -> list[list[object]]:
    rows = []
    for suite in suites:
        for spec in suite["specs"]:
            for test in spec["tests"]:
                rows.append(
                    [spec["id"], spec["file"], spec["line"], spec["column"], test["projectId"]]
                )
        rows.extend(catalogue_rows(suite.get("suites", [])))
    return rows


def ordinal(raw: dict) -> int | None:
    safe = project(raw)
    if safe["global_error_count"]:
        return None
    rows = catalogue_rows(raw["suites"])
    encoded = json.dumps(rows, separators=(",", ":")).encode()
    if len(rows) != CASE_COUNT or hashlib.sha256(encoded).hexdigest() != CATALOGUE:
        return None
    tests = safe["suites"][0]["specs"]
    for spec in tests:
        case = spec["tests"][0]
        attempts = case["results"]
        if [attempt["retry"] for attempt in attempts] != list(range(len(attempts))):
            return None
    for spec in tests:
        case = spec["tests"][0]
        attempts = case["results"]
        if (
            case["status"] == "unexpected"
            and case["expectedStatus"] == "passed"
            and attempts
            and attempts[-1]["status"] in {"failed", "timedOut"}
        ):
            return spec["case_id"]
    return None


def main() -> None:
    if os.environ.get("SHARECUT_3923_SMOKE") != "true":
        return
    with suppress(OSError, ValueError, TypeError, KeyError, RecursionError, OverflowError):
        raw_path = Path("gui/web/playwright-report/main-smoke.json")
        receipt = Path(os.environ["BROWSER_CAPTURE_RECEIPT"])
        run_attempt = f"{os.environ['GITHUB_RUN_ID']} {os.environ['GITHUB_RUN_ATTEMPT']}"
        if (
            receipt.read_text(encoding="utf-8").strip() != run_attempt
            or raw_path.stat().st_mtime_ns < receipt.stat().st_mtime_ns
        ):
            return
        case = ordinal(json.loads(raw_path.read_text(encoding="utf-8")))
        if case is not None:
            with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as stream:
                stream.write(f"case_ordinal={case}\n")


if __name__ == "__main__":
    main()
