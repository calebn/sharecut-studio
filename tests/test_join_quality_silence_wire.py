"""Pin the join report bytes for a digitally silent track (#1811).

On an all-zero track the ``inaudible_splice`` detector reports ``floor_db = Infinity``. Every
text surface prints that as the bare ``Infinity`` token (``json.dumps`` default), so the dumps
of the join reports must stay python-mode: a ``mode="json"`` dump would turn the non-finite
values inside the ``dict[str, Any]`` fields into ``null`` and change the bytes.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from typer.testing import CliRunner

from pause_policy_public_helpers import configure, defaults, project, workspace, write_wav
from podcast_mcp.cli.main import app
from podcast_mcp.mcp.tools.edits import join_qa_sweep_tool, join_quality_tool
from podcast_mcp.models import EditDecision
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import TimelineService
from podcast_mcp.services.document.golden_ear import _join_metrics

pytestmark = pytest.mark.unscoped_ok

runner = CliRunner()
INF = "Infinity"


def _silent(tmp_path: Path, monkeypatch) -> str:
    configure(monkeypatch, defaults())
    result = project(tmp_path, topology="deleted")
    write_wav(tmp_path / "raw" / "host.wav", np.zeros(6 * 16000))
    return str(workspace(result).path)


def _floor_dbs(report: dict) -> list:
    return [
        row["detail"]["floor_db"]
        for row in report["detectors"]
        if "floor_db" in (row.get("detail") or {})
    ]


def _check_inf(report: dict) -> None:
    floors = _floor_dbs(report)
    assert floors
    assert all(value == float("inf") for value in floors)


def _cli(path: str, command: str, *extra: str):
    return runner.invoke(app, ["edit", command, "--project", path, *extra])


def test_cli_join_quality_prints_bare_infinity(tmp_path, monkeypatch):
    path = _silent(tmp_path, monkeypatch)
    res = _cli(path, "join-quality", "--track", "host", "--join", "2")
    assert res.exit_code == 0
    assert f'"floor_db": {INF}' in res.stdout
    _check_inf(json.loads(res.stdout))


def test_cli_join_sweep_prints_bare_infinity(tmp_path, monkeypatch):
    path = _silent(tmp_path, monkeypatch)
    res = _cli(path, "join-sweep", "--track", "host")
    assert res.exit_code == 0
    assert f'"floor_db": {INF}' in res.stdout
    sweep = json.loads(res.stdout)
    assert sweep["joins"]
    _check_inf(sweep["joins"][0])


def test_mcp_join_quality_text_keeps_infinity(tmp_path, monkeypatch):
    path = _silent(tmp_path, monkeypatch)
    text = join_quality_tool(path, track_id="host", join_sec=2)
    assert f'"floor_db": {INF}' in text
    _check_inf(json.loads(text))
    cli = _cli(path, "join-quality", "--track", "host", "--join", "2")
    assert text + "\n" == cli.stdout


def test_mcp_join_qa_sweep_text_keeps_infinity(tmp_path, monkeypatch):
    path = _silent(tmp_path, monkeypatch)
    text = join_qa_sweep_tool(path, track_id="host")
    assert f'"floor_db": {INF}' in text
    _check_inf(json.loads(text)["joins"][0])
    assert text + "\n" == _cli(path, "join-sweep", "--track", "host").stdout


def test_golden_ear_join_metrics_keeps_infinity(tmp_path, monkeypatch):
    path = _silent(tmp_path, monkeypatch)
    ws = ProjectWorkspace.open(Path(path))
    edit = EditDecision(id="e1", track_id="host", start=0.3, end=4.45)
    metrics = _join_metrics(SimpleNamespace(ws=ws), edit, None)
    _check_inf(metrics)
    assert f'"floor_db": {INF}' in json.dumps(metrics)


def test_join_label_features_keep_infinity(tmp_path, monkeypatch):
    path = _silent(tmp_path, monkeypatch)
    ws = ProjectWorkspace.open(Path(path))
    result = TimelineService(ws).join_label(
        track_id="host", join_sec=2, verdict="pass", timebase="timeline"
    )
    wire = result.model_dump()
    _check_inf(wire["features"])
