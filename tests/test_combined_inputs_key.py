"""``combined_inputs_key`` moves exactly when ``merge_transcripts`` output can change (#1849 S1)."""

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.engines.transcript_sync import combined_inputs_key
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.models.words_revision import set_word, set_words


def _words(*rows: tuple[str, float, float]) -> list[TranscriptWord]:
    return [TranscriptWord(text=t, start=s, end=e, confidence=0.9) for t, s, e in rows]


@pytest.fixture
def project(tmp_path: Path) -> EpisodeProject:
    project = EpisodeProject.create("key", str(tmp_path))
    project.timeline.tracks = [
        Track(
            id=tid,
            label=name,
            role=TrackRole.DIALOGUE,
            speaker=name,
            media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=10.0),
        )
        for tid, name in (("host", "Host"), ("guest", "Guest"))
    ]
    project.timeline.clips = [
        Clip(id=f"{tid}-1", track_id=tid, source_start=0.0, source_end=10.0, timeline_start=0.0)
        for tid in ("host", "guest")
    ]
    project.transcripts = [
        Transcript(track_id="host", words=_words(("hello", 0.0, 0.4), ("there", 0.5, 0.9))),
        Transcript(track_id="guest", words=_words(("thanks", 5.0, 5.4))),
    ]
    return project


def test_key_is_stable_across_repeat_calls(project: EpisodeProject) -> None:
    assert combined_inputs_key(project) == combined_inputs_key(project)


def test_appending_a_transcript_moves_the_key(project: EpisodeProject) -> None:
    before = combined_inputs_key(project)
    project.transcripts.append(Transcript(track_id="guest", source_id="take-2", words=[]))
    assert combined_inputs_key(project) != before


def test_removing_a_transcript_moves_the_key(project: EpisodeProject) -> None:
    before = combined_inputs_key(project)
    project.transcripts = project.transcripts[:1]
    assert combined_inputs_key(project) != before


def test_changing_a_track_speaker_moves_the_key(project: EpisodeProject) -> None:
    before = combined_inputs_key(project)
    project.timeline.tracks[0].speaker = "Renamed"
    assert combined_inputs_key(project) != before


def test_set_words_moves_the_key(project: EpisodeProject) -> None:
    before = combined_inputs_key(project)
    set_words(project.transcripts[0], _words(("goodbye", 0.0, 0.4)))
    assert combined_inputs_key(project) != before


def test_set_word_moves_the_key(project: EpisodeProject) -> None:
    before = combined_inputs_key(project)
    transcript = project.transcripts[0]
    set_word(transcript, 0, transcript.words[0].model_copy(update={"text": "howdy"}))
    assert combined_inputs_key(project) != before


def test_in_place_word_edit_moves_the_key(project: EpisodeProject) -> None:
    before = combined_inputs_key(project)
    project.transcripts[0].words[1].suppressed = True
    assert combined_inputs_key(project) != before


def test_retained_bleed_replace_moves_the_key(project: EpisodeProject) -> None:
    before = combined_inputs_key(project)
    working = project.model_copy(deep=True)
    project.transcript_data = working.transcript_data
    assert combined_inputs_key(project) != before


def test_moving_a_clip_keeps_the_key(project: EpisodeProject) -> None:
    before = combined_inputs_key(project)
    project.timeline.clips[0].timeline_start = 2.5
    assert combined_inputs_key(project) == before


def test_volume_change_keeps_the_key(project: EpisodeProject) -> None:
    before = combined_inputs_key(project)
    project.timeline.tracks[0].fader_db = -3.0
    project.timeline.tracks[1].gain_db = 2.0
    assert combined_inputs_key(project) == before


def test_unrelated_edit_keeps_the_key(project: EpisodeProject) -> None:
    before = combined_inputs_key(project)
    project.timeline.tracks[0].label = "Relabelled"
    project.timeline.tracks[1].muted = True
    assert combined_inputs_key(project) == before


def test_noop_keeps_the_key(project: EpisodeProject) -> None:
    before = combined_inputs_key(project)
    project.timeline.tracks[0].speaker = "Host"
    project.transcripts[0].words[0].suppressed = False
    project.transcripts = list(project.transcripts)
    assert combined_inputs_key(project) == before
