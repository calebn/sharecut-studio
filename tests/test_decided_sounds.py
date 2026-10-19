"""Which pending proposals count as a sound an earlier run already decided (#1601)."""

from __future__ import annotations

import pytest

from podcast_mcp.edits.suggested_actions import drop_decided_sounds, is_decided_sound
from podcast_mcp.models import (
    EditDecision,
    EditDecisionType,
    MediaAsset,
    SoundActionRecord,
    SourceRecording,
    Track,
    TrackRole,
    load_project,
)

LAUGH = "filler:acoustic:likely_laugh"


def _decision(
    start: float, end: float, *, reason: str = LAUGH, source_id: str | None = None, did: str = "d"
) -> EditDecision:
    return EditDecision(
        id=did,
        track_id="host",
        source_id=source_id,
        type=EditDecisionType.REMOVE,
        start=start,
        end=end,
        reason=reason,
        applied=False,
    )


@pytest.fixture
def project(minimal_project):
    proj = load_project(minimal_project)
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    proj.editorial.sound_actions = [
        SoundActionRecord(track_id="host", start_s=1.0, end_s=2.0, action="leave")
    ]
    return proj


@pytest.mark.parametrize(
    ("start", "end", "decided"),
    [
        (1.0, 2.0, True),  # the same sound
        (1.02, 2.03, True),  # a re-scan moved the edges a little
        (1.25, 2.0, True),  # exactly three quarters of the record: the boundary is decided
        (1.0, 2.25, True),  # the proposal reaches a little past the record
        (1.5, 2.0, False),  # half of the record is not the record
        (1.0, 2.5, False),  # the record is two thirds of the proposal: the rest is fresh
        (1.0, 3.0, False),  # half the proposal is fresh
        (1.0, 1.3, False),  # a small piece of a long sound
        (2.0, 3.0, False),  # abutting, no overlap
    ],
)
def test_a_proposal_is_decided_only_when_it_and_a_record_cover_each_other(
    project, start, end, decided
) -> None:
    assert is_decided_sound(project, _decision(start, end)) is decided


def test_a_record_for_another_track_decides_nothing(project) -> None:
    other = _decision(1.0, 2.0).model_copy(update={"track_id": "guest"})
    assert is_decided_sound(project, other) is False


def test_the_source_id_matches_the_way_apply_lower_matches_it(project) -> None:
    project.sources = [SourceRecording(id="host-rec", path="raw/host.wav")]
    # The track's own media and the named recording are one file, so one sound.
    assert is_decided_sound(project, _decision(1.0, 2.0, source_id="host-rec")) is True
    project.sources.append(SourceRecording(id="other", path="raw/other.wav"))
    assert is_decided_sound(project, _decision(1.0, 2.0, source_id="other")) is False
    assert is_decided_sound(project, _decision(1.0, 2.0, source_id="unknown")) is False


def test_a_record_on_one_recording_does_not_decide_the_same_span_of_another(project) -> None:
    project.sources = [
        SourceRecording(id="host-rec", path="raw/host.wav"),
        SourceRecording(id="other", path="raw/other.wav"),
    ]
    project.editorial.sound_actions = [
        SoundActionRecord(
            track_id="host", source_id="other", start_s=1.0, end_s=2.0, action="lower"
        )
    ]
    assert is_decided_sound(project, _decision(1.0, 2.0, source_id="other")) is True
    assert is_decided_sound(project, _decision(1.0, 2.0, source_id="host-rec")) is False


def test_dropping_decided_sounds_keeps_speech_edits_and_applied_rows_beside_them(project) -> None:
    decided = _decision(1.0, 2.0, did="laugh")
    fresh = _decision(1.0, 3.0, did="bigger")
    um = _decision(1.0, 2.0, reason="filler:um", did="um")
    applied = _decision(1.0, 2.0, did="done").model_copy(update={"applied": True})
    project.edit_decisions = [decided, fresh, um, applied]

    assert drop_decided_sounds(project) == 1
    assert [e.id for e in project.edit_decisions] == ["bigger", "um", "done"]
