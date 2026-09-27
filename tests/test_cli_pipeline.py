from __future__ import annotations

import json
import shlex
from unittest.mock import MagicMock, patch

from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.models import PipelineStepLog
from podcast_mcp.pipeline.runner import ORDERED_STEP_NAMES
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
    assert "Export QC: FAILED (1 issue), 1 warning" in result.stdout
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


def test_pipeline_run_set_passes_run_only_overrides(tmp_path):
    project = _init_project(tmp_path)
    mock_run = MagicMock(
        return_value=PipelineRunResult(
            last_step="ingest_tracks",
            steps=[PipelineStepLog(step="ingest_tracks", started_at="t", status="ok")],
            export_qc=None,
            export_qc_path=None,
        )
    )
    with patch("podcast_mcp.cli.pipeline.PipelineService.run", mock_run):
        result = runner.invoke(
            app,
            [
                "pipeline",
                "run",
                "--project",
                str(project),
                "--set",
                "focus.enabled=true",
                "--realign",
            ],
        )
    assert result.exit_code == 0, result.stdout
    assert mock_run.call_args.kwargs["config"] == {
        "focus": {"enabled": True},
        "align": {"realign": True},
    }

    with patch("podcast_mcp.cli.pipeline.PipelineService.run", mock_run):
        result = runner.invoke(app, ["pipeline", "run", "--project", str(project)])
    assert result.exit_code == 0, result.stdout
    assert mock_run.call_args.kwargs["config"] is None


def test_pipeline_run_set_rejects_unknown_key(tmp_path):
    project = _init_project(tmp_path)
    result = runner.invoke(
        app, ["pipeline", "run", "--project", str(project), "--set", "bogus.thing=1"]
    )
    assert result.exit_code == 2
    assert "unknown pipeline config key" in result.stdout + (result.stderr or "")


def test_pipeline_config_shows_overrides():
    result = runner.invoke(app, ["pipeline", "config", "--set", "focus.enabled=true"])
    assert result.exit_code == 0, result.stdout
    assert "focus.enabled = true *" in result.stdout
    focus_line = next(line for line in result.stdout.splitlines() if "analyze_focus_cuts" in line)
    assert "enabled" in focus_line and "no-op" not in focus_line
    assert "pass the same --set to podcast pipeline run to use these values" in result.stdout


def test_pipeline_config_json():
    result = runner.invoke(app, ["pipeline", "config", "--json"])
    assert result.exit_code == 0, result.stdout
    payload = json.loads(result.stdout)
    assert payload["overrides"] == {}
    assert len(payload["steps"]) == len(ORDERED_STEP_NAMES)


def test_pipeline_analyze_prints_evidence_and_proposal(tmp_path):
    project = _init_project(tmp_path)
    fake_result = {
        "proposed_config": {},
        "patches": {"transcribe": {"vad": {"enabled": True}}},
        "reasons": [
            {
                "code": "digital_silence",
                "message": "host: 85% of the source audio is digital silence",
                "track_id": "host",
                "evidence": {"silent_fraction": 0.85, "threshold_fraction": 0.8},
            },
            {
                "code": "pre_aligned",
                "message": "Dialogue tracks guest, host all run 10.00s",
                "evidence": {"track_ids": ["guest", "host"]},
                "suggested_skip_steps": ["align_tracks"],
            },
        ],
        "report_summary": {
            "track_count": 1,
            "reason_count": 2,
            "tracks": [{"track_id": "host", "digital_silence_fraction": 0.85}],
        },
    }
    with patch(
        "podcast_mcp.services.pipeline_config.suggest_pipeline_tuning",
        return_value=fake_result,
    ) as mock_suggest:
        result = runner.invoke(
            app,
            [
                "pipeline",
                "analyze",
                "--project",
                str(project),
                "--set",
                "focus.enabled=true",
            ],
        )
    assert result.exit_code == 0, result.stdout
    assert "silent_fraction=0.85" in result.stdout
    assert "suggest: --skip align_tracks" in result.stdout
    assert "track host:" in result.stdout
    assert "--set transcribe.vad.enabled=true" in result.stdout
    base_config = mock_suggest.call_args.kwargs["base_config"]
    assert base_config["focus"]["enabled"] is True


def test_pipeline_analyze_run_line_keeps_overrides_and_quotes_project(tmp_path):
    sub = tmp_path / "My Show"
    sub.mkdir()
    project = _init_project(sub)
    fake_result = {
        "proposed_config": {},
        "patches": {"transcribe": {"vad": {"enabled": True}}},
        "reasons": [],
        "report_summary": {"track_count": 0, "reason_count": 0, "tracks": []},
    }
    with patch(
        "podcast_mcp.services.pipeline_config.suggest_pipeline_tuning",
        return_value=fake_result,
    ):
        result = runner.invoke(
            app,
            [
                "pipeline",
                "analyze",
                "--project",
                str(project),
                "--set",
                "transcribe.silence_filter.peak_dbfs=-50",
                "--set",
                "focus.enabled=true",
            ],
        )
    assert result.exit_code == 0, result.stdout
    line = next(line for line in result.stdout.splitlines() if line.startswith("Proposed:"))
    assert "--set transcribe.silence_filter.peak_dbfs=-50" in line
    assert "--set focus.enabled=true" in line
    assert "--set transcribe.vad.enabled=true" in line
    assert shlex.quote(str(project)) in line
    assert "'" in line


def test_pipeline_analyze_json_and_empty(tmp_path):
    project = _init_project(tmp_path)
    empty_result = {
        "proposed_config": {},
        "patches": {},
        "reasons": [],
        "report_summary": {"track_count": 0, "reason_count": 0, "tracks": []},
    }
    with patch(
        "podcast_mcp.services.pipeline_config.suggest_pipeline_tuning",
        return_value=empty_result,
    ):
        json_result = runner.invoke(
            app, ["pipeline", "analyze", "--project", str(project), "--json"]
        )
        text_result = runner.invoke(app, ["pipeline", "analyze", "--project", str(project)])
    assert json_result.exit_code == 0, json_result.stdout
    assert json.loads(json_result.stdout) == empty_result
    assert text_result.exit_code == 0, text_result.stdout
    assert "Analyze: no findings." in text_result.stdout
    assert "No config changes proposed." in text_result.stdout
