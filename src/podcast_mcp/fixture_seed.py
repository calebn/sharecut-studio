from __future__ import annotations

import json
from pathlib import Path

from podcast_mcp.engines import TranscriptionEngine
from podcast_mcp.models import CombinedTranscript, Transcript
from podcast_mcp.project_store import ProjectStore


def seed_canned_transcript(
    project_path: Path | str,
    canned_path: Path | str,
) -> list[str]:
    """Load canned transcript JSON into a project; returns track ids updated."""
    data = json.loads(Path(canned_path).read_text(encoding="utf-8"))
    store = ProjectStore(project_path)
    project = store.load()

    per = [Transcript.model_validate(t) for t in data.get("per_track", [])]
    project.transcripts = per
    combined_data = data.get("combined")
    if combined_data:
        project.combined_transcript = CombinedTranscript.model_validate(combined_data)
    else:
        project.combined_transcript = TranscriptionEngine().merge_transcripts(project)

    store.commit(project)
    return [t.track_id for t in per]
