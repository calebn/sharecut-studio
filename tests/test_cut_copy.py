from __future__ import annotations

from podcast_mcp.edits.cut_application import _cut_copy
from podcast_mcp.models import EpisodeProject
from podcast_mcp.models.episode import Transcript, TranscriptWord


def _project() -> EpisodeProject:
    project = EpisodeProject.create("t", "/tmp/t")
    project.transcript_data.per_track.append(
        Transcript(track_id="a", words=[TranscriptWord(text="hi", start=0.0, end=0.5)])
    )
    return project


def test_cut_copy_keeps_the_word_objects_and_copies_the_rest():
    project = _project()
    copy = _cut_copy(project)
    assert copy == project
    assert copy.transcripts[0] is not project.transcripts[0]
    assert copy.transcripts[0].words is not project.transcripts[0].words
    assert copy.transcripts[0].words[0] is project.transcripts[0].words[0]
    copy.transcripts[0].words.clear()
    copy.meta.name = "other"
    assert len(project.transcripts[0].words) == 1
    assert project.meta.name == "t"
