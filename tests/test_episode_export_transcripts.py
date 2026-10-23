from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.models import (
    Clip,
    CombinedTranscript,
    CombinedUtterance,
    MediaAsset,
    Track,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.pipeline import PipelineService


def test_episode_export_refreshes_edited_transcripts_and_reports_their_paths(
    minimal_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = load_project(minimal_project)
    project.name = "edited-episode"
    project.tracks = [
        Track(id="host", label="Host", media=MediaAsset(path="raw/host.wav", duration_sec=6))
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="Hello.", start=0, end=1),
                TranscriptWord(text="Removed.", start=2, end=2.5),
                TranscriptWord(text="Later.", start=4, end=5),
            ],
        )
    ]
    project.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(track_id="host", speaker="Host", start=2, end=2.5, text="Removed.")
        ]
    )
    project.clips = [
        Clip(id="first", track_id="host", source_start=0, source_end=1, timeline_start=0),
        Clip(id="last", track_id="host", source_start=3, source_end=6, timeline_start=1),
    ]
    project.ensure_dirs()
    (project.workspace_path() / "raw/host.wav").write_bytes(b"source audio")
    master = project.artifacts_dir() / "mastered.wav"
    master.write_bytes(b"mastered audio")
    project.export_dir().mkdir(exist_ok=True)
    for extension in ("srt", "md"):
        (project.export_dir() / f"edited-episode.{extension}").write_text("Old Removed. at 4s")
    save_project(project, minimal_project)
    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.service.pipeline_steps.ensure_current_master",
        lambda *_args: master,
    )

    result = PipelineService(ProjectWorkspace.open(minimal_project)).export_audio(formats=[])

    assert {path.name for path in result.paths} == {
        "edited-episode.wav",
        "edited-episode.srt",
        "edited-episode.md",
    }
    assert (project.export_dir() / "edited-episode.wav").read_bytes() == b"mastered audio"
    subtitles = (project.export_dir() / "edited-episode.srt").read_text()
    markdown = (project.export_dir() / "edited-episode.md").read_text()
    assert "Removed" not in subtitles
    assert "Removed" not in markdown
    assert "00:00:02,000 --> 00:00:03,000\nLater." in subtitles
    assert "[2.0s]: Later." in markdown
