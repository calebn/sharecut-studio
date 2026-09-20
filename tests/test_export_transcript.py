from __future__ import annotations

from podcast_mcp.export.transcript import (
    combined_transcript_markdown,
    utterances_to_srt,
    utterances_to_vtt,
    write_combined_transcript_markdown,
)
from podcast_mcp.models import (
    Clip,
    CombinedTranscript,
    CombinedUtterance,
    EpisodeProject,
    MediaAsset,
    Track,
)


def _project_with_combined() -> EpisodeProject:
    project = EpisodeProject.create("export-test", "/tmp/ws")
    project.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=1.5,
                text="Hello world",
            ),
            CombinedUtterance(
                track_id="guest",
                speaker="Guest",
                start=2.0,
                end=4.25,
                text="Thanks for listening",
            ),
        ]
    )
    return project


def test_combined_transcript_markdown():
    md = combined_transcript_markdown(_project_with_combined())
    assert "# export-test" in md
    assert "**Host** [0.0s]: Hello world" in md
    assert "**Guest** [2.0s]: Thanks for listening" in md


def test_write_combined_transcript_markdown(tmp_path):
    project = EpisodeProject.create("export-test", str(tmp_path))
    project.combined_transcript = _project_with_combined().combined_transcript
    out = write_combined_transcript_markdown(project)
    assert out.is_file()
    assert out.name == "export-test.md"
    assert "Hello world" in out.read_text(encoding="utf-8")


def test_utterances_to_srt():
    srt = utterances_to_srt(_project_with_combined())
    assert "00:00:00,000 --> 00:00:01,500" in srt
    assert "Hello world" in srt
    assert "00:00:02,000 --> 00:00:04,250" in srt


def test_utterances_to_vtt():
    vtt = utterances_to_vtt(_project_with_combined())
    assert vtt.startswith("WEBVTT")
    assert "00:00:00.000 --> 00:00:01.500" in vtt
    assert "Thanks for listening" in vtt


def _compressed_project(tmp_path) -> EpisodeProject:
    """Source 0-60 kept, 60-90 cut, 90-200 kept (30s removed at 60s)."""
    project = EpisodeProject.create("compressed", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", media=MediaAsset(path="raw/host.wav", duration_sec=200.0))
    ]
    project.timeline.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=60.0, timeline_start=0.0),
        Clip(id="c2", track_id="host", source_start=90.0, source_end=200.0, timeline_start=60.0),
    ]
    project.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(track_id="host", speaker="Host", start=10.0, end=12.0, text="early"),
            CombinedUtterance(
                track_id="host", speaker="Host", start=70.0, end=75.0, text="cut away"
            ),
            CombinedUtterance(
                track_id="host", speaker="Host", start=100.0, end=102.0, text="later"
            ),
        ]
    )
    return project


def test_srt_uses_timeline_clock_and_drops_cut_utterances(tmp_path):
    srt = utterances_to_srt(_compressed_project(tmp_path))
    # "later" at source 100 must map to timeline 70, not 100.
    assert "00:00:10,000 --> 00:00:12,000" in srt
    assert "00:01:10,000 --> 00:01:12,000" in srt
    assert "later" in srt
    # The utterance entirely inside the removed 60-90s region is dropped.
    assert "cut away" not in srt
    assert "00:01:40" not in srt
