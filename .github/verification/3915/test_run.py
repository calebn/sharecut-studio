from __future__ import annotations

import contextlib
import copy
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import run

MARKER = "ordinary synthetic test marker"
EXPECTED = {
    "format": "sharecut-browser-public-v1",
    "global_error_count": 0,
    "suites": [
        {
            "specs": [
                {
                    "case_id": 1,
                    "tests": [
                        {
                            "status": "expected",
                            "expectedStatus": "passed",
                            "results": [{"status": "passed", "retry": 0, "duration": 25}],
                        }
                    ],
                }
            ],
            "suites": [],
        }
    ],
}


class RunnerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.env = {
            "CI": "true",
            "GITHUB_ACTIONS": "true",
            "GITHUB_RUN_ID": "100",
            "GITHUB_RUN_ATTEMPT": "1",
            "RUNNER_TEMP": str(self.root),
        }
        fake_frozen = {
            relative: hashlib.sha256(relative.encode()).hexdigest() for relative in run.FROZEN
        }
        self.enterContext(patch.object(run, "FROZEN", fake_frozen))
        sources = {}
        for source in run.SOURCES.values():
            mapper = f"synthetic mapper {source.name}"
            model = f"synthetic model {source.name}"
            sources[source.name] = source._replace(
                mapper_sha256=hashlib.sha256(mapper.encode()).hexdigest(),
                script_model_sha256=hashlib.sha256(model.encode()).hexdigest(),
            )
            self.env[f"PAIR_{source.name.upper()}_SHA"] = source.commit
            self.write(self.root / source.directory / run.MAPPER, mapper)
            self.write(self.root / source.directory / run.SCRIPT_MODEL, model)
            for relative in fake_frozen:
                self.write(self.root / source.directory / relative, relative)
        self.enterContext(patch.object(run, "SOURCES", sources))
        self.source = sources["parent"]
        for relative in fake_frozen:
            self.write(self.root / relative, relative)
        for original in run.INPUTS.values():
            self.write(self.root / original, f"synthetic {original.name}")
        self.write(self.root / "gui/web/node_modules/@playwright/test/cli.js", MARKER)
        self.output = self.source.public(self.root)
        self.stdout = self.enterContext(contextlib.redirect_stdout(io.StringIO()))

    @staticmethod
    def write(path: Path, value: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value, encoding="utf-8")

    def test_prepare_copies_only_named_inputs_and_clears_owned_outputs(self) -> None:
        self.write(self.output, MARKER)
        self.write(self.source.receipt(self.root), MARKER)
        other_output = self.output.with_name("unrelated.json")
        self.write(other_output, MARKER)
        self.assertEqual(run.prepare(self.root, self.env), 0)
        self.assertFalse(self.output.exists())
        self.assertFalse(self.source.receipt(self.root).exists())
        self.assertEqual(other_output.read_text(), MARKER)
        for source in run.SOURCES.values():
            web = source.web(self.root)
            for target, original in run.INPUTS.items():
                self.assertEqual((web / target).read_bytes(), (self.root / original).read_bytes())
            self.assertEqual((web / "node_modules").readlink(), self.root / "gui/web/node_modules")
        self.assertEqual(run.prepare(self.root, self.env), 0)

    def test_prepare_rejects_wrong_checkout_or_divergent_lock(self) -> None:
        with self.assertRaises(run.InvalidSetup):
            run.prepare(self.root, self.env | {"PAIR_PARENT_SHA": self.env["PAIR_HEAD_SHA"]})
        self.write(self.root / self.source.directory / "uv.lock", MARKER)
        with self.assertRaises(run.InvalidSetup):
            run.prepare(self.root, self.env)
        self.assertFalse((self.source.web(self.root) / run.SPEC).exists())

    def test_prepare_rejects_wrong_harness_lock_or_product_bytes(self) -> None:
        manifest = self.root / "gui/web/package-lock.json"
        correct = manifest.read_text()
        self.write(manifest, MARKER)
        with self.assertRaises(run.InvalidSetup):
            run.prepare(self.root, self.env)
        self.write(manifest, correct)
        for relative in (run.MAPPER, run.SCRIPT_MODEL):
            with self.subTest(relative=relative):
                path = self.root / self.source.directory / relative
                correct = path.read_text()
                self.write(path, MARKER)
                with self.assertRaises(run.InvalidSetup):
                    run.prepare(self.root, self.env)
                self.write(path, correct)

    def test_runtime_rejects_missing_or_non_hosted_values(self) -> None:
        run.validate_runtime(self.env)
        for key, value in {
            "CI": "false",
            "GITHUB_ACTIONS": "",
            "GITHUB_RUN_ID": MARKER,
            "GITHUB_RUN_ATTEMPT": "0",
            "RUNNER_TEMP": "relative",
        }.items():
            with self.subTest(key=key), self.assertRaises(run.InvalidSetup):
                run.validate_runtime(self.env | {key: value})

    def test_exercise_uses_side_sources_and_capture_and_projects_after_exit_zero(self) -> None:
        run.prepare(self.root, self.env)

        def successful_run(args: tuple[str, ...], cwd: Path, env: dict[str, str]) -> int:
            if "--capture-receipt" in args:
                self.write(self.output, json.dumps(EXPECTED))
            return 0

        env = self.env | {
            "BROWSER_RAW_REPORT": MARKER,
            "BROWSER_CAPTURE_RECEIPT": MARKER,
            "PLAYWRIGHT_JSON_OUTPUT_FILE": MARKER,
            "PYTHONPATH": MARKER,
        }
        with patch.object(run, "run_command", side_effect=successful_run) as command:
            self.assertEqual(run.exercise(self.root, self.source, env), 0)
        calls = [call.args for call in command.call_args_list]
        self.assertEqual(len(calls), 4)
        import_check, build, browser, projection = calls
        web = self.source.web(self.root)
        for args, cwd, child_env in (import_check, build, browser):
            self.assertEqual(
                args[:2], ("bash", str(self.root / "scripts/private_browser_command.sh"))
            )
            self.assertEqual(cwd, web)
            self.assertEqual(
                child_env["PYTHONPATH"], str(self.root / self.source.directory / "src")
            )
            self.assertEqual(child_env["PODCAST_GUI_DIST"], str(web / "dist"))
            self.assertEqual(child_env["SCRIPT_RECORDING_IDENTITY_PROFILE"], "parent")
        self.assertEqual(build[0][2:], ("npm", "run", "build"))
        self.assertNotIn("BROWSER_RAW_REPORT", build[2])
        self.assertNotIn("BROWSER_CAPTURE_RECEIPT", build[2])
        self.assertEqual(
            browser[0][2:],
            (
                "npm",
                "run",
                "test:e2e",
                "--",
                run.SPEC,
                "--workers=1",
                "--retries=0",
                "--reporter=github,json",
            ),
        )
        self.assertEqual(browser[2]["BROWSER_RAW_REPORT"], "playwright-report/3915-parent.json")
        self.assertEqual(
            browser[2]["PLAYWRIGHT_JSON_OUTPUT_FILE"], browser[2]["BROWSER_RAW_REPORT"]
        )
        self.assertEqual(browser[2]["BROWSER_CAPTURE_RECEIPT"], str(self.source.receipt(self.root)))
        self.assertIn(str(self.root / "scripts/browser_public_report.py"), projection[0])
        self.assertIn(str(web / browser[2]["BROWSER_RAW_REPORT"]), projection[0])
        self.assertTrue(self.output.exists())
        self.assertNotIn(MARKER, self.stdout.getvalue())

    def test_nonzero_status_is_returned_and_old_public_files_are_removed(self) -> None:
        run.prepare(self.root, self.env)
        for codes in ([43], [0, 43], [0, 0, 43], [0, 0, 0, 43]):
            with self.subTest(codes=codes):
                self.write(self.output, MARKER)
                self.write(self.source.receipt(self.root), MARKER)
                with patch.object(run, "run_command", side_effect=codes) as command:
                    self.assertEqual(run.exercise(self.root, self.source, self.env), 43)
                self.assertEqual(command.call_count, len(codes))
                self.assertFalse(self.output.exists())
                self.assertFalse(self.source.receipt(self.root).exists())

    def test_failed_case_is_never_available_for_publication(self) -> None:
        run.prepare(self.root, self.env)

        def failed_case(*args: object) -> int:
            if "--capture-receipt" in args[0]:
                self.write(self.output, json.dumps(EXPECTED | {"global_error_count": 2}))
            return 0

        with patch.object(run, "run_command", side_effect=failed_case):
            self.assertEqual(run.exercise(self.root, self.source, self.env), 2)
        self.assertFalse(self.output.exists())
        self.assertIn("parent validation: failed", self.stdout.getvalue())

    def test_exact_projection_rejects_failed_skipped_retried_and_extra_cases(self) -> None:
        self.assertTrue(run.passed_case(EXPECTED))
        for field, value in (
            ("status", "failed"),
            ("status", "skipped"),
            ("retry", 1),
            ("retry", False),
            ("duration", float("inf")),
            ("title", MARKER),
        ):
            with self.subTest(field=field, value=value):
                modified = copy.deepcopy(EXPECTED)
                modified["suites"][0]["specs"][0]["tests"][0]["results"][0][field] = value
                self.assertFalse(run.passed_case(modified))
        modified = copy.deepcopy(EXPECTED)
        modified["suites"][0]["specs"] *= 2
        self.assertFalse(run.passed_case(modified))
        self.assertFalse(run.passed_case(EXPECTED | {"global_error_count": 1}))
        self.assertFalse(run.passed_case(None))

    def test_subprocess_raw_output_and_signal_do_not_escape(self) -> None:
        with patch.object(
            run.subprocess, "run", return_value=type("Result", (), {"returncode": -15})()
        ) as process:
            self.assertEqual(run.run_command(("fake",), self.root, self.env), 143)
        for stream in ("stdin", "stdout", "stderr"):
            self.assertEqual(process.call_args.kwargs[stream], run.subprocess.DEVNULL)


