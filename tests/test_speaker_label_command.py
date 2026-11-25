"""``podcast speaker label --apply`` and ``speaker_label_tool`` save through a document command (#1849).

The apply submits ``LabelSpeakerWindow``, so the labels reach ``episode.sharecut`` as one
undoable history step and the command journal, where an open Studio reads it. A dry run
scores the window and writes nothing.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from combined_contract_helpers import State, open_workspace
from podcast_mcp.cli.main import app
from podcast_mcp.mcp.tools.speaker import speaker_label_tool
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document_sync import DocumentSyncService, submit_host_document_command
from test_combined_commit_contract import _speaker_seams

WINDOW = ("0.0", "1.5")
HOST_WINDOW_WORDS = ("hello", "there", "friend")


def _host_words(path: Path) -> list:
    return ProjectWorkspace.open(path).project.transcript_for_track("host").words


def _labels(path: Path) -> dict[str, tuple[str | None, bool]]:
    return {w.text: (w.speaker_match_track, w.suppressed) for w in _host_words(path)}


def _journal(path: Path) -> list[str]:
    return [r["type"] for r in DocumentSyncService.open(path).store.commands_after(0)]


@pytest.fixture
def project(tmp_path: Path, ten_second_silence_wav: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    _speaker_seams(monkeypatch)
    return open_workspace(tmp_path / "ep", ten_second_silence_wav, State.FRESH).path


def _cli_label(path: Path, *extra: str):
    args = ["speaker", "label", "--project", str(path), "--track", "host"]
    return CliRunner().invoke(app, [*args, "--start", WINDOW[0], "--end", WINDOW[1], *extra])


def _apply_cli(path: Path) -> dict:
    result = _cli_label(path, "--apply")
    assert result.exit_code == 0, result.output
    return json.loads(result.output)


def _apply_mcp(path: Path) -> dict:
    return json.loads(speaker_label_tool(str(path), "host", 0.0, 1.5, dry_run=False))


@pytest.mark.parametrize("apply", [_apply_cli, _apply_mcp], ids=["cli", "mcp"])
def test_an_apply_saves_the_labels_as_one_undoable_command(project: Path, apply) -> None:
    before = _labels(project)
    head = ProjectWorkspace.open(project).project.history.head_id()

    result = apply(project)

    assert result["labeled"] == len(HOST_WINDOW_WORDS)
    assert result["role"] != "own"
    saved = _labels(project)
    for text in HOST_WINDOW_WORDS:
        assert saved[text] == ("guest", True), text
    assert {t: saved[t] for t in saved if t not in HOST_WINDOW_WORDS} == {
        t: before[t] for t in before if t not in HOST_WINDOW_WORDS
    }
    assert _journal(project) == ["LabelSpeakerWindow"]
    after = ProjectWorkspace.open(project).project.history.head_id()
    assert after != head

    submit_host_document_command(project, "UndoHistory", {"expected_head_id": after})

    assert _labels(project) == before


def test_a_dry_run_reports_the_labels_and_saves_nothing(project: Path) -> None:
    saved_before = project.read_bytes()
    result = _cli_label(project)
    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["labeled"] == len(HOST_WINDOW_WORDS)
    assert json.loads(speaker_label_tool(str(project), "host", 0.0, 1.5))["dry_run"] is True
    assert project.read_bytes() == saved_before
    assert _journal(project) == []
