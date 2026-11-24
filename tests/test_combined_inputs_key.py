"""``combined_inputs_key`` moves with the inputs ``merge_transcripts`` reads (#1849 S1)."""

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.engines.transcript_sync import CombinedInputsKey, combined_inputs_key
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


def test_key_is_hashable_and_equal_keys_hash_equal(project: EpisodeProject) -> None:
    first = combined_inputs_key(project)
    second = combined_inputs_key(project)
    assert hash(first) == hash(second)
    assert {first: 1}[second] == 1


def test_key_holds_the_transcripts_it_names(project: EpisodeProject) -> None:
    key = combined_inputs_key(project)
    assert isinstance(key, CombinedInputsKey)
    assert len(key.held) == len(project.transcripts)
    assert all(h is t for h, t in zip(key.held, project.transcripts, strict=True))
    old_first = project.transcripts[0]
    project.transcripts = [Transcript(track_id="host", words=[]), project.transcripts[1]]
    assert key.held[0] is old_first
    assert id(old_first) == key.transcripts[0][0]


def test_replaced_transcript_with_same_ids_moves_the_key(project: EpisodeProject) -> None:
    before = combined_inputs_key(project)
    old_id = id(project.transcripts[0])
    project.transcripts[0] = Transcript(
        track_id="host", words=_words(("hello", 0.0, 0.4), ("there", 0.5, 0.9))
    )
    assert id(project.transcripts[0]) != old_id
    assert combined_inputs_key(project) != before


def test_old_transcript_identity_cannot_be_reused_while_key_lives(
    project: EpisodeProject,
) -> None:
    before = combined_inputs_key(project)
    old_ids = {id(t) for t in project.transcripts}
    project.transcripts = []
    replacements = [
        Transcript(track_id="host", words=_words(("changed", 0.0, 0.4))) for _ in range(64)
    ]
    assert old_ids.isdisjoint(id(t) for t in replacements)
    project.transcripts = replacements[:1]
    assert combined_inputs_key(project) != before


def test_speaker_none_to_value_moves_the_key(project: EpisodeProject) -> None:
    project.timeline.tracks[0].speaker = None
    before = combined_inputs_key(project)
    project.timeline.tracks[0].speaker = "Host"
    assert combined_inputs_key(project) != before


def test_speaker_value_to_none_moves_the_key(project: EpisodeProject) -> None:
    before = combined_inputs_key(project)
    project.timeline.tracks[0].speaker = None
    assert combined_inputs_key(project) != before


def test_in_place_transcript_track_id_write_moves_the_key(project: EpisodeProject) -> None:
    before = combined_inputs_key(project)
    project.transcripts[0].track_id = "guest"
    assert combined_inputs_key(project) != before


def test_in_place_transcript_source_id_write_moves_the_key(project: EpisodeProject) -> None:
    before = combined_inputs_key(project)
    project.transcripts[0].source_id = "take-2"
    assert combined_inputs_key(project) != before


def test_reordering_transcripts_moves_the_key(project: EpisodeProject) -> None:
    before = combined_inputs_key(project)
    project.transcripts.reverse()
    assert combined_inputs_key(project) != before


def test_removing_a_track_moves_the_key(project: EpisodeProject) -> None:
    before = combined_inputs_key(project)
    project.timeline.tracks = project.timeline.tracks[:1]
    assert combined_inputs_key(project) != before


def test_track_id_only_write_moves_the_key(project: EpisodeProject) -> None:
    before = combined_inputs_key(project)
    project.transcripts[1].track_id = "host"
    assert combined_inputs_key(project) != before