class WorkflowWiringTest(unittest.TestCase):
    def test_existing_event_and_job_launch_the_fixed_serial_pair(self) -> None:
        workflow = (run.ROOT / ".github/workflows/test.yml").read_text(encoding="utf-8")
        triggers = workflow.split("\non:\n", 1)[1].split("\nconcurrency:", 1)[0]
        self.assertEqual(
            [
                line.strip()
                for line in triggers.splitlines()
                if line.startswith("  ") and not line.startswith("    ")
            ],
            ["push:", "pull_request:", "workflow_dispatch:"],
        )
        job = workflow.split("\n  verify-3915-paired-script:\n", 1)[1].split(
            "\n  frontend-e2e:\n", 1
        )[0]
        self.assertIn("github.event_name == 'pull_request'", job)
        self.assertIn("github.event.pull_request.number == 3915", job)
        self.assertIn("github.event.pull_request.head.repo.full_name == github.repository", job)
        self.assertIn("github.head_ref == 'fix/script-cutword-recording-3765'", job)
        self.assertIn("image: ${{ needs.changes.outputs.playwright-image }}", job)
        self.assertIn("ref: ${{ github.event.pull_request.head.sha }}", job)
        self.assertIn("!cancelled() && steps.pair-prepare.outcome == 'success'", job)
        self.assertIn(
            "success() && steps.pair-parent-run.outcome == 'success' "
            "&& steps.pair-head-run.outcome == 'success'",
            job,
        )
        self.assertIn("github.event.pull_request.draft != true", job)
        self.assertIn("needs.changes.outputs.e2e == 'true'", job)
        self.assertNotIn("permissions:", job)
        self.assertNotIn("--headed", job)
        self.assertIn("run: python .github/verification/3915/run.py prepare", job)
        for side in run.SOURCES.values():
            checkout = job.split(f"        id: pair-{side.name}\n", 1)[1].split(
                "\n      - name:", 1
            )[0]
            self.assertIn(f"ref: {side.commit}", checkout)
            self.assertIn(f"path: {side.directory}", checkout)
            self.assertIn("persist-credentials: false", checkout)
            self.assertIn(
                f"PAIR_{side.name.upper()}_SHA: "
                + "${{ steps."
                + f"pair-{side.name}.outputs.commit"
                + " }}",
                job,
            )
            self.assertIn(f"run: python .github/verification/3915/run.py {side.name}", job)
            self.assertIn(str(side.public(Path("."))), job)


if __name__ == "__main__":
    unittest.main()
