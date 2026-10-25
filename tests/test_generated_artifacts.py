"""Every generated artifact and contract check runs under pytest, so CI and `make test` agree."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from script_loader import load_script

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
    ("export_pipeline_params.py", "--check"),
)
# These exporters format their output with Biome from gui/web/node_modules, which the
# pytest job does not install. The frontend job runs them after `npm ci`.
FRONTEND_JOB_CHECKS: tuple[str, ...] = (
    "scripts/export_capabilities_copy.py --check",
    "scripts/export_timeline_zoom.py --check",
    "scripts/export_limit_contracts.py --check",
    "scripts/export_project_types.py --check",
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


def test_project_type_generator_fails_on_a_schema_shape_it_cannot_express(monkeypatch) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    gen = load_script("export_project_types")
    assert gen._ts({"title": "Any"}) == "unknown"
    with pytest.raises(ValueError, match="unhandled JSON-schema shape"):
        gen._ts({"not": {"type": "string"}})


def test_project_type_generator_reports_model_and_nested_schema_path(monkeypatch) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    gen = load_script("export_project_types")
    monkeypatch.setattr(
        gen,
        "_definitions",
        lambda: {
            "DiagnosticModel": {
                "type": "object",
                "properties": {"nested": {"type": "array", "items": {"not": {"type": "string"}}}},
            }
        },
    )

    with pytest.raises(ValueError, match="unhandled JSON-schema shape") as exc_info:
        gen.project_types()

    message = str(exc_info.value)
    assert "DiagnosticModel" in message
    assert '$["properties"]["nested"]["items"]' in message
