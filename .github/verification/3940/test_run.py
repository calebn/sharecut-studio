from __future__ import annotations

import base64
import json
import tempfile
import unittest
from pathlib import Path

from run import (
    FIXTURE,
    HARNESS,
    MODE,
    ROOT,
    SMOKE,
    SOURCES,
    InvalidProof,
    case_verdict,
    harness_files,
    passed_case,
    verify_cleanup,
)


class ReceiptTests(unittest.TestCase):
    def test_overlay_varies_only_the_mode_literal(self) -> None:
        head = harness_files(ROOT, "head")
        parent = harness_files(ROOT, "parent")
        self.assertEqual(
            parent, {**head, SMOKE: head[SMOKE].replace(MODE, MODE.replace(b"head", b"parent"))}
        )

    def test_only_one_passing_attempt_with_no_global_errors_counts(self) -> None:
        attempt = {"status": "passed", "retry": 0}
        case = {
            "case_id": 1,
            "tests": [{"status": "expected", "expectedStatus": "passed", "results": [attempt]}],
        }
        report = {
            "format": "sharecut-browser-public-v1",
            "global_error_count": 0,
            "suites": [{"specs": [case], "suites": []}],
        }
        self.assertTrue(passed_case(report))
        for changes in ({"status": "skipped"}, {"retry": 1}, {"status": "failed"}):
            with self.subTest(changes=changes):
                attempt.update({"status": "passed", "retry": 0}, **changes)
                self.assertFalse(passed_case(report))
        attempt.update(status="passed", retry=0)
        report["global_error_count"] = 1
        self.assertFalse(passed_case(report))

    def test_attachment_requires_exact_mode_outcome_browser_and_fixture(self) -> None:
        receipt = {"name": "palette-reconnect-verdict", "contentType": "application/json"}
        attempt = {"attachments": [receipt]}
        case = {
            "title": "real reconnect keeps palette actions current while open",
            "tests": [{"results": [attempt]}],
        }
        report = {"suites": [{"specs": [], "suites": [{"specs": [case]}]}]}
        for mode, source in SOURCES.items():
            verdict = {
                "mode": mode,
                "outcome": source.verdict,
                "browserVersion": "158.0.8127.18",
                "browserRevision": 1254,
                "fixtureSha256": HARNESS[FIXTURE],
            }
            receipt["body"] = base64.b64encode(json.dumps(verdict).encode()).decode()
            self.assertTrue(case_verdict(report, mode))
            for key in verdict:
                with self.subTest(mode=mode, field=key):
                    wrong = verdict | {key: "FABRICATED_SAFE_MARKER"}
                    receipt["body"] = base64.b64encode(json.dumps(wrong).encode()).decode()
                    self.assertFalse(case_verdict(report, mode))

    def test_leftover_registered_space_or_manifest_cannot_pass(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            verify_cleanup(root)
            for basename in (
                "sharecut-e2e-share-test",
                "sharecut-e2e-cleanup-test",
                "sharecut-e2e-port-4455.lock",
            ):
                with self.subTest(basename=basename):
                    leftover = root / basename
                    leftover.mkdir()
                    with self.assertRaises(InvalidProof):
                        verify_cleanup(root)
                    leftover.rmdir()
            verify_cleanup(root)


if __name__ == "__main__":
    unittest.main()
