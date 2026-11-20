from __future__ import annotations

import base64
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from run import (
    FIXTURE,
    HARNESS,
    RAW_REPORT,
    ROOT,
    SMOKE,
    WEB,
    InvalidProof,
    ProofRun,
    browser,
    build,
    case_verdict,
    cleanup,
    harness_files,
    passed_case,
    prepare,
    verdict,
)


def passing_projection() -> dict:
    attempt = {"status": "passed", "retry": 0}
    case = {
        "case_id": 1,
        "tests": [{"status": "expected", "expectedStatus": "passed", "results": [attempt]}],
    }
    return {
        "format": "sharecut-browser-public-v1",
        "global_error_count": 0,
        "suites": [{"specs": [case], "suites": []}],
    }


def browser_attachment(**changes: object) -> dict:
    receipt = {
        "name": "palette-reconnect-verdict",
        "contentType": "application/json",
        "body": base64.b64encode(
            json.dumps(
                {
                    "mode": "head",
                    "outcome": "HEAD_PASS",
                    "browserVersion": "158.0.8127.18",
                    "browserRevision": 1254,
                    "fixtureSha256": HARNESS[FIXTURE],
                    **changes,
                }
            ).encode()
        ).decode(),
    }
    case = {
        "title": "real reconnect keeps palette actions current while open",
        "tests": [{"results": [{"attachments": [receipt]}]}],
    }
    return {"suites": [{"specs": [], "suites": [{"specs": [case]}]}]}


class ReceiptTests(unittest.TestCase):
    def test_fixed_overlay_has_no_mode_or_smoke_byte_changes(self) -> None:
        self.assertEqual(harness_files(ROOT)[SMOKE], (ROOT / SMOKE).read_bytes())

    def test_only_one_expected_passing_attempt_counts(self) -> None:
        report = passing_projection()
        self.assertTrue(passed_case(report))
        attempt = report["suites"][0]["specs"][0]["tests"][0]["results"][0]
        for changes in ({"status": "skipped"}, {"retry": 1}, {"status": "failed"}):
            with self.subTest(changes=changes):
                attempt.update({"status": "passed", "retry": 0}, **changes)
                self.assertFalse(passed_case(report))
        attempt.update(status="passed", retry=0)
        report["global_error_count"] = 1
        self.assertFalse(passed_case(report))

    def test_attachment_requires_exact_mode_outcome_browser_and_fixture(self) -> None:
        self.assertTrue(case_verdict(browser_attachment()))
        for key in ("mode", "outcome", "browserVersion", "browserRevision", "fixtureSha256"):
            with self.subTest(field=key):
                self.assertFalse(case_verdict(browser_attachment(**{key: "FABRICATED_MARKER"})))


class StageTests(unittest.TestCase):
    def setUp(self) -> None:
        owner = self.enterContext(tempfile.TemporaryDirectory())
        self.root = Path(owner)
        self.proof = ProofRun(
            self.root, self.root / "checkout", self.root / "work", "123 1 SHA", {}
        )
        dependencies = self.proof.root / WEB / "node_modules/@playwright/test"
        dependencies.mkdir(parents=True)
        (dependencies / "cli.js").touch()
        self.proof.web.mkdir(parents=True)
        self.enterContext(patch("run.harness_files", return_value={}))
        self.command = self.enterContext(patch("run.run"))

    def test_import_failure_can_neither_build_nor_claim_cleanup(self) -> None:
        self.command.side_effect = subprocess.CalledProcessError(7, "fabricated")
        with self.assertRaises(subprocess.CalledProcessError):
            prepare(self.proof)
        with self.assertRaises(FileNotFoundError):
            build(self.proof)
        with self.assertRaises(FileNotFoundError):
            cleanup(self.proof)
        self.assertEqual(self.command.call_count, 1)

    def test_failed_build_cannot_start_browser_or_cleanup(self) -> None:
        prepare(self.proof)
        self.command.side_effect = subprocess.CalledProcessError(7, "fabricated")
        with self.assertRaises(subprocess.CalledProcessError):
            build(self.proof)
        self.proof.require("source")
        with self.assertRaises(InvalidProof):
            browser(self.proof)
        with self.assertRaises(InvalidProof):
            cleanup(self.proof)

    def test_failed_browser_can_show_cleanup_but_cannot_pass_verdict(self) -> None:
        prepare(self.proof)
        build(self.proof)
        self.command.side_effect = subprocess.CalledProcessError(7, "fabricated")
        with self.assertRaises(subprocess.CalledProcessError):
            browser(self.proof)
        cleanup(self.proof)
        self.proof.require("cleaned-failure")
        with self.assertRaises(InvalidProof):
            verdict(self.proof)

    def test_cleanup_cannot_pass_with_leftover_fixture_manifest_or_lease(self) -> None:
        prepare(self.proof)
        build(self.proof)
        browser(self.proof)
        for name in (
            "sharecut-e2e-share-test",
            "sharecut-e2e-cleanup-test",
            "sharecut-e2e-port-4455.lock",
        ):
            with self.subTest(name=name):
                leftover = self.proof.temp / name
                leftover.mkdir()
                with self.assertRaises(InvalidProof):
                    cleanup(self.proof)
                self.proof.require("browser-passed")
                leftover.rmdir()
        cleanup(self.proof)
        self.proof.require("cleaned-pass")

    def test_stale_and_symlink_state_are_rejected(self) -> None:
        prepare(self.proof)
        with self.assertRaises(FileExistsError):
            prepare(self.proof)
        with self.assertRaises(InvalidProof):
            self.proof._replace(identity="124 1 SHA").state()
        marker = self.proof.temp / "state"
        marker_copy = marker.with_name("state-copy")
        marker.rename(marker_copy)
        marker.symlink_to(marker_copy)
        with self.assertRaises(InvalidProof):
            self.proof.state()
        directory_copy = self.proof.temp.with_name("work-copy")
        self.proof.temp.rename(directory_copy)
        self.proof.temp.symlink_to(directory_copy)
        with self.assertRaises(InvalidProof):
            self.proof.state()

    def test_verdict_requires_receipt_and_removes_only_owned_files_on_success(self) -> None:
        prepare(self.proof)
        build(self.proof)
        browser(self.proof)
        cleanup(self.proof)
        with self.assertRaises(InvalidProof):
            verdict(self.proof)
        report = self.proof.web / RAW_REPORT
        report.parent.mkdir()
        report.write_text(json.dumps(browser_attachment()), encoding="utf-8")
        receipt = self.proof.temp / "capture.txt"
        receipt.touch()
        projection = self.proof.temp / "result.json"
        projection.write_text(json.dumps(passing_projection()), encoding="utf-8")
        self.command.side_effect = subprocess.CalledProcessError(7, "fabricated stale receipt")
        with self.assertRaises(subprocess.CalledProcessError):
            verdict(self.proof)
        self.assertTrue(report.is_file())
        self.assertTrue(self.proof.temp.is_dir())
        self.command.side_effect = None
        verdict(self.proof)
        self.assertFalse(report.exists())
        self.assertFalse(self.proof.temp.exists())
        self.assertTrue(report.parent.is_dir())


if __name__ == "__main__":
    unittest.main()
