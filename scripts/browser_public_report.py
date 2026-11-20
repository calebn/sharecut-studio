"""Project untrusted browser diagnostics into a string-free case/timing inventory."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import tempfile
from contextlib import suppress
from pathlib import Path

FINAL_STATUSES = frozenset({"expected", "unexpected", "flaky", "skipped"})
ATTEMPT_STATUSES = frozenset({"passed", "failed", "timedOut", "skipped", "interrupted"})

RETRY_SCOPES = {
    "suite": (
        40,
        12,
        "52657a1d3c803e4498957c66522990e6854aa1b56060ddbe80be5b91d0073e76",
    ),
    "standalone": (
        1,
        0,
        "eba0251aa96824d89e183dce34b59c82c4985e3983e0e87e08af5f58bf18f65e",
    ),
}


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


def project(report: object, *, catalogue: list[list[object]] | None = None) -> dict:
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
                    if catalogue is not None:
                        catalogue.append(
                            [
                                spec.get("id"),
                                spec.get("file"),
                                spec.get("line"),
                                spec.get("column"),
                                test.get("projectId"),
                            ]
                        )
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


def write_projection(
    source: Path, output: Path, receipt: Path, *, retry_scope: str = ""
) -> str | None:
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
    scope = RETRY_SCOPES.get(retry_scope)
    catalogue = [] if scope is not None else None
    with source.open(encoding="utf-8") as stream:
        public = project(json.load(stream), catalogue=catalogue)
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

    if scope is None or catalogue is None or public["global_error_count"]:
        return None
    count, index, wanted = scope
    if len(catalogue) != count:
        return None
    with suppress(ValueError, TypeError, RecursionError, OverflowError):
        encoded = json.dumps(catalogue, separators=(",", ":")).encode()
        if hashlib.sha256(encoded).hexdigest() != wanted:
            return None
        case = public["suites"][0]["specs"][index]["tests"][0]
        attempts = case["results"]
        if case["expectedStatus"] != "passed" or not attempts or attempts[0]["retry"] != 0:
            return None
        status = attempts[0]["status"]
        if status == "passed":
            return "passed"
        if status in {"failed", "timedOut"}:
            return "failed"
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--capture-receipt", required=True, type=Path)
    args = parser.parse_args()
    try:
        verdict = write_projection(
            args.report,
            args.output,
            args.capture_receipt,
            retry_scope=os.environ.get("SHARECUT_3907_RETRY_SCOPE", ""),
        )
    except (OSError, ValueError, TypeError, RecursionError, OverflowError):
        print("Browser result projection unavailable; raw diagnostics withheld.")
        return 2
    if verdict is not None:
        with (
            suppress(KeyError, OSError),
            Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as stream,
        ):
            stream.write(f"editor_retry={verdict}\n")
    print("Browser result projection ready; free-form diagnostics withheld.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
