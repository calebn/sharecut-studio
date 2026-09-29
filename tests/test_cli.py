from __future__ import annotations

import json
from unittest.mock import patch

import pytest
from filelock import Timeout
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.services import HistoryService, PipelineService
from podcast_mcp.util.project_state import ProjectBusyError, RenderBusyError

runner = CliRunner()


def test_episode_init(tmp_path):
    ws = tmp_path / "ep"
    result = runner.invoke(app, ["episode", "init", "--dir", str(ws), "--name", "demo"])
    assert result.exit_code == 0
    assert (ws / "episode.project.json").is_file()


def test_pipeline_list():
    result = runner.invoke(app, ["pipeline", "list"])
    assert result.exit_code == 0
    assert "ingest_tracks" in result.stdout
    assert "export_deliverables" in result.stdout
    focus_line = next(line for line in result.stdout.splitlines() if "analyze_focus_cuts" in line)
    assert "no-op (focus.enabled=false)" in focus_line


def test_pipeline_list_json():
    result = runner.invoke(app, ["pipeline", "list", "--json"])
    assert result.exit_code == 0
    rows = json.loads(result.stdout)
    by_id = {row["id"]: row for row in rows}
    assert by_id["analyze_focus_cuts"]["noop_reason"] == "focus.enabled=false"
    assert by_id["analyze_focus_cuts"]["enabled"] is False
    assert by_id["ingest_tracks"]["enabled"] is True
    assert by_id["ingest_tracks"]["noop_reason"] is None


def test_track_add(tmp_path, sample_wav):
    ws = tmp_path / "ep"
    runner.invoke(app, ["episode", "init", "--dir", str(ws)])
    project = ws / "episode.project.json"
    result = runner.invoke(
        app,
        [
            "episode",
            "add-track",
            "--project",
            str(project),
            "--id",
            "host",
            "--file",
            str(sample_wav),
            "--role",
            "dialogue",
        ],
    )
    assert result.exit_code == 0
    assert "host" in result.stdout


def test_episode_reorder_track_reports_service_result(tmp_path):
    ws = tmp_path / "ep"
    runner.invoke(app, ["episode", "init", "--dir", str(ws)])
    project = ws / "episode.project.json"

    with patch("podcast_mcp.cli.episode.EpisodeService") as service:
        service.return_value.reorder_track.return_value = {"id": "guest", "index": 0}
        result = runner.invoke(
            app,
            [
                "episode",
                "reorder-track",
                "--project",
                str(project),
                "--id",
                "guest",
                "--index",
                "0",
            ],
        )

    assert result.exit_code == 0
    assert json.loads(result.stdout) == {"id": "guest", "index": 0}
    service.return_value.reorder_track.assert_called_once_with("guest", 0)


def test_edit_crossfade_joins_reports_service_result(tmp_path):
    ws = tmp_path / "ep"
    runner.invoke(app, ["episode", "init", "--dir", str(ws)])
    project = ws / "episode.project.json"

    with patch("podcast_mcp.cli.edit.EditService") as service:
        service.return_value.crossfade_joins.return_value = {"count": 0}
        result = runner.invoke(
            app,
            [
                "edit",
                "crossfade-joins",
                "--project",
                str(project),
                "--track",
                "host",
                "--fade-ms",
                "10",
                "--dry-run",
            ],
        )

    assert result.exit_code == 0
    assert json.loads(result.stdout) == {"count": 0}
    service.return_value.crossfade_joins.assert_called_once_with(
        track_id="host", speaker=None, fade_ms=10, dry_run=True
    )


def test_transcribe_command_passes_model_to_transcript_service(tmp_path):
    ws = tmp_path / "ep"
    runner.invoke(app, ["episode", "init", "--dir", str(ws)])
    project = ws / "episode.project.json"

    with patch("podcast_mcp.cli.episode.TranscriptService") as service:
        result = runner.invoke(
            app,
            ["transcribe", "--project", str(project), "--model", "base.en"],
        )

    assert result.exit_code == 0
    service.assert_called_once()
    assert service.call_args.kwargs == {"model": "base.en"}
    service.return_value.transcribe.assert_called_once_with(None)


