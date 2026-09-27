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


def test_missing_qc_file_after_export_gives_not_ok(minimal_project: Path, monkeypatch) -> None:
    ws = ProjectWorkspace.open(minimal_project)
    project = load_project(minimal_project)
    qc_path = pipeline_steps.export_qc_path(project)
    qc_path.unlink(missing_ok=True)
    run = _stub_run([PipelineStepLog(step="export_deliverables", started_at="t", status="ok")])
    _patch_runner(monkeypatch, run)

    from podcast_mcp.services.pipeline import PipelineService

    result = PipelineService(ws).run(only_step="export_deliverables")

    assert result.ok is False
    assert result.export_qc == {
        "ok": False,
        "issues": ["export_qc.json missing after export"],
        "warnings": [],
    }
    assert result.export_qc_path == qc_path


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


def test_write_export_qc_writes_atomically(minimal_project: Path, monkeypatch) -> None:
    import podcast_mcp.util.atomic_json as atomic_json
    from podcast_mcp.config import load_defaults

    project = load_project(minimal_project)
    calls: list[Path] = []
    real = atomic_json.write_json_atomic

    def spy(path, payload, **kwargs):
        calls.append(path)
        return real(path, payload, **kwargs)

    monkeypatch.setattr(atomic_json, "write_json_atomic", spy)
    qc = pipeline_steps.write_export_qc(project, defaults=load_defaults())
    assert calls == [pipeline_steps.export_qc_path(project)]
    assert pipeline_steps.read_export_qc(project) == qc


def test_format_export_qc_lines_and_job_result(tmp_path: Path) -> None:
    from podcast_mcp.services.pipeline import PipelineRunResult, format_export_qc_lines

    assert format_export_qc_lines(None, None) == []
    res = PipelineRunResult(
        last_step="export_deliverables",
        steps=[],
        export_qc={"ok": False, "issues": ["bad"], "warnings": ["w"], "timebase": {"x": 1}},
        export_qc_path=tmp_path / "export_qc.json",
    )
    assert res.qc_report_lines() == [
        f"Export QC: FAILED (1 issue), 1 warning ({tmp_path / 'export_qc.json'})",
        "  - bad",
    ]
    assert res.job_result() == {
        "export_qc": {"ok": False, "issues": ["bad"], "warnings": ["w"]},
        "export_qc_path": str(tmp_path / "export_qc.json"),
    }
    assert PipelineRunResult(last_step="x", steps=[]).job_result() is None
    assert (
        format_export_qc_lines({"ok": False, "issues": ["a", "b"], "warnings": []}, "qc.json")[0]
        == "Export QC: FAILED (2 issues), 0 warnings (qc.json)"
    )
