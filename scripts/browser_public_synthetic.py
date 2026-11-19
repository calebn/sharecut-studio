"""Fabricated-only canaries for the draft diagnostics publication boundary."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

MODES = ("success", "failure-retry", "malformed", "stale")
MARKER = "FABRICATED_BROWSER_CANARY_ORDINARY_TEXT"
PINNED = {
    "scripts/private_browser_command.sh": "28dc0c5b15c3ab50c9dbdf0ad6d41bfa45081ed7f4b9ff8d81fe760a16dcc896",
    "scripts/browser_public_report.py": "4c1c192cc771cbc472eed419201cd08ab25aabd1cb378914a46dae76a030f0ef",
    "scripts/test_area_summary.py": "655156965f52460d32c98163b4126484d6dd4ca6c3b837bd80da9bd4741229f1",
}


def expected(mode: str) -> dict:
    tests = [("expected", [("passed", 0, 10)])]
    if mode == "failure-retry":
        tests = [
            ("unexpected", [("failed", 0, 20)]),
            ("flaky", [("failed", 0, 30), ("passed", 1, 40)]),
        ]
    return {
        "format": "sharecut-browser-public-v1",
        "global_error_count": 2 if mode == "failure-retry" else 0,
        "suites": [
            {
                "specs": [
                    {
                        "case_id": number,
                        "tests": [
                            {
                                "status": status,
                                "expectedStatus": "passed",
                                "results": [
                                    {"status": result, "retry": retry, "duration": duration}
                                    for result, retry, duration in attempts
                                ],
                            }
                        ],
                    }
                    for number, (status, attempts) in enumerate(tests, 1)
                ],
                "suites": [],
            }
        ],
    }


def paths() -> tuple[Path, Path, Path]:
    return (
        Path(os.environ["BROWSER_RAW_REPORT"]),
        Path(os.environ["SYNTHETIC_PUBLIC_REPORT"]),
        Path(os.environ["SYNTHETIC_SUMMARY"]),
    )


def prepare() -> None:
    root = Path(__file__).resolve().parents[1]
    for name, digest in PINNED.items():
        if hashlib.sha256((root / name).read_bytes()).hexdigest() != digest:
            raise ValueError
    raw, public, summary = paths()
    raw.parent.mkdir(parents=True, exist_ok=True)
    public.parent.mkdir(parents=True, exist_ok=True)
    public.write_text(MARKER, encoding="utf-8")
    summary.unlink(missing_ok=True)


def produce(mode: str) -> int:
    print(MARKER)
    print(f"::warning::{MARKER}", file=sys.stderr)
    for name in (
        "GITHUB_STEP_SUMMARY",
        "GITHUB_OUTPUT",
        "GITHUB_ENV",
        "GITHUB_PATH",
        "GITHUB_STATE",
    ):
        Path(os.environ[name]).write_text(f"canary={MARKER}\n", encoding="utf-8")
    raw, _, _ = paths()
    data = expected(mode)
    data["config"] = {"metadata": MARKER}
    data["errors"] = [{"message": MARKER}] * data["global_error_count"]
    data["suites"][0]["title"] = MARKER
    for spec in data["suites"][0]["specs"]:
        spec["title"] = MARKER
        for result in spec["tests"][0]["results"]:
            result["error"] = {"message": MARKER}
            result["attachments"] = [{"name": MARKER, "path": MARKER}]
    raw.write_text("{" + MARKER if mode == "malformed" else json.dumps(data))
    if mode == "stale":
        receipt_time = Path(os.environ["BROWSER_CAPTURE_RECEIPT"]).stat().st_mtime_ns
        os.utime(raw, ns=(receipt_time - 1_000_000_000,) * 2)
    return 7 if mode == "failure-retry" else 0


def verify_public(mode: str) -> None:
    _, public, _ = paths()
    if mode not in ("success", "failure-retry"):
        raise ValueError
    if json.loads(public.read_text(encoding="utf-8")) != expected(mode):
        raise ValueError


def verify_summary(mode: str) -> None:
    _, _, summary = paths()
    text = summary.read_text(encoding="utf-8")
    row = (
        "| Main e2e | 1 | passed: 1 | summed Playwright attempt durations: 0.0 s |"
        if mode == "success"
        else "| Main e2e | 2 | failed: 1, flaky: 1 | summed Playwright attempt durations: 0.1 s |"
    )
    bounded = (
        "### Test area summary\n\n"
        "| Area | Logical tests | Final statuses | Summed test duration |\n"
        "| --- | ---: | --- | --- |\n"
        f"{row}\n\n"
        f"Global browser errors: {2 if mode == 'failure-retry' else 0}.\n\n"
        "Summed test and retry durations can overlap when tests run in parallel. "
        "They are not job wall time. Missing report data is shown as unavailable.\n"
    )
    if text != bounded:
        raise ValueError


def verify_outcomes(mode: str) -> None:
    valid = mode in ("success", "failure-retry")
    outcomes = {
        "CAPTURE_OUTCOME": "failure" if mode == "failure-retry" else "success",
        "PROJECTION_OUTCOME": "success" if valid else "failure",
        "SUMMARY_OUTCOME": "success" if valid else "skipped",
        "UPLOAD_OUTCOME": "success" if valid else "skipped",
    }
    if any(os.environ.get(name) != value for name, value in outcomes.items()):
        raise ValueError
    _, public, summary = paths()
    if valid:
        verify_public(mode)
        verify_summary(mode)
    elif public.exists() or summary.exists():
        raise ValueError


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("prepare", "produce", "public", "summary", "outcomes"))
    parser.add_argument("--mode", choices=MODES, required=True)
    args = parser.parse_args()
    try:
        if args.phase == "produce":
            return produce(args.mode)
        if args.phase == "prepare":
            prepare()
        elif args.phase == "public":
            verify_public(args.mode)
        elif args.phase == "summary":
            verify_summary(args.mode)
        else:
            verify_outcomes(args.mode)
    except (OSError, ValueError, KeyError, TypeError):
        print("Synthetic diagnostics validation failed.")
        return 2
    print("Synthetic diagnostics validation passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
