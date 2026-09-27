"""Behaviour docs/pipeline.md § Long raw sessions relies on (#535)."""

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.transcript_refine_status import TranscriptRefineRequiredError
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    save_project,
)
from podcast_mcp.pipeline import steps
from podcast_mcp.services import EditService, ProjectWorkspace, TranscriptRefineService


def _raw_session(tmp_path: Path, sample_wav: Path) -> ProjectWorkspace:
    ws_dir = tmp_path / "ep"
    raw = ws_dir / "raw"
    raw.mkdir(parents=True)
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    p = EpisodeProject.create("content_cut", str(ws_dir))
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    p.timeline.clips = [
        Clip(id="full", track_id="host", source_start=0.0, source_end=2.0, timeline_start=0.0)
    ]
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="preshow", start=0.1, end=0.4),
                TranscriptWord(text="chatter", start=0.5, end=0.8),
                TranscriptWord(text="welcome", start=1.2, end=1.5),
                TranscriptWord(text="everyone", start=1.6, end=1.9),
            ],
        )
    ]
    save_project(p, ws_dir / "episode.project.json")
    return ProjectWorkspace.open(ws_dir / "episode.project.json")


@pytest.mark.refine_gate
def test_content_ripple_drops_cut_words_and_stales_refine_waive(tmp_path, sample_wav):
    ws = _raw_session(tmp_path, sample_wav)
    refine = TranscriptRefineService(ws)
    refine.waive(reason="lab prep", source="agent")
    assert refine.status()["clear"] is True

    EditService(ws).ripple_delete(0.0, 1.0, use_inaudible_opt=False)

    assert [w.text for w in ws.project.transcripts[0].words] == ["welcome", "everyone"]
    status = refine.status()
    assert status["stale"] is True
    assert status["clear"] is False
    with pytest.raises(TranscriptRefineRequiredError):
        EditService(ws).propose_tighten()

    refine.waive(reason="content cut: structural edit", source="agent")
    assert refine.status()["clear"] is True


def test_analyze_focus_cuts_skips_without_outline_when_disabled(tmp_path, sample_wav):
    ws = _raw_session(tmp_path, sample_wav)
    defaults = load_defaults()
    defaults.setdefault("focus", {})["enabled"] = False

    assert steps.analyze_focus_cuts(ws.project, defaults) == "skipped (focus.enabled=false)"
    assert not (ws.project.artifacts_dir() / "focus_outline.md").exists()
