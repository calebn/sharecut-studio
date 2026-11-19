import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
HERE = ROOT / "scripts"
spec = importlib.util.spec_from_file_location("phase_candidate", HERE / "browser_public_report.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
PHASES = (
    "never_started",
    "entered",
    "host_ready",
    "share_ready",
    "editor_ready",
    "composer_ready",
    "comment_saved",
    "derived_checked",
    "undo_checked",
    "body_complete",
)
CANARY = "FABRICATED_PRIVATE\nhttps://invalid.example/invite\n::error::private|raw"


def result(status="failed", phase="comment_saved", retry=0):
    return {
        "status": status,
        "retry": retry,
        "annotations": [{"type": module.PHASE_ANNOTATION, "description": phase}],
        "error": {"message": CANARY},
    }


def report(results=None):
    return {
        "errors": [],
        "suites": [
            {
                "specs": [
                    {
                        "file": module.FUNCTIONAL_CASE_FILE,
                        "title": module.FUNCTIONAL_CASE_TITLE,
                        "tests": [
                            {
                                "status": "unexpected",
                                "expectedStatus": "passed",
                                "results": results if results is not None else [result()],
                            }
                        ],
                    }
                ],
                "suites": [],
            }
        ],
    }


def phase(value):
    module.project(value)
    return module.functional_case_phase(value)


class PhaseTests(unittest.TestCase):
    def test_positive_explicit_markers_and_no_absence_inference(self):
        for name in PHASES:
            self.assertEqual(phase(report([result(phase=name)])), name)
        no_marker = result()
        no_marker.pop("annotations")
        self.assertEqual(phase(report([no_marker])), "unknown")
        self.assertEqual(phase(report([])), "unknown")
        skipped = result("skipped", "never_started")
        self.assertEqual(phase(report([skipped])), "never_started")
        skipped.pop("annotations")
        self.assertEqual(phase(report([skipped])), "unknown")

    def test_invalid_missing_ambiguous_and_inconsistent_markers_are_unknown(self):
        for value in [CANARY, None, {}, 1, "unknown"]:
            self.assertEqual(phase(report([result(phase=value)])), "unknown")
        for status, marker in [
            ("passed", "entered"),
            ("skipped", "entered"),
            ("interrupted", "body_complete"),
        ]:
            self.assertEqual(phase(report([result(status, marker)])), "unknown")
        self.assertEqual(phase(report([result("passed", "body_complete")])), "body_complete")
        wrong = result()
        wrong["annotations"][0]["type"] = "sharecut.functional-last-completed.v2"
        self.assertEqual(phase(report([wrong])), "unknown")
        duplicate = result()
        duplicate["annotations"] *= 2
        self.assertEqual(phase(report([duplicate])), "unknown")
        value = report()
        value["suites"][0]["specs"] *= 2
        self.assertEqual(phase(value), "unknown")
        value = report()
        value["suites"][0]["specs"] = []
        self.assertEqual(phase(value), "unknown")
        value = report()
        value["errors"] = [{"message": CANARY}]
        self.assertEqual(phase(value), "unknown")

    def test_retry_selection_is_first_nonpassing_attempt_without_fallback(self):
        first = result("failed", "composer_ready")
        later = result("passed", "body_complete", 1)
        self.assertEqual(phase(report([first, later])), "composer_ready")
        first.pop("annotations")
        self.assertEqual(phase(report([first, later])), "unknown")
        self.assertEqual(phase(report([result(retry=1)])), "unknown")
        self.assertEqual(phase(report([result(), result(retry=0)])), "unknown")
        value = report([result()])
        test = value["suites"][0]["specs"][0]["tests"][0]
        test["annotations"] = [{"type": module.PHASE_ANNOTATION, "description": "body_complete"}]
        test["results"][0].pop("annotations")
        self.assertEqual(phase(value), "unknown")

    def test_only_closed_phase_values_reach_existing_output_channel(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "output"
            with patch.dict(os.environ, {"GITHUB_OUTPUT": str(target)}):
                for name in [*PHASES, "unknown", CANARY, None]:
                    module.write_phase_output(name)
            self.assertEqual(
                set(target.read_text().splitlines()),
                {f"functional_phase={name}" for name in (*PHASES, "unknown")},
            )
            self.assertNotIn(CANARY, target.read_text())
            with patch.dict(os.environ, {"GITHUB_OUTPUT": temp}):
                module.write_phase_output("body_complete")

    def test_cli_validates_fresh_capture_before_any_export(self):
        for mode in ["valid", "missing-marker", "stale", "malformed"]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                receipt = root / "receipt"
                receipt.write_text("123 1\n")
                raw = root / "raw.json"
                data = report()
                if mode == "missing-marker":
                    data["suites"][0]["specs"][0]["tests"][0]["results"][0].pop("annotations")
                raw.write_text(CANARY if mode == "malformed" else json.dumps(data))
                if mode == "stale":
                    os.utime(raw, ns=(1, 1))
                output = root / "commands"
                public = root / "public.json"
                child = subprocess.run(
                    [
                        sys.executable,
                        str(HERE / "browser_public_report.py"),
                        "--report",
                        str(raw),
                        "--output",
                        str(public),
                        "--capture-receipt",
                        str(receipt),
                    ],
                    env={
                        **os.environ,
                        "GITHUB_RUN_ID": "123",
                        "GITHUB_RUN_ATTEMPT": "1",
                        "GITHUB_OUTPUT": str(output),
                    },
                    capture_output=True,
                    text=True,
                )
                self.assertNotIn(CANARY, child.stdout + child.stderr)
                if mode in ["stale", "malformed"]:
                    self.assertEqual(child.returncode, 2)
                    self.assertFalse(output.exists())
                    self.assertFalse(public.exists())
                else:
                    self.assertEqual(child.returncode, 0)
                    self.assertEqual(
                        output.read_text(),
                        f"functional_outcome=failed\nfunctional_phase={'unknown' if mode == 'missing-marker' else 'comment_saved'}\n",
                    )
                    self.assertNotIn(CANARY, public.read_text())

    def test_static_phase_vocabulary_and_noop_receipt_conditions(self):
        sys.path.insert(0, str(ROOT / "tests"))
        from github_yaml import load_github_yaml

        source = (ROOT / "gui/web/e2e/stage-shell.spec.ts").read_text()
        vocabulary = source[source.index("const CASE_PHASES = [") : source.index("] as const;")]
        self.assertEqual(tuple(re.findall(r'"([a-z_]+)"', vocabulary)), PHASES)
        workflow = load_github_yaml(ROOT / ".github/workflows/test.yml")
        steps = [
            s
            for job in workflow["jobs"].values()
            for s in job.get("steps", [])
            if s.get("name", "").startswith("SC3923_EDITOR_COMMENT_V1 LAST_")
        ]
        self.assertEqual(
            {s["name"] for s in steps},
            {f"SC3923_EDITOR_COMMENT_V1 LAST_{name.upper()}" for name in (*PHASES, "unknown")},
        )
        self.assertEqual(len(steps), len(PHASES) + 1)
        for step in steps:
            self.assertEqual(set(step), {"name", "if", "run", "continue-on-error"})
            self.assertEqual(step["run"], ":")
            self.assertIs(step["continue-on-error"], True)
            self.assertIn("matrix.name == 'main-smoke'", step["if"])
            if not step["name"].endswith("LAST_UNKNOWN"):
                self.assertIn("steps.browser-public-projection.outcome == 'success'", step["if"])


if __name__ == "__main__":
    unittest.main()
