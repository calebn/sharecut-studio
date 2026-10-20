"""Every generated artifact and contract check runs under pytest, so CI and `make test` agree."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
WORKFLOW = ROOT / ".github" / "workflows" / "test.yml"

PYTEST_JOB_CHECKS: tuple[tuple[str, ...], ...] = (
    ("export_document_command_schema.py", "--check"),
    ("export_docs_site_contract.py", "--check"),
    ("export_capabilities_docs.py", "--check"),
    ("check_capabilities_manifest.py",),
    ("check_extension_contracts.py",),
    ("check_progress.py",),
    ("decisions_index.py", "--check"),
)
# These exporters format their output with Biome from gui/web/node_modules, which the
# pytest job does not install. The frontend job runs them after `npm ci`.
FRONTEND_JOB_CHECKS: tuple[str, ...] = (
    "scripts/export_capabilities_copy.py --check",
    "scripts/export_timeline_zoom.py --check",
)


def _run(script: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPTS / script), *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.mark.parametrize("check", PYTEST_JOB_CHECKS, ids=[" ".join(c) for c in PYTEST_JOB_CHECKS])
def test_generated_artifact_is_current(check: tuple[str, ...]) -> None:
    result = _run(*check)
    assert result.returncode == 0, result.stdout + result.stderr


def test_every_checkable_exporter_is_covered() -> None:
    covered = {check[0] for check in PYTEST_JOB_CHECKS}
    covered |= {Path(command.split()[0]).name for command in FRONTEND_JOB_CHECKS}
    exporters = {
        path.name
        for path in SCRIPTS.glob("export_*.py")
        if "--check" in path.read_text(encoding="utf-8")
    }
    assert exporters - covered == set()


@pytest.mark.parametrize("command", FRONTEND_JOB_CHECKS)
def test_biome_formatted_exporters_run_in_the_frontend_job(command: str) -> None:
    assert f"python3 {command}" in WORKFLOW.read_text(encoding="utf-8")
