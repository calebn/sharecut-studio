import importlib.util
import itertools
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
HERE = ROOT / "scripts"
spec = importlib.util.spec_from_file_location("candidate", HERE / "browser_public_report.py")
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)
OUTCOMES = {"passed", "failed", "timed_out", "interrupted", "flaky", "skipped", "unknown"}
NAMES = {
    kind: f"SC3923_EDITOR_COMMENT_V1 {kind}" for kind in ["PASSED", "NOT_CLEAN_PASS", "UNKNOWN"]
}
CANARY = "FABRICATED_PRIVATE\n::error::https://invalid.example/invitation\n| forged | passed |"


def conditions(matrix, projection, value):
    if matrix != "main-smoke":
        return []
    if projection == "success" and value == "passed":
        return ["PASSED"]
    if projection == "success" and value in {
        "failed",
        "timed_out",
        "interrupted",
        "flaky",
        "skipped",
    }:
        return ["NOT_CLEAN_PASS"]
    return ["UNKNOWN"]


def read_receipt(steps, identities_verified=True, projection_verified=True):
    if identities_verified is not True or not isinstance(steps, list) or len(steps) != 3:
        return "UNKNOWN"
    if any(
        not isinstance(row, dict) or set(["name", "status", "conclusion"]) - row.keys()
        for row in steps
    ):
        return "UNKNOWN"
    if {row["name"] for row in steps} != set(NAMES.values()):
        return "UNKNOWN"
    selected = [
        row for row in steps if row["status"] == "completed" and row["conclusion"] == "success"
    ]
    if len(selected) != 1:
        return "UNKNOWN"
    if any(
        row["status"] != "completed" or row["conclusion"] != "skipped"
        for row in steps
        if row is not selected[0]
    ):
        return "UNKNOWN"
    kind = next(kind for kind, name in NAMES.items() if selected[0]["name"] == name)
    return kind if kind == "UNKNOWN" or projection_verified is True else "UNKNOWN"


def report():
    return {
        "errors": [],
        "suites": [
            {
                "specs": [
                    {
                        "file": candidate.FUNCTIONAL_CASE_FILE,
                        "title": candidate.FUNCTIONAL_CASE_TITLE,
                        "tests": [
                            {
                                "expectedStatus": "passed",
                                "status": "expected",
                                "results": [
                                    {
                                        "status": "passed",
                                        "retry": 0,
                                        "error": CANARY,
                                        "stdout": CANARY,
                                    }
                                ],
                            }
                        ],
                    }
                ],
                "suites": [],
            }
        ],
    }


