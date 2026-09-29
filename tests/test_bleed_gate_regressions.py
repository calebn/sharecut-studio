from pathlib import Path

import pytest

from podcast_mcp.engines.audio_audit import analyze_gate_overreach
from podcast_mcp.engines.play_audit import proxy_render_hash, track_render_hash
from podcast_mcp.models import EpisodeProject, Track, Transcript, TranscriptWord


def gated_project(tmp_path: Path) -> EpisodeProject:
    project = EpisodeProject.create("gate regression", str(tmp_path))
    project.timeline.tracks = [Track(id="host", label="Host", transcript_gate=True)]
    project.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="hello", start=1, end=2)])
    ]
    return project


def test_transcript_gate_without_noise_gate_is_identified(tmp_path: Path) -> None:
    project = gated_project(tmp_path)
    report = analyze_gate_overreach(project, "host")
    assert report["gate_present"] is True
    assert report["risk"] == "unknown"


@pytest.mark.parametrize("fingerprint", [track_render_hash, proxy_render_hash])
@pytest.mark.parametrize("field,value", [("start", 1.2), ("end", 2.2), ("suppressed", True)])
def test_gated_audio_cache_tracks_word_edits(tmp_path: Path, fingerprint, field, value) -> None:
    project = gated_project(tmp_path)
    before = fingerprint(project, "host")
    setattr(project.transcripts[0].words[0], field, value)
    assert fingerprint(project, "host") != before


@pytest.mark.parametrize("fingerprint", [track_render_hash, proxy_render_hash])
def test_ungated_audio_cache_ignores_caption_timing(tmp_path: Path, fingerprint) -> None:
    project = gated_project(tmp_path)
    project.timeline.tracks[0].transcript_gate = False
    before = fingerprint(project, "host")
    project.transcripts[0].words[0].start = 1.2
    assert fingerprint(project, "host") == before
