from __future__ import annotations

import json

from podcast_mcp.history import HistoryManager
from podcast_mcp.models import (
    EpisodeProject,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.services import EditService, ProjectWorkspace


def _project_with_transcript(tmp_path) -> ProjectWorkspace:
    ws_dir = tmp_path / "ep"
    ws_dir.mkdir()
    p = EpisodeProject.create("hist", str(ws_dir))
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="teh", start=0.0, end=0.5, confidence=0.4),
                TranscriptWord(text="Shotterfield", start=1.0, end=2.0, confidence=0.3),
            ],
        )
    ]
    path = ws_dir / "episode.project.json"
    save_project(p, path)
    HistoryManager(path).record(p, "initial", force=True)
    save_project(p, path)
    return ProjectWorkspace.open(path)


def test_apply_transcript_cleanup_records_undo_step(tmp_path) -> None:
    ws = _project_with_transcript(tmp_path)
    svc = EditService(ws)
    payload = {
        "words": [{"word_index": 0, "text": "the"}],
        "phrases": [{"start_word_index": 1, "end_word_index": 1, "text": "Shot of Truth"}],
    }
    n = svc.apply_transcript_cleanup("host", **payload)
    assert n == 2
    assert ws.project.transcripts[0].words[0].text == "the"

    mgr = HistoryManager(ws.path)
    proj = load_project(ws.path)
    status = mgr.status(proj)
    assert status.can_undo
    assert any("transcript cleanup" in e.label for e in mgr.list_entries(proj))

    mgr.undo(proj)
    save_project(proj, ws.path)
    restored = load_project(ws.path)
    assert restored.transcripts[0].words[0].text == "teh"
    assert restored.transcripts[0].words[1].text == "Shotterfield"


def test_apply_transcript_cleanup_mcp_tool(tmp_path) -> None:
    from podcast_mcp.mcp import server as mcp_server

    ws = _project_with_transcript(tmp_path)
    out = mcp_server.apply_transcript_cleanup_tool(
        str(ws.path),
        "host",
        json.dumps({"words": [{"word_index": 0, "text": "the"}]}),
    )
    data = json.loads(out)
    assert data["applied"] == 1
    proj = load_project(ws.path)
    assert proj.transcripts[0].words[0].text == "the"
