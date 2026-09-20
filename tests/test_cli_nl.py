from __future__ import annotations

from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.models import (
    CombinedTranscript,
    CombinedUtterance,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)

runner = CliRunner()


def _init_with_transcript(tmp_path):
    ws = tmp_path / "ep"
    runner.invoke(app, ["episode", "init", "--dir", str(ws), "--name", "demo"])
    project = ws / "episode.project.json"
    proj = load_project(project)
    proj.transcripts.append(
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="coffee", start=0.0, end=0.5)],
        )
    )
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=20.0,
                text="Why is coffee so good for podcasts?",
            )
        ]
    )
    save_project(proj, project)
    return project


def test_edit_context_and_search(tmp_path):
    project = _init_with_transcript(tmp_path)
    r = runner.invoke(app, ["edit-context", "--project", str(project)])
    assert r.exit_code == 0
    assert "tools_hint" in r.stdout
    r2 = runner.invoke(
        app,
        ["edit", "search", "--project", str(project), "--query", "coffee"],
    )
    assert r2.exit_code == 0
    assert "coffee" in r2.stdout


def test_edit_cut_text_and_impact(tmp_path):
    project = _init_with_transcript(tmp_path)
    r = runner.invoke(
        app,
        ["edit", "cut-text", "--project", str(project), "--query", "coffee"],
    )
    assert r.exit_code == 0
    r2 = runner.invoke(app, ["edit", "impact", "--project", str(project)])
    assert r2.exit_code == 0
    assert "Edit impact" in r2.stdout


def test_clips_propose_and_report(tmp_path):
    project = _init_with_transcript(tmp_path)
    r = runner.invoke(app, ["clips", "propose", "--project", str(project)])
    assert r.exit_code == 0
    assert "Proposed" in r.stdout
    r2 = runner.invoke(app, ["clips", "report", "--project", str(project)])
    assert r2.exit_code == 0
    assert "Social clip" in r2.stdout


def test_apply_edits_command(tmp_path):
    from podcast_mcp.models import EditDecision, EditDecisionType

    project = _init_with_transcript(tmp_path)
    proj = load_project(project)
    proj.edit_decisions.append(
        EditDecision(
            id="f1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=0,
            end=0.1,
            reason="filler:um",
            review_required=False,
            applied=False,
        )
    )
    save_project(proj, project)
    r = runner.invoke(app, ["apply-edits", "--project", str(project)])
    assert r.exit_code == 0
    assert "Applied" in r.stdout
