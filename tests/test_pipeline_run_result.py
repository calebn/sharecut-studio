from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from podcast_mcp.models import PipelineRun, PipelineStepLog, load_project
from podcast_mcp.pipeline import steps as pipeline_steps
from podcast_mcp.services import ProjectWorkspace
from podcast_mcp.services.pipeline import PipelineRunner


def _stub_run(steps: list[PipelineStepLog]) -> PipelineRun:
    return PipelineRun(id="run1", started_at=datetime.now(UTC).isoformat(), steps=steps)


def _patch_runner(monkeypatch, run: PipelineRun) -> None:
    monkeypatch.setattr(PipelineRunner, "run", lambda self, project, **kwargs: run)


def test_export_ran_with_failing_qc_gives_not_ok(minimal_project: Path, monkeypatch) -> None:
    ws = ProjectWorkspace.open(minimal_project)
    project = load_project(minimal_project)
    qc_path = pipeline_steps.export_qc_path(project)
    qc_path.write_text(
        json.dumps({"ok": False, "issues": ["bad thing"], "warnings": []}), encoding="utf-8"
    )
    run = _stub_run([PipelineStepLog(step="export_deliverables", started_at="t", status="ok")])
    _patch_runner(monkeypatch, run)

    from podcast_mcp.services.pipeline import PipelineService

    result = PipelineService(ws).run(only_step="export_deliverables")

    assert result.ok is False
    assert result.export_qc == {"ok": False, "issues": ["bad thing"], "warnings": []}
    assert result.export_qc_path == qc_path


def test_no_export_step_ignores_stale_failing_file(minimal_project: Path, monkeypatch) -> None:
    ws = ProjectWorkspace.open(minimal_project)
    project = load_project(minimal_project)
    qc_path = pipeline_steps.export_qc_path(project)
    qc_path.write_text(
        json.dumps({"ok": False, "issues": ["stale"], "warnings": []}), encoding="utf-8"
    )
    run = _stub_run([PipelineStepLog(step="ingest_tracks", started_at="t", status="ok")])
    _patch_runner(monkeypatch, run)

    from podcast_mcp.services.pipeline import PipelineService

    result = PipelineService(ws).run(only_step="ingest_tracks")

    assert result.export_qc is None
    assert result.ok is True


def test_corrupt_qc_file_gives_not_ok_unreadable(minimal_project: Path, monkeypatch) -> None:
    ws = ProjectWorkspace.open(minimal_project)
    project = load_project(minimal_project)
    qc_path = pipeline_steps.export_qc_path(project)
    qc_path.write_text("not json", encoding="utf-8")
    run = _stub_run([PipelineStepLog(step="export_deliverables", started_at="t", status="ok")])
    _patch_runner(monkeypatch, run)

    from podcast_mcp.services.pipeline import PipelineService

    result = PipelineService(ws).run(only_step="export_deliverables")

    assert result.ok is False
    assert result.export_qc is not None
    assert "unreadable" in result.export_qc["issues"][0]


def test_ok_qc_gives_ok_true(minimal_project: Path, monkeypatch) -> None:
    ws = ProjectWorkspace.open(minimal_project)
    project = load_project(minimal_project)
    qc_path = pipeline_steps.export_qc_path(project)
    qc_path.write_text(json.dumps({"ok": True, "issues": [], "warnings": []}), encoding="utf-8")
    run = _stub_run([PipelineStepLog(step="export_deliverables", started_at="t", status="ok")])
    _patch_runner(monkeypatch, run)

    from podcast_mcp.services.pipeline import PipelineService

    result = PipelineService(ws).run(only_step="export_deliverables")

    assert result.ok is True
    assert result.export_qc == {"ok": True, "issues": [], "warnings": []}
