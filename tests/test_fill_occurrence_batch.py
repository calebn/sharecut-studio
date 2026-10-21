"""Edits on one track apply as a batch the way they apply one at a time (#1403).

A fill or pad the batch lays is a copy of source audio. A later batch edit sees that copy
beside the original and must tell them apart: a mute fill binds to the earlier fill that
holds its source, not to any fill at the same lead from its hole, and a pad tile borrowed
from a pause's quiet does not make the pause's own quiet stop being original.
"""

from __future__ import annotations

import copy
import itertools
from pathlib import Path

import pytest

from pause_policy_public_helpers import configure, defaults, room, voice, write_wav
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.cut_application import approve_edits
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.edits.tighten import propose_tighten_edits
from podcast_mcp.edits.transcript_refine_status import REFINE_GATE
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
    REFINE_GATE.mark_done(project, notes="synthetic scene")
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
            assert (
                approve_edits(
                    batch, list(subset), application_intent=intent, defaults=load_defaults()
                )
                == size
            )


def test_a_batch_applies_the_fills_one_at_a_time_applies(fillers) -> None:
    project, ids = fillers
    batch = project.model_copy(deep=True)
    assert (
        approve_edits(
            batch, ids, application_intent=CutIntent.PROGRAMMATIC, defaults=load_defaults()
        )
        == 3
    )
    sequential = project.model_copy(deep=True)
    for edit_id in ids:
        assert (
            approve_edits(
                sequential,
                [edit_id],
                application_intent=CutIntent.PROGRAMMATIC,
                defaults=load_defaults(),
            )
            == 1
        )

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
            approve_edits(
                replayed.model_copy(deep=True),
                selected,
                application_intent=intent,
                defaults=load_defaults(),
            )


@pytest.fixture
def pad_over_pause(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    cfg = copy.deepcopy(load_defaults())
    cfg["tighten"].update(
        edit_mode="ripple",
        filler_words=["um", "uh"],
        inaudible_opt=False,
        join_continuity_gate=False,
        leave_in_if_risky=False,
        repetition_candidates=False,
        acoustic_gap_filler={"enabled": False},
    )
    cfg["performance"]["max_workers"] = 1
    configure(monkeypatch, cfg)
    project = _project(tmp_path)
    words = [
        *HOST_WORDS[:7],
        ("um", 7.0, 7.3),
        *HOST_WORDS[7:],
        ("um", 10.2, 10.5),
        ("so", 10.9, 11.1),
        ("uh", 11.4, 11.7),
    ]
    audio = room(DURATION, seed=11)
    for _, start, end in words:
        voice(audio, start, end)
    write_wav(tmp_path / "raw/host.wav", audio)
    project.transcripts[0].words = [TranscriptWord(text=w, start=s, end=e) for w, s, e in words]
    propose_tighten_edits(project, cfg, edit_mode="ripple")
    pause = next(e for e in project.edit_decisions if e.id.startswith("cut_pause_2200"))
    filler = next(e for e in project.edit_decisions if e.id.startswith("cut_filler_10200"))
    return project, filler.id, pause.id


@pytest.mark.parametrize("intent", [CutIntent.PROGRAMMATIC, CutIntent.HUMAN_BOUNDARIES])
def test_a_pad_borrowed_from_the_pause_quiet_does_not_veto_the_pause(
    pad_over_pause, intent: CutIntent
) -> None:
    project, filler, pause = pad_over_pause
    for selected in ([filler], [pause]):
        assert (
            approve_edits(
                project.model_copy(deep=True),
                selected,
                application_intent=intent,
                defaults=load_defaults(),
            )
            == 1
        )
    assert (
        approve_edits(project, [filler, pause], application_intent=intent, defaults=load_defaults())
        == 2
    )
