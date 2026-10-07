"""Behaviour docs/pipeline.md § Long raw sessions relies on (#535)."""

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.config import load_defaults
from podcast_mcp.models import (
    Clip,
    EditMode,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.pipeline import steps
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService
from podcast_mcp.services.media.transcript_refine import TranscriptRefineService


def _raw_session(minimal_project: Path) -> ProjectWorkspace:
    p = load_project(minimal_project)
    p.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    p.clips = [
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
    save_project(p, minimal_project)
    return ProjectWorkspace.open(minimal_project)


@pytest.mark.refine_gate
def test_content_ripple_drops_cut_words_and_keeps_refine_waive(minimal_project):
    ws = _raw_session(minimal_project)
    refine = TranscriptRefineService(ws)
    refine.waive(reason="lab prep", source="agent")

    EditService(ws).cut_range(0.0, 1.0, use_inaudible_opt=False, mode=EditMode.RIPPLE)

    assert [w.text for w in ws.project.transcripts[0].words] == ["welcome", "everyone"]
    assert refine.status()["clear"] is True
    EditService(ws).propose_tighten()


def test_analyze_focus_cuts_skips_without_outline_when_disabled(minimal_project):
    ws = _raw_session(minimal_project)
    defaults = load_defaults()
    defaults.setdefault("focus", {})["enabled"] = False

    assert steps.analyze_focus_cuts(ws.project, defaults) == "skipped (focus.enabled=false)"
    assert not (ws.project.artifacts_dir() / "focus_outline.md").exists()