def test_transcribe_command_reports_track_count(tmp_path):
    ws = tmp_path / "ep"
    runner.invoke(app, ["episode", "init", "--dir", str(ws)])
    project = ws / "episode.project.json"

    with patch("podcast_mcp.cli.episode.TranscriptService") as service:
        service.return_value.transcribe.return_value = ["host", "guest"]
        result = runner.invoke(app, ["transcribe", "--project", str(project)])

    assert result.exit_code == 0
    assert "Transcribed 2 track(s)." in result.stdout
    assert "Warning" not in result.stderr


def test_transcribe_command_warns_when_nothing_transcribed(tmp_path):
    ws = tmp_path / "ep"
    runner.invoke(app, ["episode", "init", "--dir", str(ws)])
    project = ws / "episode.project.json"

    with patch("podcast_mcp.cli.episode.TranscriptService") as service:
        service.return_value.transcribe.return_value = []
        result = runner.invoke(app, ["transcribe", "--project", str(project)])

    assert result.exit_code == 0
    assert "Transcribed 0 track(s)." in result.stdout
    assert "no tracks were transcribed" in result.stderr


def test_transcribe_command_empty_project_reports_zero(tmp_path):
    from podcast_mcp.services import ProjectWorkspace

    ws = tmp_path / "ep"
    runner.invoke(app, ["episode", "init", "--dir", str(ws)])
    project = ws / "episode.project.json"

    result = runner.invoke(app, ["transcribe", "--project", str(project)])

    assert result.exit_code == 0
    assert "Transcribed 0 track(s)." in result.stdout
    assert "no tracks were transcribed" in result.stderr
    assert len(ProjectWorkspace.open(project).project.history.entries) == 1


def test_propose_edits_command(tmp_path):
    from podcast_mcp.models import Transcript, TranscriptWord, load_project, save_project

    ws = tmp_path / "ep"
    runner.invoke(app, ["episode", "init", "--dir", str(ws)])
    project_path = ws / "episode.project.json"
    proj = load_project(project_path)
    proj.transcripts.append(
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.2, confidence=0.95),
                TranscriptWord(text="like", start=0.25, end=0.4, confidence=0.95),
                TranscriptWord(text="said", start=0.45, end=0.7, confidence=0.95),
                TranscriptWord(text="like", start=1.0, end=1.2, confidence=0.95),
                TranscriptWord(text="world", start=1.3, end=1.5, confidence=0.95),
            ],
        )
    )
    save_project(proj, project_path)
    result = runner.invoke(
        app,
        ["propose-edits", "--project", str(project_path)],
    )
    assert result.exit_code == 0
    assert "discourse kept" in result.stdout
    muted = runner.invoke(
        app,
        ["propose-edits", "--project", str(project_path), "--edit-mode", "mute"],
    )
    assert muted.exit_code == 0
    light = runner.invoke(
        app, ["propose-edits", "--project", str(project_path), "--intensity", "light"]
    )
    assert light.exit_code == 0
    assert "proposed" in light.stdout
    bad = runner.invoke(
        app, ["propose-edits", "--project", str(project_path), "--intensity", "extreme"]
    )
    assert bad.exit_code != 0
    assert "intensity" in bad.output.lower()


def test_propose_edits_command_without_discourse_skips(tmp_path):
    from podcast_mcp.models import Transcript, TranscriptWord, load_project, save_project

    ws = tmp_path / "ep"
    runner.invoke(app, ["episode", "init", "--dir", str(ws)])
    project_path = ws / "episode.project.json"
    proj = load_project(project_path)
    proj.transcripts.append(
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.2, confidence=0.95),
                TranscriptWord(text="world", start=0.25, end=0.5, confidence=0.95),
            ],
        )
    )
    save_project(proj, project_path)
    result = runner.invoke(app, ["propose-edits", "--project", str(project_path)])
    assert result.exit_code == 0
    assert "proposed" in result.stdout
    assert "discourse kept" not in result.stdout


def test_propose_edits_json(tmp_path):
    from podcast_mcp.models import Transcript, TranscriptWord, load_project, save_project

    ws = tmp_path / "ep"
    runner.invoke(app, ["episode", "init", "--dir", str(ws)])
    project_path = ws / "episode.project.json"
    proj = load_project(project_path)
    proj.transcripts.append(
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.2, confidence=0.95),
                TranscriptWord(text="world", start=0.25, end=0.5, confidence=0.95),
            ],
        )
    )
    save_project(proj, project_path)
    result = runner.invoke(app, ["propose-edits", "--project", str(project_path), "--json"])
    assert result.exit_code == 0
    payload = json.loads(result.stdout)
    assert payload["operation"] == "propose_edits"
    assert "edits" in payload
    assert "skip_counts" in payload
    assert "summary" in payload


