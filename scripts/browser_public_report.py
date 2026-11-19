"""Project untrusted browser diagnostics into a string-free case/timing inventory."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import tempfile
from pathlib import Path

FINAL_STATUSES = frozenset({"expected", "unexpected", "flaky", "skipped"})
ATTEMPT_STATUSES = frozenset({"passed", "failed", "timedOut", "skipped", "interrupted"})
FUNCTIONAL_CASE_FILE = "stage-shell.spec.ts"
FUNCTIONAL_CASE_TITLE = "an Editor's comment survives a normal reload-derived save and Undo/Redo restores only that comment"
FUNCTIONAL_OUTCOMES = frozenset(
    {"passed", "failed", "timed_out", "interrupted", "flaky", "skipped", "unknown"}
)


def functional_case_outcome(source: dict) -> str:
    matches = []

    def visit(suites: list) -> None:
        for suite in suites:
            for spec in suite["specs"]:
                if (
                    spec.get("file") == FUNCTIONAL_CASE_FILE
                    and spec.get("title") == FUNCTIONAL_CASE_TITLE
                ):
                    matches.extend(spec["tests"])
            visit(suite.get("suites", []))

    visit(source["suites"])
    if len(matches) != 1 or source.get("errors"):
        return "unknown"
    test = matches[0]
    results = test["results"]
    if not results:
        return "unknown"
    statuses = [result["status"] for result in results]
    final = test["status"]
    if final == "skipped" and statuses == ["skipped"]:
        return "skipped"
    if test["expectedStatus"] != "passed":
        return "unknown"
    if final == "expected" and all(status == "passed" for status in statuses):
        return "passed"
    if (
        final == "flaky"
        and statuses[-1] == "passed"
        and any(status in {"failed", "timedOut"} for status in statuses[:-1])
    ):
        return "flaky"
    if final == "unexpected":
        return {"failed": "failed", "timedOut": "timed_out", "interrupted": "interrupted"}.get(
            statuses[-1], "unknown"
        )
    return "unknown"


FUNCTIONAL_PHASES = (
    "never_started",
    "entered",
    "host_ready",
    "share_ready",
    "editor_ready",
    "composer_ready",
    "comment_saved",
    "derived_checked",
    "review_reopened",
    "comment_observed",
    "undo_clicked",
    "visible_removal",
    "persistence_wait",
    "undo_checked",
    "body_complete",
)
PHASE_ANNOTATION = "sharecut.functional-last-completed.v1"


def functional_case_phase(source: dict) -> str:
    matches = []

    def visit(suites: list) -> None:
        for suite in suites:
            for spec in suite["specs"]:
                if (
                    spec.get("file") == FUNCTIONAL_CASE_FILE
                    and spec.get("title") == FUNCTIONAL_CASE_TITLE
                ):
                    matches.extend(spec["tests"])
            visit(suite.get("suites", []))

    visit(source["suites"])
    if len(matches) != 1 or source.get("errors"):
        return "unknown"
    test = matches[0]
    if test["expectedStatus"] not in {"passed", "skipped"}:
        return "unknown"
    results = test["results"]
    if not results or [r["retry"] for r in results] != list(range(len(results))):
        return "unknown"
    chosen = next(
        (r for r in results if r["status"] in {"failed", "timedOut", "interrupted"}), results[-1]
    )
    if test["expectedStatus"] == "skipped" and chosen["status"] != "skipped":
        return "unknown"
    annotations = chosen.get("annotations")
    if not isinstance(annotations, list):
        return "unknown"
    markers = [
        a
        for a in annotations
        if isinstance(a, dict)
        and isinstance(a.get("type"), str)
        and a["type"].startswith("sharecut.functional-last-completed.")
    ]
    if len(markers) != 1 or markers[0].get("type") != PHASE_ANNOTATION:
        return "unknown"
    phase = markers[0].get("description")
    if not isinstance(phase, str) or phase not in FUNCTIONAL_PHASES:
        return "unknown"
    if chosen["status"] == "interrupted":
        return "unknown"
    if chosen["status"] == "passed" and phase != "body_complete":
        return "unknown"
    if chosen["status"] == "skipped" and phase != "never_started":
        return "unknown"
    return phase


def write_phase_output(phase: str) -> None:
    if phase not in (*FUNCTIONAL_PHASES, "unknown"):
        return
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        try:
            with Path(output).open("a", encoding="utf-8") as stream:
                stream.write(f"functional_phase={phase}\n")
        except OSError:
            pass


def write_functional_output(outcome: str) -> None:
    if not isinstance(outcome, str) or outcome not in FUNCTIONAL_OUTCOMES:
        return
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        try:
            with Path(output).open("a", encoding="utf-8") as stream:
                stream.write(f"functional_outcome={outcome}\n")
        except OSError:
            pass


class InvalidReport(ValueError):
    pass


def _mapping(value: object) -> dict:
    if not isinstance(value, dict):
        raise InvalidReport
    return value


def _sequence(value: object) -> list:
    if not isinstance(value, list):
        raise InvalidReport
    return value


def _integer(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 2**53:
        raise InvalidReport
    return value


def _status(value: object, choices: frozenset[str]) -> str:
    if not isinstance(value, str) or value not in choices:
        raise InvalidReport
    return value


def project(report: object) -> dict:
    """Retain every logical test/attempt, copying no free-form report strings."""
    source = _mapping(report)
    specs = []

    def visit(suites: object) -> None:
        for suite_value in _sequence(suites):
            suite = _mapping(suite_value)
            for spec_value in _sequence(suite.get("specs")):
                spec = _mapping(spec_value)
                for test_value in _sequence(spec.get("tests")):
                    test = _mapping(test_value)
                    attempts = []
                    for result_value in _sequence(test.get("results")):
                        result = _mapping(result_value)
                        attempt = {
                            "status": _status(result.get("status"), ATTEMPT_STATUSES),
                            "retry": _integer(result.get("retry")),
                        }
                        duration = result.get("duration")
                        if duration is not None:
                            if (
                                isinstance(duration, bool)
                                or not isinstance(duration, int | float)
                                or not math.isfinite(duration)
                                or not 0 <= duration <= 2**53
                            ):
                                raise InvalidReport
                            attempt["duration"] = duration
                        attempts.append(attempt)
                    specs.append(
                        {
                            "case_id": len(specs) + 1,
                            "tests": [
                                {
                                    "status": _status(test.get("status"), FINAL_STATUSES),
                                    "expectedStatus": _status(
                                        test.get("expectedStatus"), ATTEMPT_STATUSES
                                    ),
                                    "results": attempts,
                                }
                            ],
                        }
                    )
            visit(suite.get("suites", []))

    visit(source.get("suites"))
    return {
        "format": "sharecut-browser-public-v1",
        "global_error_count": len(_sequence(source.get("errors", []))),
        "suites": [{"specs": specs, "suites": []}],
    }


def write_projection(source: Path, output: Path, receipt: Path) -> tuple[str, str]:
    if source.resolve() == output.resolve():
        raise InvalidReport
    # A failed read must not leave an earlier projection available for upload.
    output.unlink(missing_ok=True)
    run = os.environ.get("GITHUB_RUN_ID", "")
    attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "")
    if (
        not re.fullmatch(r"[0-9]+", run)
        or not re.fullmatch(r"[0-9]+", attempt)
        or receipt.read_text(encoding="utf-8").strip() != f"{run} {attempt}"
        or source.stat().st_mtime_ns < receipt.stat().st_mtime_ns
    ):
        raise InvalidReport
    with source.open(encoding="utf-8") as stream:
        raw = json.load(stream)
        public = project(raw)
        outcome = functional_case_outcome(raw)
        phase = functional_case_phase(raw)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=output.parent, delete=False
        ) as stream:
            temporary = stream.name
            json.dump(public, stream, allow_nan=False, indent=2)
            stream.write("\n")
        os.replace(temporary, output)
    finally:
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)

    return outcome, phase


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--capture-receipt", required=True, type=Path)
    args = parser.parse_args()
    try:
        outcome, phase = write_projection(args.report, args.output, args.capture_receipt)
        write_functional_output(outcome)
        write_phase_output(phase)
    except (OSError, ValueError, TypeError, RecursionError, OverflowError):
        print("Browser result projection unavailable; raw diagnostics withheld.")
        return 2
    print("Browser result projection ready; free-form diagnostics withheld.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
