"""Emit a fixed failure-phase ordinal for case 15 in one pinned smoke catalogue."""

from __future__ import annotations

import hashlib
import json
import os
from contextlib import suppress
from pathlib import Path

from browser_public_report import project

CATALOGUE = "8def7d1789b6f289b28efb1ab48209d76f97d45ebcde9a3716a3aca727a4746e"
CASE_COUNT = 42
CASE = 15
ANNOTATION = "sharecut.case-15-failure.v1"
PHASES = (
    "fixture-setup",
    "open-home",
    "create-episode",
    "wait-record-invite",
    "dismiss-record-invite",
    "open-prepare",
    "choose-audio",
    "import-audio",
    "open-host-edit",
    "wait-imported-clip",
    "open-review-invite",
    "choose-editor-role",
    "copy-editor-link",
    "refresh-mix",
    "wait-ui-mix-recovery",
    "create-local-editor-role",
    "open-local-editor-role",
    "observe-initial-manifest",
    "post-editor-comment",
    "capture-before-reload",
    "reload-guest",
    "assert-derived-save-preserved-history",
    "reopen-review",
    "check-restored-comment",
    "undo-editor-comment",
    "redo-editor-comment",
    "cleanup-only",
)


def catalogue_tests(suites: list) -> list[tuple[list[object], dict]]:
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
        rows.extend(catalogue_tests(suite.get("suites", [])))
    return rows


def failed_phase(raw: dict) -> int | None:
    safe = project(raw)
    if safe["global_error_count"]:
        return None
    catalogue = catalogue_tests(raw["suites"])
    rows = [row for row, _ in catalogue]
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
            if spec["case_id"] != CASE:
                return None
            first_failure = next(
                index
                for index, attempt in enumerate(attempts)
                if attempt["status"] in {"failed", "timedOut"}
            )
            annotations = catalogue[CASE - 1][1]["results"][first_failure].get("annotations")
            if not isinstance(annotations, list) or any(
                not isinstance(row, dict) for row in annotations
            ):
                return None
            markers = [row for row in annotations if row.get("type") == ANNOTATION]
            if len(markers) == 1 and markers[0].get("description") in PHASES:
                return PHASES.index(markers[0]["description"]) + 1
            return None
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
        phase = failed_phase(json.loads(raw_path.read_text(encoding="utf-8")))
        if phase is not None:
            with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as stream:
                stream.write(f"phase_ordinal={phase}\n")


if __name__ == "__main__":
    main()
