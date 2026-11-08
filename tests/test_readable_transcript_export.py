from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.transcript_search import ensure_combined_transcript
from podcast_mcp.models import Transcript, TranscriptWord, load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import TranscriptService


def _word(text: str, start: float) -> TranscriptWord:
    return TranscriptWord(text=text, start=start, end=start + 0.3)


def _workspace(path: Path) -> ProjectWorkspace:
    project = load_project(path)
    project.name = "Readable sample"
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                _word("First", 0),
                _word("thought.", 0.4),
                _word("Second", 1.2),
                _word("idea!", 1.6),
            ],
        ),
        Transcript(track_id="guest", words=[_word("Reply.", 3)]),
    ]
    ensure_combined_transcript(project, defaults=load_defaults())
    save_project(project, path)
    return ProjectWorkspace.open(path)


def test_service_exports_readable_paragraphs_with_one_header(minimal_project: Path) -> None:
    ws = _workspace(minimal_project)

    result = TranscriptService(ws).export(["readable.txt"])

    assert result.files[0].name == "Readable sample.readable.txt"
    assert Path(result.files[0].path).read_text(encoding="utf-8") == (
        "Readable sample\n"
        "Language: en\n\n"
        "host  0:00\n"
        "First thought. Second idea!\n\n"
        "guest  0:03\n"
        "Reply.\n"
    )


def test_service_keeps_nonadjacent_speaker_turns_separate(minimal_project: Path) -> None:
    ws = _workspace(minimal_project)
    project = load_project(ws.path)
    project.transcripts = [
        Transcript(track_id="host", words=[_word("A.", 0), _word("A-again.", 4)]),
        Transcript(track_id="guest", words=[_word("B.", 2)]),
    ]
    ensure_combined_transcript(project, defaults=load_defaults())
    save_project(project, ws.path)

    result = TranscriptService(ws).export(["readable.txt"])

    assert Path(result.files[0].path).read_text(encoding="utf-8") == (
        "Readable sample\nLanguage: en\n\n"
        "host  0:00\nA.\n\n"
        "guest  0:02\nB.\n\n"
        "host  0:04\nA-again.\n"
    )


def test_legacy_formats_remain_available(minimal_project: Path) -> None:
    ws = _workspace(minimal_project)

    result = TranscriptService(ws).export(["txt", "md", "srt", "vtt"])

    assert [item.format for item in result.files] == ["txt", "md", "srt", "vtt"]
    assert (
        Path(result.files[0].path)
        .read_text(encoding="utf-8")
        .startswith("Readable sample\nLanguage: en\n\n")
    )


def test_unknown_format_still_fails_at_service_boundary(minimal_project: Path) -> None:
    ws = _workspace(minimal_project)

    with pytest.raises(ValueError, match="html") as error:
        TranscriptService(ws).export(["html"])

    assert getattr(error.value, "code", None) == "invalid_format"
