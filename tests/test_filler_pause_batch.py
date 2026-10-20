"""A filler cut and a pause trim on one track apply together as they apply one at a time (#1403).

The filler's room-tone pad is filled from audio inside the pause the same batch removes. That
pad is the filler's own recorded effect, so it does not make the pause removal incomplete.
"""

from __future__ import annotations

import dataclasses
from pathlib import Path

import pytest

from pause_policy_public_helpers import configure, defaults, room, voice, write_wav
from podcast_mcp.edits import cut_effects
from podcast_mcp.edits.cut_application import apply_auto_edits, approve_edits
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
from podcast_mcp.util.batch_scope import batch_scope

DURATION = 12.0
HOST_WORDS = [
    ("so", 0.3, 0.6),
    ("um", 1.0, 1.35),
    ("we", 1.5, 1.8),
    ("went", 1.85, 2.2),
    ("there", 3.6, 3.9),
    ("then", 7.9, 8.2),
]


def _project(tmp_path: Path) -> EpisodeProject:
    project = EpisodeProject.create("filler-pause", str(tmp_path))
    for index, tid in enumerate(("host", "guest")):
        audio = room(DURATION, seed=11 + index)
        if tid == "host":
            for _, start, end in HOST_WORDS:
                voice(audio, start, end)
        write_wav(tmp_path / "raw" / f"{tid}.wav", audio)
        project.tracks.append(
            Track(
                id=tid,
                label=tid.title(),
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=DURATION, sample_rate=16000),
            )
        )
        project.clips.append(
            Clip(
                id=f"full-{tid}",
                track_id=tid,
                source_start=0,
                source_end=DURATION,
                timeline_start=0,
            )
        )
        words = HOST_WORDS if tid == "host" else [("hm", 10.0, 10.2)]
        project.transcripts.append(
            Transcript(
                track_id=tid,
                words=[TranscriptWord(text=w, start=s, end=e) for w, s, e in words],
            )
        )
    project.timeline.duration_sec = DURATION
    REFINE_GATE.mark_done(project, notes="synthetic scene")
    return project


def load_defaults() -> dict:
    """The config ``configure`` staged for this test, not the shipped one."""
    from podcast_mcp.services.pipeline import config

    return config.load_defaults()


@pytest.fixture
def proposed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    cfg = defaults()
    cfg["tighten"].update(filler_words=["um"], edit_mode="ripple", max_pause_sec=0.5)
    configure(monkeypatch, cfg)
    project = _project(tmp_path)
    propose_tighten_edits(project, cfg, edit_mode="ripple")
    filler = next(e for e in project.edit_decisions if (e.reason or "").startswith("filler:"))
    pause = next(e for e in project.edit_decisions if (e.reason or "").startswith("pause:"))
    assert filler.start < pause.start
    return project, filler.id, pause.id


def _lane(project: EpisodeProject, track_id: str):
    return sorted(
        (round(c.source_start, 3), round(c.source_end, 3), round(c.timeline_start, 3))
        for c in project.clips
        if c.track_id == track_id
    )


@pytest.mark.parametrize("intent", [CutIntent.PROGRAMMATIC, CutIntent.HUMAN_BOUNDARIES])
def test_one_batch_applies_both_and_matches_approving_the_later_cut_first(
    proposed, intent: CutIntent
) -> None:
    project, filler, pause = proposed
    batch = project.model_copy(deep=True)
    assert (
        approve_edits(batch, [filler, pause], application_intent=intent, defaults=load_defaults())
        == 2
    )

    sequential = project.model_copy(deep=True)
    for edit_id in (pause, filler):
        assert (
            approve_edits(
                sequential, [edit_id], application_intent=intent, defaults=load_defaults()
            )
            == 1
        )

    assert _lane(batch, "host") == _lane(sequential, "host")
    assert [r.reason for r in batch.editorial.edit_log].count("filler:um") == 1


@pytest.mark.parametrize("order", [(0, 1), (1, 0)])
def test_sequential_approvals_apply_in_either_order(proposed, order: tuple[int, int]) -> None:
    project, filler, pause = proposed
    ids = (filler, pause)
    for index in order:
        assert (
            approve_edits(
                project,
                [ids[index]],
                application_intent=CutIntent.HUMAN_BOUNDARIES,
                defaults=load_defaults(),
            )
            == 1
        )


def test_auto_apply_takes_the_filler_and_the_pause_together(proposed) -> None:
    project, _, _ = proposed
    pending = len(project.edit_decisions)
    assert apply_auto_edits(project, defaults=load_defaults()) == pending
    assert [d for d in project.edit_decisions if not d.review_required] == []


def _batch_receipts(project, filler, pause, *, accepted_ids, widen_pad=0.0, shift_window=0.0):
    after = project.model_copy(deep=True)
    with batch_scope():
        approve_edits(
            after,
            [filler, pause],
            application_intent=CutIntent.HUMAN_BOUNDARIES,
            defaults=load_defaults(),
        )
        if widen_pad:
            pad = next(c for c in after.clips if c.id in cut_effects.native_pad_origins())
            pad.source_end += widen_pad
        if shift_window:
            origins = cut_effects.native_pad_origins()
            for clip_id, effect in list(origins.items()):
                moved = dataclasses.replace(effect.plan, at_time=effect.plan.at_time + shift_window)
                origins[clip_id] = dataclasses.replace(effect, plan=moved)
        accepted = [e for e in project.edit_decisions if e.id in accepted_ids]
        return cut_effects.complete_effect_receipts(project, after, accepted)


def test_the_filler_that_laid_the_pad_in_the_batch_owns_it(proposed) -> None:
    project, filler, pause = proposed
    assert _batch_receipts(project, filler, pause, accepted_ids={filler, pause}) == []


def test_a_pad_whose_owner_is_outside_the_accepted_set_still_makes_the_pause_removal_incomplete(
    proposed,
) -> None:
    project, filler, pause = proposed
    receipts = _batch_receipts(project, filler, pause, accepted_ids={pause})
    assert [h.edit_id for h in receipts] == [pause]


def test_a_pad_clip_wider_than_its_recorded_samples_is_refused(proposed) -> None:
    project, filler, pause = proposed
    receipts = _batch_receipts(project, filler, pause, accepted_ids={filler, pause}, widen_pad=0.2)
    assert pause in {h.edit_id for h in receipts}


def test_a_pad_laid_outside_the_window_its_owner_recorded_is_refused(proposed) -> None:
    project, filler, pause = proposed
    receipts = _batch_receipts(
        project, filler, pause, accepted_ids={filler, pause}, shift_window=1.0
    )
    assert pause in {h.edit_id for h in receipts}
