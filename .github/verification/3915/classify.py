"""Fail closed; consumes local fixed-schema records, never arbitrary test output."""
import json
import sys


def classify(records, result, code, cleanup):
    if cleanup != "PASS" or not isinstance(records, list):
        return "BLOCKED"
    if any(not isinstance(r, dict) or set(r) != {"ordinal", "status"} for r in records):
        return "BLOCKED"
    passed = [{"ordinal": n, "status": "PASS"} for n in range(1, 13)]
    regressed = passed[:4] + [{"ordinal": 5, "status": "REGRESSION"}, {"ordinal": 12, "status": "PASS"}]
    if records == passed and result == {"count": 1, "status": "passed", "global_errors": 0, "hook_errors": 0, "errors": 0, "error_kind": "none"} and code == 0:
        return "PASS"
    if records == regressed and result == {"count": 1, "status": "failed", "global_errors": 0, "hook_errors": 0, "errors": 1, "error_kind": "controlled_regression"} and code == 1:
        return "EXPECTED_REGRESSION"
    return "BLOCKED"


def pair(parent, head):
    return "BEHAVIOR_CONFIRMED" if (parent, head) == ("EXPECTED_REGRESSION", "PASS") else "BLOCKED"
