from __future__ import annotations

from pathlib import Path

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.transcript_search import ensure_combined_transcript
from podcast_mcp.gui.routes.export_files import list_exported_files
from podcast_mcp.export.names import sanitize_export_stem
from podcast_mcp.models import Transcript, TranscriptWord, load_project, save_project
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import ExportFilesService, TranscriptService


def test_dotted_project_stem_keeps_detailed_and_readable_formats_distinct(
    minimal_project: Path,
) -> None:
    project = load_project(minimal_project)
    project.name = "Episode.readable"
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="Hello", start=0.0, end=0.5)],
        )
    ]
    ensure_combined_transcript(project, defaults=load_defaults())
    save_project(project, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    with write_grant(WriteGrantKind.LEGACY_MCP):
        TranscriptService(ws).export(["txt", "readable.txt"])

    rows = {row.id: row for row in ExportFilesService(ws).list()}
    response_rows = {row["id"]: row for row in list_exported_files(ws)["files"]}
    stem = sanitize_export_stem("Episode.readable")

    assert (rows[f"{stem}.txt"].format, rows[f"{stem}.txt"].label, rows[f"{stem}.txt"].current) == (
        "txt",
        "Plain text",
        True,
    )
    assert (
        rows[f"{stem}.readable.txt"].format,
        rows[f"{stem}.readable.txt"].label,
        rows[f"{stem}.readable.txt"].current,
    ) == ("readable.txt", "Reading copy", True)
    assert response_rows[f"{stem}.txt"]["format"] == "txt"
    assert response_rows[f"{stem}.readable.txt"]["format"] == "readable.txt"

    (ws.project.export_dir() / f"{stem}.readable.txt").write_text(
        "Changed reading copy", encoding="utf-8"
    )
    readable_stale = {row.id: row for row in ExportFilesService(ws).list()}
    assert readable_stale[f"{stem}.txt"].current is True
    assert readable_stale[f"{stem}.readable.txt"].current is False

    def edit_transcript(project) -> None:
        project.transcripts[0].words[0].text = "Changed"
        ensure_combined_transcript(project, defaults=load_defaults())

    with write_grant(WriteGrantKind.LEGACY_MCP):
        ws.mutate("before identity test edit", "after identity test edit", edit_transcript)
    stale = {row.id: row for row in ExportFilesService(ws).list()}
    assert stale[f"{stem}.txt"].current is False
    assert stale[f"{stem}.readable.txt"].current is False
