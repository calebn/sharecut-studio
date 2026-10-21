"""Word commands address one take of a multi-take lane (#1476)."""

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.transcript_correct import (
    correct_phrase,
    correct_word,
    set_word_automatic,
    set_word_suppressed,
    set_words_ignored,
)
from podcast_mcp.models import EpisodeProject, Track, TrackRole, Transcript, TranscriptWord
from podcast_mcp.util.coded_error import CodedValueError


def _words(prefix: str) -> list[TranscriptWord]:
    return [
        TranscriptWord(text=f"{prefix}{n}", start=float(n), end=n + 0.4, confidence=0.9)
        for n in range(3)
    ]


@pytest.fixture
def project(tmp_path: Path) -> EpisodeProject:
    p = EpisodeProject.create("ep", str(tmp_path))
    p.timeline.tracks = [Track(id="v", label="v", role=TrackRole.DIALOGUE, speaker="v")]
    p.transcripts = [
        Transcript(track_id="v", source_id="take1", words=_words("a")),
        Transcript(track_id="v", source_id="take2", words=_words("b")),
    ]
    return p


def _texts(project: EpisodeProject, source_id: str) -> list[str]:
    return [w.text for w in project.transcript_for_source("v", source_id).words]


def test_correct_word_changes_only_the_named_take(project) -> None:
    correct_word(project, "v", 1, "fixed", source_id="take2", defaults=load_defaults())
    assert _texts(project, "take2") == ["b0", "fixed", "b2"]
    assert _texts(project, "take1") == ["a0", "a1", "a2"]


def test_correct_phrase_changes_only_the_named_take(project) -> None:
    correct_phrase(project, "v", 0, 1, "one phrase", source_id="take2", defaults=load_defaults())
    assert "one" in _texts(project, "take2")
    assert _texts(project, "take1") == ["a0", "a1", "a2"]


def test_suppress_automatic_and_ignore_touch_only_the_named_take(project) -> None:
    result = set_word_suppressed(project, "v", 2, True, source_id="take2", defaults=load_defaults())
    assert result["source_id"] == "take2"
    assert project.transcript_for_source("v", "take2").words[2].suppressed
    assert not project.transcript_for_source("v", "take1").words[2].suppressed

    assert set_word_automatic(project, "v", 2, source_id="take2")["source_id"] == "take2"
    assert not project.transcript_for_source("v", "take2").words[2].audibility_locked

    assert set_words_ignored(project, "v", 0, 1, True, source_id="take2")["source_id"] == "take2"
    assert not any(w.ignored for w in project.transcript_for_source("v", "take1").words)


@pytest.mark.parametrize(
    "call",
    [
        lambda p: correct_word(p, "v", 0, "x", defaults=load_defaults()),
        lambda p: correct_phrase(p, "v", 0, 1, "x", defaults=load_defaults()),
        lambda p: set_word_suppressed(p, "v", 0, True, defaults=load_defaults()),
        lambda p: set_word_automatic(p, "v", 0),
        lambda p: set_words_ignored(p, "v", 0, 1, True),
    ],
)
def test_bare_index_on_multi_take_lane_is_refused(project, call) -> None:
    with pytest.raises(CodedValueError) as err:
        call(project)
    assert err.value.code == "word_source_required"
    assert _texts(project, "take1") == ["a0", "a1", "a2"]
    assert _texts(project, "take2") == ["b0", "b1", "b2"]


def test_single_transcript_lane_needs_no_source(project) -> None:
    project.transcripts = [Transcript(track_id="v", words=_words("a"))]
    correct_word(project, "v", 0, "ok", defaults=load_defaults())
    assert project.transcripts[0].words[0].text == "ok"


def test_bare_index_addresses_the_primary_transcript(project) -> None:
    project.transcripts.insert(0, Transcript(track_id="v", words=_words("p")))
    correct_word(project, "v", 0, "primary", defaults=load_defaults())
    assert project.transcripts[0].words[0].text == "primary"
    assert _texts(project, "take1") == ["a0", "a1", "a2"]
