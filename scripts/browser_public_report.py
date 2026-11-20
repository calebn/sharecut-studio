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

SMOKE_3907_CATALOGUE = "52657a1d3c803e4498957c66522990e6854aa1b56060ddbe80be5b91d0073e76"


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


def project(report: object, *, catalogue: list[tuple[list[object], dict]] | None = None) -> dict:
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
                            (
                                [
                                    spec.get("id"),
                                    spec.get("file"),
                                    spec.get("line"),
                                    spec.get("column"),
                                    test.get("projectId"),
                                ],
                                test,
                            )
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


def _first_retry_phase(test: dict) -> int | None:
    with suppress(InvalidReport, IndexError, KeyError):
        first = _mapping(_sequence(test.get("results"))[0])
        if first["retry"] != 0 or first["status"] not in ("failed", "timedOut"):
            return None
        steps = [_mapping(step) for step in _sequence(first.get("steps"))]
        if not 1 <= len(steps) <= 3 or steps[0].get("title") != "Retry phase 1":
            return None
        if len(steps) == 3 and steps[2].get("title") != "Retry phase 9":
            return None
        for step in steps:
            _integer(step.get("duration"))
            if "error" in step:
                _mapping(step["error"])
        if "error" in steps[0]:
            return 1 if len(steps) == 1 else None
        if len(steps) >= 2 and "error" in steps[1]:
            for phase in (2, 3, 4, 5, 6, 7, 8, 10):
                if steps[1].get("title") == f"Retry phase {phase}":
                    return phase
        if (
            len(steps) == 3
            and steps[1].get("title") == "Retry body complete"
            and "error" not in steps[1]
            and steps[2].get("title") == "Retry phase 9"
            and "error" in steps[2]
        ):
            return 9
    return None


def write_projection(
    source: Path, output: Path, receipt: Path, *, smoke_3907: bool = False
) -> tuple[int | None, int | None]:
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
    catalogue = [] if smoke_3907 else None
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

    if catalogue is None or len(catalogue) != 40 or public["global_error_count"]:
        return None, None
    with suppress(ValueError, TypeError, RecursionError, OverflowError):
        encoded = json.dumps(
            [identity for identity, _ in catalogue], separators=(",", ":")
        ).encode()
        if hashlib.sha256(encoded).hexdigest() == SMOKE_3907_CATALOGUE:
            for spec in public["suites"][0]["specs"]:
                test = spec["tests"][0]
                attempts = test["results"]
                if (
                    test["status"] == "unexpected"
                    and attempts
                    and attempts[-1]["status"] in {"passed", "failed", "timedOut"}
                ):
                    case = spec["case_id"]
                    phase = _first_retry_phase(catalogue[12][1]) if case == 13 else None
                    return case, phase
    return None, None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--capture-receipt", required=True, type=Path)
    args = parser.parse_args()
    try:
        ordinal, phase = write_projection(
            args.report,
            args.output,
            args.capture_receipt,
            smoke_3907=os.environ.get("SHARECUT_3907_SMOKE") == "true",
        )
    except (OSError, ValueError, TypeError, RecursionError, OverflowError):
        print("Browser result projection unavailable; raw diagnostics withheld.")
        return 2
    if ordinal is not None:
        with (
            suppress(KeyError, OSError),
            Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as stream,
        ):
            stream.write(f"case_ordinal={ordinal}\n")
            if phase is not None:
                stream.write(f"phase_ordinal={phase}\n")
    print("Browser result projection ready; free-form diagnostics withheld.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
