from __future__ import annotations

import argparse
import json
import math
import os
import xml.etree.ElementTree as ET
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

AREA_TITLES = {
    "python": "Python",
    "vitest": "Vitest",
    "main-e2e": "Main e2e",
    "compat-e2e": "Compat",
    "stories": "Stories",
}


@dataclass(frozen=True)
class TestAreaSummary:
    area: str
    label: str | None
    logical_tests: int
    status_counts: Mapping[str, int]
    summed_duration_ms: float
    duration_basis: str
    missing_duration_count: int


@dataclass(frozen=True)
class UnavailableSummary:
    area: str
    label: str | None
    reason: str


Summary = TestAreaSummary | UnavailableSummary


class UnrecognizedReport(ValueError):
    pass


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _duration_ms(value: object, multiplier: float = 1.0) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        duration = float(value) * multiplier
    except ValueError:
        return None
    if not math.isfinite(duration) or duration < 0:
        return None
    return duration


def _count_status(counts: dict[str, int], status: str) -> None:
    counts[status] = counts.get(status, 0) + 1


def parse_junit(path: Path, area: str, label: str | None) -> TestAreaSummary:
    root = ET.parse(path).getroot()
    if _local_name(root.tag) not in {"testsuite", "testsuites"}:
        raise UnrecognizedReport
    cases = [node for node in root.iter() if _local_name(node.tag) == "testcase"]
    statuses: dict[str, int] = {}
    duration_ms = 0.0
    missing_durations = 0

    for case in cases:
        child_names = {_local_name(child.tag) for child in case}
        if "error" in child_names:
            status = "errors"
        elif "failure" in child_names:
            status = "failed"
        elif "skipped" in child_names:
            status = "skipped"
        else:
            status = "passed"
        _count_status(statuses, status)
        elapsed = _duration_ms(case.attrib.get("time"), 1000)
        if elapsed is None:
            missing_durations += 1
        else:
            duration_ms += elapsed

    return TestAreaSummary(
        area,
        label,
        len(cases),
        statuses,
        duration_ms,
        "JUnit testcase durations",
        missing_durations,
    )


def _load_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def parse_vitest(path: Path, area: str, label: str | None) -> TestAreaSummary:
    report = _load_json(path)
    if not isinstance(report, dict) or not isinstance(report.get("testResults"), list):
        raise UnrecognizedReport

    statuses: dict[str, int] = {}
    duration_ms = 0.0
    missing_durations = 0
    logical_tests = 0
    for suite in report["testResults"]:
        if not isinstance(suite, dict) or not isinstance(suite.get("assertionResults"), list):
            raise UnrecognizedReport
        for assertion in suite["assertionResults"]:
            if not isinstance(assertion, dict) or not isinstance(assertion.get("status"), str):
                raise UnrecognizedReport
            status = assertion["status"]
            if status not in {"passed", "failed", "skipped", "todo", "pending"}:
                status = "unknown"
            _count_status(statuses, status)
            logical_tests += 1
            elapsed = _duration_ms(assertion.get("duration"))
            if elapsed is None:
                missing_durations += 1
            else:
                duration_ms += elapsed

    return TestAreaSummary(
        area,
        label,
        logical_tests,
        statuses,
        duration_ms,
        "Vitest assertion durations",
        missing_durations,
    )


