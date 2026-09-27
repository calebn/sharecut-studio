from __future__ import annotations

from unittest.mock import patch

from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.models import PipelineStepLog
from podcast_mcp.services import PipelineRunResult

runner = CliRunner()


def _init_project(tmp_path):
    ws = tmp_path / "ep"
    runner.invoke(app, ["episode", "init", "--dir", str(ws), "--name", "cli-test"])
    return ws / "episode.project.json"


def test_pipeline_run_prints_summaries_and_verdict(tmp_path):
    project = _init_project(tmp_path)
    result_obj = PipelineRunResult(
        last_step="export_deliverables",
        steps=[
            PipelineStepLog(step="ingest_tracks", started_at="t", status="ok", message="1 track"),
            PipelineStepLog(step="export_deliverables", started_at="t", status="ok"),
        ],
        export_qc={"ok": False, "issues": ["bad thing"], "warnings": ["a warning"]},
        export_qc_path=tmp_path / "export_qc.json",
    )
    with patch("podcast_mcp.cli.pipeline.PipelineService.run", return_value=result_obj):
        result = runner.invoke(app, ["pipeline", "run", "--project", str(project)])
    assert result.exit_code == 0
    assert "ok    ingest_tracks: 1 track" in result.stdout
    assert "ok    export_deliverables" in result.stdout
    assert "Export QC: FAILED (1 issues), 1 warnings" in result.stdout
    assert "- bad thing" in result.stdout
    assert "Pipeline complete. Last step: export_deliverables" in result.stdout


def test_pipeline_run_strict_exits_1_on_not_ok(tmp_path):
    project = _init_project(tmp_path)
    result_obj = PipelineRunResult(
        last_step="export_deliverables",
        steps=[PipelineStepLog(step="export_deliverables", started_at="t", status="ok")],
        export_qc={"ok": False, "issues": ["bad thing"], "warnings": []},
        export_qc_path=tmp_path / "export_qc.json",
    )
    with patch("podcast_mcp.cli.pipeline.PipelineService.run", return_value=result_obj):
        result = runner.invoke(app, ["pipeline", "run", "--project", str(project), "--strict"])
    assert result.exit_code == 1
    assert "--strict" in result.stderr


def test_pipeline_run_strict_ok_qc_exits_0(tmp_path):
    project = _init_project(tmp_path)
    result_obj = PipelineRunResult(
        last_step="export_deliverables",
        steps=[PipelineStepLog(step="export_deliverables", started_at="t", status="ok")],
        export_qc={"ok": True, "issues": [], "warnings": []},
        export_qc_path=tmp_path / "export_qc.json",
    )
    with patch("podcast_mcp.cli.pipeline.PipelineService.run", return_value=result_obj):
        result = runner.invoke(app, ["pipeline", "run", "--project", str(project), "--strict"])
    assert result.exit_code == 0


def test_pipeline_run_strict_no_export_exits_0(tmp_path):
    project = _init_project(tmp_path)
    result_obj = PipelineRunResult(
        last_step="ingest_tracks",
        steps=[PipelineStepLog(step="ingest_tracks", started_at="t", status="ok")],
        export_qc=None,
        export_qc_path=None,
    )
    with patch("podcast_mcp.cli.pipeline.PipelineService.run", return_value=result_obj):
        result = runner.invoke(app, ["pipeline", "run", "--project", str(project), "--strict"])
    assert result.exit_code == 0
