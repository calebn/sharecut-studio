from __future__ import annotations

from pathlib import Path

from podcast_mcp.fixture_seed import seed_canned_transcript
from podcast_mcp.models import load_project


def test_seed_canned_transcript(minimal_project, tmp_path: Path) -> None:
    canned = Path(__file__).parent / "fixtures" / "canned_transcript_aligned.json"
    tracks = seed_canned_transcript(minimal_project, canned)
    assert tracks
    proj = load_project(minimal_project)
    assert proj.transcripts
    assert proj.combined_transcript and proj.combined_transcript.utterances
