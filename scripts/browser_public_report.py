"""Project untrusted browser diagnostics into a string-free case/timing inventory."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import tempfile
from collections.abc import Callable
from contextlib import suppress
from pathlib import Path
from typing import IO

FINAL_STATUSES = frozenset({"expected", "unexpected", "flaky", "skipped"})
ATTEMPT_STATUSES = frozenset({"passed", "failed", "timedOut", "skipped", "interrupted"})


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


def _only_mapping(value: object) -> dict:
    sequence = _sequence(value)
    if len(sequence) != 1:
        raise InvalidReport
    return _mapping(sequence[0])


def _load_phase_report(stream: IO[str]) -> object:
    def unique_members(pairs: list[tuple[str, object]]) -> dict[str, object]:
        members = dict(pairs)
        if len(members) != len(pairs):
            raise InvalidReport
        return members

    def reject_constant(_: str) -> None:
        raise InvalidReport

    return json.load(stream, object_pairs_hook=unique_members, parse_constant=reject_constant)


def palette_phase(report: object) -> dict[str, int]:
    source = _mapping(report)
    if _sequence(source.get("errors")):
        raise InvalidReport

    matches = [
        spec
        for root in map(_mapping, _sequence(source.get("suites")))
        if root.get("file") == "root-pin.spec.ts"
        for suite in map(_mapping, _sequence(root.get("suites", [])))
        if suite.get("title") == "real palette reconnect"
        for spec in map(_mapping, _sequence(suite.get("specs")))
        if spec.get("title") == "real reconnect keeps palette actions current while open"
    ]
    case = _only_mapping(matches)
    test = _only_mapping(case.get("tests"))
    attempt = _only_mapping(test.get("results"))
    if (
        test.get("projectName") != ""
        or test.get("expectedStatus") != "passed"
        or _integer(attempt.get("retry")) != 0
    ):
        raise InvalidReport

    def read_steps(value: object, ids: range) -> list[tuple[int, int]]:
        markers = _sequence(value)
        if len(markers) > len(ids):
            raise InvalidReport
        states = []
        for phase, raw_marker in zip(ids, markers, strict=False):
            step = _mapping(raw_marker)
            duration = step.get("duration")
            if (
                step.get("title") != f"3940:{phase:02}"
                or "subtitle" in step
                or isinstance(duration, bool)
                or not isinstance(duration, int | float)
                or not math.isfinite(duration)
                or not (0 <= duration <= 2**53 or duration == -1)
                or (phase != 2 and _sequence(step.get("steps", [])))
            ):
                raise InvalidReport
            state = 3 if duration == -1 else 1
            if "error" in step:
                _mapping(step["error"])
                if state == 3:
                    raise InvalidReport
                state = 2
            states.append((phase, state))
        if any(state != 1 for _, state in states[:-1]):
            raise InvalidReport
        return states

    steps = _sequence(attempt.get("steps", []))
    root_states = read_steps(steps, range(1, 3))
    nested = read_steps(steps[1].get("steps", []), range(3, 15)) if len(steps) == 2 else []
    errors = _sequence(attempt.get("errors"))
    if attempt.get("status") == "passed" and test.get("status") == "expected":
        if "error" in attempt or errors:
            raise InvalidReport
        if root_states != [(1, 1), (2, 1)] or nested != [(n, 1) for n in range(3, 15)]:
            raise InvalidReport
        return {"phase_id": 14, "state_id": 1}

    if attempt.get("status") not in ("failed", "timedOut") or test.get("status") != "unexpected":
        raise InvalidReport
    first_error = _mapping(attempt.get("error"))
    if (
        not any(isinstance(first_error.get(field), str) for field in ("message", "value"))
        or not errors
        or any(not isinstance(_mapping(error).get("message"), str) for error in errors)
    ):
        raise InvalidReport
    if root_states in ([(1, 2)], [(1, 3)]):
        phase, state = root_states[-1]
    elif len(root_states) == 2 and root_states[-1][1] != 1:
        phase, state = root_states[-1]
        if nested and nested[-1][1] != 1:
            if state == 3 and nested[-1][1] == 2:
                raise InvalidReport
            phase, state = nested[-1]
        elif nested and len(nested) != 12:
            raise InvalidReport
    else:
        raise InvalidReport
    if state == 3 and attempt.get("status") != "timedOut":
        raise InvalidReport
    return {"phase_id": phase, "state_id": state}


_PHASE_UNAVAILABLE = {"phase_id": 0, "state_id": 0}


def write_projection(
    source: Path,
    output: Path,
    receipt: Path,
    projector: Callable[[object], dict] = project,
    load: Callable[[IO[str]], object] = json.load,
) -> dict:
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
        public = projector(load(stream))
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
    return public


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--capture-receipt", required=True, type=Path)
    parser.add_argument("--palette-phase", action="store_true")
    args = parser.parse_args()
    if args.palette_phase:
        result = _PHASE_UNAVAILABLE
        with suppress(OSError, ValueError, TypeError, RecursionError, OverflowError):
            result = write_projection(
                args.report, args.output, args.capture_receipt, palette_phase, _load_phase_report
            )
        try:
            with Path(os.environ.get("GITHUB_OUTPUT", "")).open("a", encoding="utf-8") as channel:
                channel.write(f"phase_id={result['phase_id']}\nstate_id={result['state_id']}\n")
        except OSError:
            print("Palette phase unavailable.")
            return 2
        return 0
    try:
        write_projection(args.report, args.output, args.capture_receipt)
    except (OSError, ValueError, TypeError, RecursionError, OverflowError):
        print("Browser result projection unavailable; raw diagnostics withheld.")
        return 2
    print("Browser result projection ready; free-form diagnostics withheld.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
