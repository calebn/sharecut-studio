from __future__ import annotations

from pathlib import Path

from podcast_mcp.edits.audition_context import build_audition_context
from podcast_mcp.edits.transcript_correct import correct_word
from podcast_mcp.edits.transcript_cuts import cut_utterance, search_transcript
from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.export.transcript import CaptionLimits, utterances_to_srt
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)


def _words(prefix: str, starts: list[float], **kw: object) -> list[TranscriptWord]:
    return [
        TranscriptWord(text=f"{prefix}{n}", start=s, end=s + 0.4, confidence=0.9, **kw)
        for n, s in enumerate(starts)
    ]


def _two_take_project(tmp_path: Path) -> EpisodeProject:
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id=tid, label=tid, role=TrackRole.DIALOGUE, speaker=tid) for tid in ("vicky", "dani")
    ]
    project.clips = [
        Clip(
            id="c2",
            track_id="vicky",
            source_id="take2",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        ),
        Clip(
            id="c3",
            track_id="vicky",
            source_id="take3",
            source_start=0.0,
            source_end=20.0,
            timeline_start=10.0,
        ),
        Clip(id="cd", track_id="dani", source_start=0.0, source_end=30.0, timeline_start=0.0),
    ]
    project.transcripts = [
        Transcript(track_id="vicky", source_id="take2", words=_words("a", [1.0, 4.5])),
        Transcript(
            track_id="vicky", source_id="take3", words=_words("b", [1.0, 4.5, 8.0, 12.0, 18.0])
        ),
        Transcript(track_id="dani", words=_words("d", [16.0])),
    ]
    project.combined_transcript = TranscriptionEngine().merge_transcripts(project)
    return project


def test_correct_word_on_later_take_leaves_first_take_text(tmp_path: Path) -> None:
    project = _two_take_project(tmp_path)
    correct_word(project, "vicky", 0, "FIXED", "take3")
    assert project.transcripts[0].words[0].text == "a0"
    assert project.transcripts[1].words[0].text == "FIXED"


def test_caption_export_places_each_take_on_its_own_clip(tmp_path: Path) -> None:
    srt = utterances_to_srt(
        _two_take_project(tmp_path),
        limits=CaptionLimits(min_duration_sec=0.1, max_duration_sec=7.0),
    )
    assert "00:00:01,000 --> 00:00:01,400\na0" in srt
    assert "00:00:11,000 --> 00:00:11,400\nb0" in srt
    assert "00:00:01,000 --> 00:00:11,400" not in srt


def test_search_maps_first_take_utterance_through_its_own_clip(tmp_path: Path) -> None:
    matches = [m for m in search_transcript(_two_take_project(tmp_path), "a1") if m.text == "a1"]
    assert len(matches) == 1
    assert matches[0].timeline_start == 4.5
    assert matches[0].timeline_end == 4.9


def test_cut_utterance_on_later_take_leaves_first_take_clip(tmp_path: Path) -> None:
    project = _two_take_project(tmp_path)
    assert project.combined_transcript is not None
    index = next(
        i for i, utt in enumerate(project.combined_transcript.utterances) if utt.text == "b0"
    )
    decision = cut_utterance(project, index)
    take2 = next(clip for clip in project.clips if clip.id == "c2")
    assert (take2.source_start, take2.source_end, take2.timeline_start) == (0.0, 10.0, 0.0)
    assert decision.track_id == "vicky"
    assert project.edit_decisions == [decision]


def test_play_context_does_not_treat_a_second_take_as_clip_skew(tmp_path: Path) -> None:
    ctx = build_audition_context(
        _two_take_project(tmp_path),
        14.0,
        16.0,
        skew_warn_sec=0.05,
        include_dsp=False,
        include_prosody=False,
    )
    assert ctx["clip_skew"]["any_skewed"] is False
    assert ctx["clip_skew"]["warnings"] == []