def test_edit_suggest_handoff_cut_command(tmp_path):
    from unittest.mock import patch

    ws = tmp_path / "ep"
    runner.invoke(app, ["episode", "init", "--dir", str(ws)])
    project_path = ws / "episode.project.json"
    with patch("podcast_mcp.cli.edit.EditService") as svc_cls:
        svc_cls.return_value.suggest_handoff_cut.return_value = {
            "ok": True,
            "cut_start": 1.0,
            "cut_end": 2.0,
        }
        result = runner.invoke(
            app,
            [
                "edit",
                "suggest-handoff-cut",
                "--project",
                str(project_path),
                "--track",
                "host",
                "--keep-left-end",
                "1.0",
                "--keep-right-start",
                "3.0",
            ],
        )
    assert result.exit_code == 0
    assert '"ok": true' in result.stdout
    svc_cls.return_value.suggest_handoff_cut.assert_called_once()


def test_export_transcript_command(tmp_path):
    from podcast_mcp.models import (
        CombinedTranscript,
        CombinedUtterance,
        load_project,
        save_project,
    )

    ws = tmp_path / "ep"
    runner.invoke(app, ["episode", "init", "--dir", str(ws)])
    project_path = ws / "episode.project.json"
    proj = load_project(project_path)
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=1.0,
                text="Hello",
            )
        ]
    )
    save_project(proj, project_path)
    result = runner.invoke(
        app,
        ["export-transcript", "--project", str(project_path)],
    )
    assert result.exit_code == 0
    assert (ws / "export" / "episode.md").is_file()


def test_info_command(tmp_path):
    ws = tmp_path / "ep"
    runner.invoke(app, ["episode", "init", "--dir", str(ws)])
    result = runner.invoke(
        app,
        ["info", "--project", str(ws / "episode.project.json")],
    )
    assert result.exit_code == 0
    assert "episode" in result.stdout


def test_info_command_omits_document_sync(tmp_path):
    from podcast_mcp.models import SavedDocumentCommand, load_project, save_project

    ws = tmp_path / "ep"
    runner.invoke(app, ["episode", "init", "--dir", str(ws)])
    project_path = ws / "episode.project.json"
    proj = load_project(project_path)
    proj.document_sync.last_command = SavedDocumentCommand(
        command_id="cmd-1",
        client_id="c1",
        role="viewer",
        type="AddComment",
        payload={"body": "secret-payload"},
        base_server_seq=0,
    )
    save_project(proj, project_path)
    result = runner.invoke(app, ["info", "--project", str(project_path)])
    assert result.exit_code == 0
    assert "document_sync" not in result.stdout
    assert "secret-payload" not in result.stdout


@pytest.mark.parametrize(
    "exc",
    [
        ProjectBusyError("/artifacts/episode.project.json.lock"),
        RenderBusyError("/artifacts/render.lock"),
        Timeout("/artifacts/transcript_context.yaml.lock"),
    ],
    ids=["project-busy", "render-busy", "raw-timeout"],
)
def test_undo_reports_busy_lock_via_root_group(minimal_project, monkeypatch, exc) -> None:
    """A lock timeout escaping ``undo`` is caught by ``BusyErrorGroup``, not a traceback (#488)."""

    def _raise(self, **kwargs):
        raise exc

    monkeypatch.setattr(HistoryService, "undo", _raise)
    result = runner.invoke(app, ["undo", "--project", str(minimal_project)])
    assert result.exit_code == 1
    assert result.stderr.startswith("Error: ")
    assert "/artifacts" not in result.stderr


def test_render_preview_reports_render_busy_error(minimal_project, monkeypatch) -> None:
    def _raise(self, **kwargs):
        raise RenderBusyError("/artifacts/render.lock")

    monkeypatch.setattr(PipelineService, "render_preview", _raise)
    result = runner.invoke(app, ["render-preview", "--project", str(minimal_project)])
    assert result.exit_code == 1
    assert "Error: " in result.stderr
    assert "another render of this project is in progress" in result.stderr
