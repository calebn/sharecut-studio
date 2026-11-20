import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "test_area_summary.py"


def _run_summary(
    tmp_path: Path,
    report_format: str,
    area: str,
    report_text: str | None,
    label: str | None = None,
) -> str:
    report = tmp_path / "report.data"
    if report_text is not None:
        report.write_text(report_text, encoding="utf-8")
    summary = tmp_path / "summary.md"
    command = [
        sys.executable,
        str(SCRIPT),
        report_format,
        "--area",
        area,
        "--report",
        str(report),
        "--output",
        str(summary),
    ]
    if label:
        command.extend(("--label", label))
    result = subprocess.run(
        command, check=False, capture_output=True, text=True, env=os.environ.copy()
    )
    assert result.returncode == 0, result.stderr
    return summary.read_text(encoding="utf-8")


def test_junit_summary_counts_case_nodes_once_and_labels_partial_time(tmp_path: Path) -> None:
    report = """<testsuites tests="90" time="99">
      <testsuite tests="90" time="98">
        <testsuite tests="2" time="1.5">
          <testcase name="kept" time="0.75" />
          <testcase name="skipped"><skipped /></testcase>
        </testsuite>
      </testsuite>
    </testsuites>"""

    output = _run_summary(tmp_path, "junit", "python", report)

    assert "| Python | 2 | passed: 1, skipped: 1 |" in output
    assert "summed JUnit testcase durations: 0.8 s (1 duration values unavailable)" in output
    assert "not job wall time" in output


def test_vitest_summary_counts_assertions_and_marks_unknown_status(tmp_path: Path) -> None:
    report = {
        "numTotalTests": 100,
        "testResults": [
            {
                "assertionResults": [
                    {"status": "passed", "duration": 120.5},
                    {"status": "failed", "duration": 35},
                    {"status": "future-status", "duration": 10},
                ]
            }
        ],
    }

    output = _run_summary(tmp_path, "vitest", "vitest", json.dumps(report))

    assert "| Vitest | 3 | passed: 1, failed: 1, unknown: 1 |" in output
    assert "Partial status data: 1 logical test statuses were not recognized." in output
    assert "summed Vitest assertion durations: 0.2 s" in output


def test_playwright_summary_counts_logical_tests_and_sums_retry_attempts(tmp_path: Path) -> None:
    report = {
        "suites": [
            {
                "specs": [
                    {
                        "tests": [
                            {
                                "status": "flaky",
                                "results": [{"duration": 100}, {"duration": 250}],
                            },
                            {"status": "skipped", "results": []},
                        ]
                    }
                ],
                "suites": [
                    {
                        "specs": [
                            {
                                "tests": [
                                    {
                                        "status": "expected",
                                        "results": [{"duration": 50}],
                                    }
                                ]
                            }
                        ]
                    }
                ],
            }
        ]
    }

    output = _run_summary(tmp_path, "playwright", "compat-e2e", json.dumps(report), "compat-webkit")

    assert "| Compat (compat-webkit) | 3 | passed: 1, flaky: 1, skipped: 1 |" in output
    assert "summed Playwright attempt durations: 0.4 s (1 duration values unavailable)" in output


def test_missing_report_is_unavailable_instead_of_zero_passed(tmp_path: Path) -> None:
    output = _run_summary(tmp_path, "junit", "python", None)

    assert "| Python | N/A | N/A | unavailable: report file missing |" in output
    assert "passed: 0" not in output


def test_malformed_report_is_unavailable_instead_of_zero_passed(tmp_path: Path) -> None:
    output = _run_summary(tmp_path, "vitest", "vitest", "not JSON")

    assert (
        "| Vitest | N/A | N/A | unavailable: report malformed or has an unknown shape |" in output
    )
    assert "passed: 0" not in output


def test_junit_with_unsupported_root_is_unavailable_instead_of_zero_passed(
    tmp_path: Path,
) -> None:
    output = _run_summary(tmp_path, "junit", "python", "<not-a-test-report />")

    assert (
        "| Python | N/A | N/A | unavailable: report malformed or has an unknown shape |" in output
    )
    assert "passed: 0" not in output