class DesignTests(unittest.TestCase):
    def test_conditions_are_exhaustive_only_for_main_smoke(self):
        for matrix, projection, value in itertools.product(
            ["main-smoke", "chromium-compat"],
            ["success", "failure", "skipped", "cancelled"],
            [*OUTCOMES, "", CANARY],
        ):
            selected = conditions(matrix, projection, value)
            self.assertEqual(len(selected), 1 if matrix == "main-smoke" else 0)
            if projection != "success" and matrix == "main-smoke":
                self.assertEqual(selected, ["UNKNOWN"])

    def test_no_skipped_pending_cancelled_missing_or_duplicate_receipt_can_pass(self):
        states = [
            ("completed", "success"),
            ("completed", "skipped"),
            ("pending", None),
            ("completed", "cancelled"),
        ]
        for values in itertools.product(states, repeat=3):
            rows = [
                dict(name=name, status=state[0], conclusion=state[1])
                for name, state in zip(NAMES.values(), values, strict=True)
            ]
            if read_receipt(rows) == "PASSED":
                self.assertEqual(values, (states[0], states[1], states[1]))
        skipped = [
            dict(name=name, status="completed", conclusion="skipped") for name in NAMES.values()
        ]
        self.assertEqual(read_receipt(skipped), "UNKNOWN")
        self.assertEqual(read_receipt(skipped[:2]), "UNKNOWN")
        self.assertEqual(read_receipt([skipped[0]] * 3), "UNKNOWN")
        rows = [
            dict(row, conclusion="success" if i == 0 else "skipped")
            for i, row in enumerate(skipped)
        ]
        self.assertEqual(read_receipt(rows, identities_verified=False), "UNKNOWN")
        self.assertEqual(read_receipt(rows, projection_verified=False), "UNKNOWN")
        self.assertEqual(read_receipt([{}, {}, {}]), "UNKNOWN")
        self.assertEqual(read_receipt(None), "UNKNOWN")

    def test_fixed_output_alphabet_and_failed_channel_do_not_change_exit(self):
        self.assertIn("\n", CANARY)
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "output"
            with patch.dict(os.environ, {"GITHUB_OUTPUT": str(output)}):
                for value in OUTCOMES:
                    candidate.write_functional_output(value)
                candidate.write_functional_output(CANARY)
                candidate.write_functional_output(None)
            self.assertEqual(
                set(output.read_text().splitlines()),
                {f"functional_outcome={value}" for value in OUTCOMES},
            )
            self.assertNotIn(CANARY, output.read_text())
            with patch.dict(os.environ, {"GITHUB_OUTPUT": temp}):
                candidate.write_functional_output("passed")

    def test_fresh_capture_gate_and_channel_failure(self):
        for mode in ["valid", "absent", "malformed", "stale", "missing", "channel-failed"]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                receipt = root / "receipt"
                receipt.write_text("123 1\n")
                raw = root / "raw.json"
                data = report()
                if mode == "absent":
                    data["suites"][0]["specs"] = []
                raw.write_text(CANARY if mode == "malformed" else json.dumps(data))
                if mode == "stale":
                    os.utime(raw, ns=(1, 1))
                if mode == "missing":
                    raw.unlink()
                output = root / "output"
                channel = root if mode == "channel-failed" else output
                child = subprocess.run(
                    [
                        sys.executable,
                        str(HERE / "browser_public_report.py"),
                        "--report",
                        str(raw),
                        "--output",
                        str(root / "public.json"),
                        "--capture-receipt",
                        str(receipt),
                    ],
                    env={
                        **os.environ,
                        "GITHUB_OUTPUT": str(channel),
                        "GITHUB_RUN_ID": "123",
                        "GITHUB_RUN_ATTEMPT": "1",
                    },
                    capture_output=True,
                    text=True,
                )
                self.assertNotIn(CANARY, child.stdout + child.stderr)
                if mode in ["malformed", "stale", "missing"]:
                    self.assertEqual(child.returncode, 2)
                    self.assertFalse(output.exists())
                else:
                    self.assertEqual(child.returncode, 0)
                    if mode == "channel-failed":
                        self.assertFalse(output.exists())
                    else:
                        self.assertEqual(
                            output.read_text(),
                            f"functional_outcome={'unknown' if mode == 'absent' else 'passed'}\n",
                        )

    def test_three_metadata_steps_use_only_fixed_conditions_and_noops(self):
        from github_yaml import load_github_yaml

        after = load_github_yaml(ROOT / ".github/workflows/test.yml")
        added = []
        for job in after["jobs"].values():
            for step in job.get("steps", []):
                if step.get("name") in NAMES.values():
                    added.append(step)
                    self.assertEqual(step["run"], ":")
                    self.assertIs(step["continue-on-error"], True)
                    self.assertIn("matrix.name == 'main-smoke'", step["if"])
        self.assertEqual(len(added), 3)
        self.assertEqual(set(NAMES.values()), {step["name"] for step in added})
        for step in added:
            self.assertEqual(set(step), {"name", "if", "continue-on-error", "run"})
        expected_predicates = [
            "${{ always() && matrix.name == 'main-smoke' && steps.browser-public-projection.outcome == 'success' && steps.browser-public-projection.outputs.functional_outcome == 'passed' }}",
            '${{ always() && matrix.name == \'main-smoke\' && steps.browser-public-projection.outcome == \'success\' && contains(fromJSON(\'["failed","timed_out","interrupted","flaky","skipped"]\'), steps.browser-public-projection.outputs.functional_outcome) }}',
            '${{ always() && matrix.name == \'main-smoke\' && (steps.browser-public-projection.outcome != \'success\' || !contains(fromJSON(\'["passed","failed","timed_out","interrupted","flaky","skipped"]\'), steps.browser-public-projection.outputs.functional_outcome)) }}',
        ]
        self.assertEqual([step["if"] for step in added], expected_predicates)
        self.assertIn("outputs.functional_outcome == 'passed'", added[0]["if"])
        self.assertIn("steps.browser-public-projection.outcome == 'success'", added[0]["if"])
        self.assertIn("steps.browser-public-projection.outcome == 'success'", added[1]["if"])
        self.assertIn("steps.browser-public-projection.outcome != 'success'", added[2]["if"])
        self.assertNotIn("GITHUB_STEP_SUMMARY", (HERE / "browser_public_report.py").read_text())


if __name__ == "__main__":
    unittest.main()
