"""Fillers on one track apply as a batch the way they apply one at a time (#1403).

Each mute fill the batch lays is a new leaf of the host clip, placed at one fixed lead from
its hole. A later batch edit sees the earlier fills in its BEFORE graph, and must bind its own
new fill to the earlier fill that holds the same source, not to any fill at the same offset.
"""

from __future__ import annotations

import itertools
from pathlib import Path

import pytest

from pause_policy_public_helpers import configure, defaults, room, voice, write_wav
from podcast_mcp.edits.cut_application import approve_edits
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.edits.tighten import propose_tighten_edits
from podcast_mcp.edits.transcript_refine_status import mark_refine_done
from podcast_mcp.models import (
    Clip,
    CutIntent,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)

DURATION = 12.0
HOST_WORDS = [
    ("so", 0.3, 0.6),
    ("um", 1.0, 1.35),
    ("we", 1.5, 1.8),
    ("went", 1.85, 2.2),
    ("there", 3.6, 3.9),
    ("uh", 5.0, 5.3),
    ("and", 5.5, 5.8),
    ("then", 7.9, 8.2),
    ("um", 9.0, 9.3),
    ("ok", 9.4, 9.7),
]


def _project(tmp_path: Path) -> EpisodeProject:
    project = EpisodeProject.create("fill-occurrences", str(tmp_path))
    audio = room(DURATION, seed=11)
    for _, start, end in HOST_WORDS:
        voice(audio, start, end)
    write_wav(tmp_path / "raw/host.wav", audio)
    project.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=DURATION, sample_rate=16000),
        )
    )
    project.clips.append(
        Clip(id="full-host", track_id="host", source_start=0, source_end=DURATION, timeline_start=0)
    )
    project.transcripts.append(
        Transcript(
            track_id="host",
            words=[TranscriptWord(text=w, start=s, end=e) for w, s, e in HOST_WORDS],
        )
    )
    project.timeline.duration_sec = DURATION
    mark_refine_done(project, notes="synthetic scene")
    return project


@pytest.fixture
def fillers(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    cfg = defaults()
    cfg["tighten"].update(filler_words=["um", "uh"], edit_mode="mute", apply_pause_trims=False)
    configure(monkeypatch, cfg)
    project = _project(tmp_path)
    propose_tighten_edits(project, cfg, edit_mode="mute")
    ids = sorted(e.id for e in project.edit_decisions if (e.reason or "").startswith("filler:"))
    assert len(ids) == 3
    return project, ids


@pytest.mark.parametrize("intent", [CutIntent.PROGRAMMATIC, CutIntent.HUMAN_BOUNDARIES])
def test_every_subset_of_mute_fillers_applies_as_a_batch(fillers, intent: CutIntent) -> None:
    project, ids = fillers
    for size in (2, 3):
        for subset in itertools.combinations(ids, size):
            batch = project.model_copy(deep=True)
            assert approve_edits(batch, list(subset), application_intent=intent) == size


def test_a_batch_applies_the_fills_one_at_a_time_applies(fillers) -> None:
    project, ids = fillers
    batch = project.model_copy(deep=True)
    assert approve_edits(batch, ids, application_intent=CutIntent.PROGRAMMATIC) == 3
    sequential = project.model_copy(deep=True)
    for edit_id in ids:
        assert approve_edits(sequential, [edit_id], application_intent=CutIntent.PROGRAMMATIC) == 1

    def lane(p: EpisodeProject):
        return sorted(
            (round(c.source_start, 3), round(c.source_end, 3), round(c.timeline_start, 3))
            for c in p.clips
        )

    assert lane(batch) == lane(sequential)


@pytest.mark.parametrize("intent", [CutIntent.PROGRAMMATIC, CutIntent.HUMAN_BOUNDARIES])
def test_a_source_the_timeline_plays_twice_is_still_refused(fillers, intent: CutIntent) -> None:
    project, ids = fillers
    replayed = project.model_copy(deep=True)
    replayed.clips.append(
        replayed.clips[0].model_copy(update={"id": "replay", "timeline_start": 20})
    )
    for selected in (ids[:1], ids):
        with pytest.raises(ScopeChangedAtApproval):
            approve_edits(replayed.model_copy(deep=True), selected, application_intent=intent)