def parse_playwright(path: Path, area: str, label: str | None) -> TestAreaSummary:
    report = _load_json(path)
    if not isinstance(report, dict) or not isinstance(report.get("suites"), list):
        raise UnrecognizedReport

    statuses: dict[str, int] = {}
    duration_ms = 0.0
    missing_durations = 0
    logical_tests = 0
    status_map = {
        "expected": "passed",
        "unexpected": "failed",
        "flaky": "flaky",
        "skipped": "skipped",
    }

    def visit(suites: list[object]) -> None:
        nonlocal duration_ms, logical_tests, missing_durations
        for suite in suites:
            if not isinstance(suite, dict):
                raise UnrecognizedReport
            specs = suite.get("specs")
            nested = suite.get("suites", [])
            if not isinstance(specs, list) or not isinstance(nested, list):
                raise UnrecognizedReport
            for spec in specs:
                if not isinstance(spec, dict) or not isinstance(spec.get("tests"), list):
                    raise UnrecognizedReport
                for test in spec["tests"]:
                    if not isinstance(test, dict) or not isinstance(test.get("status"), str):
                        raise UnrecognizedReport
                    _count_status(statuses, status_map.get(test["status"], "unknown"))
                    logical_tests += 1
                    results = test.get("results")
                    if not isinstance(results, list):
                        raise UnrecognizedReport
                    if not results:
                        missing_durations += 1
                    for result in results:
                        if not isinstance(result, dict):
                            raise UnrecognizedReport
                        elapsed = _duration_ms(result.get("duration"))
                        if elapsed is None:
                            missing_durations += 1
                        else:
                            duration_ms += elapsed
            visit(nested)

    visit(report["suites"])
    return TestAreaSummary(
        area,
        label,
        logical_tests,
        statuses,
        duration_ms,
        "Playwright attempt durations",
        missing_durations,
    )


def _status_text(counts: Mapping[str, int]) -> str:
    order = ("passed", "failed", "errors", "flaky", "skipped", "todo", "pending", "unknown")
    entries = [f"{status}: {counts[status]}" for status in order if status in counts]
    return ", ".join(entries) if entries else "no tests"


def _display_area(summary: Summary) -> str:
    title = AREA_TITLES[summary.area]
    if summary.label:
        title = f"{title} ({summary.label})"
    return title.replace("|", "\\|")


def render(summary: Summary) -> str:
    partial = ""
    if isinstance(summary, UnavailableSummary):
        row = f"| {_display_area(summary)} | N/A | N/A | unavailable: {summary.reason} |"
    else:
        duration = f"{summary.summed_duration_ms / 1000:.1f} s"
        missing = ""
        if summary.missing_duration_count:
            missing = f" ({summary.missing_duration_count} duration values unavailable)"
        if summary.status_counts.get("unknown"):
            partial = (
                f"\nPartial status data: {summary.status_counts['unknown']} logical test statuses "
                "were not recognized.\n"
            )
        row = (
            f"| {_display_area(summary)} | {summary.logical_tests} | "
            f"{_status_text(summary.status_counts)} | "
            f"summed {summary.duration_basis}: {duration}{missing} |"
        )
    return (
        "### Test area summary\n\n"
        "| Area | Logical tests | Final statuses | Summed test duration |\n"
        "| --- | ---: | --- | --- |\n"
        f"{row}\n\n"
        f"{partial}"
        "Summed test and retry durations can overlap when tests run in parallel. "
        "They are not job wall time. Missing report data is shown as unavailable.\n"
    )


def _unavailable_reason(error: Exception) -> str:
    if isinstance(error, FileNotFoundError):
        return "report file missing"
    if isinstance(error, ET.ParseError | json.JSONDecodeError | UnrecognizedReport):
        return "report malformed or has an unknown shape"
    if isinstance(error, OSError | UnicodeDecodeError):
        return "report could not be read"
    return "report could not be summarized"


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("format", choices=("junit", "vitest", "playwright"))
    parser.add_argument("--area", choices=tuple(AREA_TITLES), required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--label")
    parser.add_argument("--output", type=Path, default=os.environ.get("GITHUB_STEP_SUMMARY"))
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    parsers = {"junit": parse_junit, "vitest": parse_vitest, "playwright": parse_playwright}
    try:
        summary: Summary = parsers[args.format](args.report, args.area, args.label)
    except (
        OSError,
        UnicodeDecodeError,
        ET.ParseError,
        json.JSONDecodeError,
        ValueError,
        TypeError,
    ) as error:
        summary = UnavailableSummary(args.area, args.label, _unavailable_reason(error))
    content = render(summary)
    if args.output:
        with Path(args.output).open("a", encoding="utf-8") as output:
            output.write(content)
    else:
        print(content, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
