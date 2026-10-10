from __future__ import annotations

import pytest

from pause_policy_public_helpers import room, voice, write_wav
from podcast_mcp.edits import apply_tighten_decisions
from podcast_mcp.edits.clips_ops import clips_for_track
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)


def _two_track_project() -> EpisodeProject:
    p = EpisodeProject.create("t", "/tmp/ws")
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/guest.wav", duration_sec=10.0),
        ),
    ]
    for tid in ("host", "guest"):
        p.timeline.clips.append(
            Clip(
                id=f"full_{tid}",
                track_id=tid,
                source_start=0.0,
                source_end=10.0,
                timeline_start=0.0,
            )
        )
    return p


def test_apply_tighten_decisions_counts_applied():
    proj = _two_track_project()
    proj.edit_decisions = [
        EditDecision(
            id="1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=2.0,
            end=2.5,
            reason="filler:um",
            applied=False,
        ),
        EditDecision(
            id="2",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=5.0,
            end=6.0,
            reason="pause:1.5s",
            applied=False,
            review_required=True,
        ),
    ]
    n = apply_tighten_decisions(proj)
    assert n == 1
    assert all(e.id != "1" for e in proj.edit_decisions)
    assert proj.edit_decisions[0].id == "2"
    host_end = max(c.timeline_end for c in clips_for_track(proj, "host"))
    guest_end = max(c.timeline_end for c in clips_for_track(proj, "guest"))
    assert host_end == guest_end == 9.5


def _original_pause_project(tmp_path):
    proj = _two_track_project()
    proj.meta.workspace_dir = str(tmp_path)
    for index, track in enumerate(proj.tracks):
        audio = room(10, seed=1214 + index)
        for start, end in ((4.0, 4.3), (6.4, 6.7), (8.7, 9.1)):
            voice(audio, start, end)
        write_wav(tmp_path / track.media.path, audio)
        proj.transcripts.append(
            Transcript(
                track_id=track.id,
                words=[
                    TranscriptWord(text="before", start=4.0, end=4.3),
                    TranscriptWord(text="after", start=6.4, end=6.7),
                    TranscriptWord(text="reference", start=8.7, end=9.1),
                ],
            )
        )
    return proj


def test_apply_tighten_decisions_applies_a_pause_trim_that_needs_no_review(tmp_path):
    proj = _original_pause_project(tmp_path)
    proj.edit_decisions = [
        EditDecision(
            id="trim",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=5.0,
            end=6.0,
            reason="pause:1.5s",
            applied=False,
            review_required=False,
        ),
        EditDecision(
            id="risky-trim",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=8.0,
            end=8.5,
            reason="pause:1.5s:risky",
            applied=False,
            review_required=True,
        ),
    ]

    assert apply_tighten_decisions(proj) == 1
    assert [e.id for e in proj.edit_decisions] == ["risky-trim"]
    assert max(c.timeline_end for c in clips_for_track(proj, "guest")) == pytest.approx(
        9.0, abs=0.001
    )
    assert all(c.source_id is None for c in proj.clips)
    assert proj.editorial.edit_log[0].params["replace_gap_sec"] is None
    assert proj.editorial.edit_log[0].params["pad_samples"] == []


def test_apply_tighten_decisions_holds_a_pause_without_original_media(tmp_path):
    proj = _original_pause_project(tmp_path)
    (tmp_path / "raw" / "host.wav").unlink()
    proj.edit_decisions = [
        EditDecision(
            id="trim",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=5.0,
            end=6.0,
            reason="pause:1.5s",
            review_required=False,
        )
    ]
    before = proj.model_dump(mode="json")

    assert apply_tighten_decisions(proj) == 0

    assert proj.model_dump(mode="json") == before
    assert max(c.timeline_end for c in clips_for_track(proj, "guest")) == 10.0
    assert [e.id for e in proj.edit_decisions] == ["trim"]
    assert proj.editorial.edit_log == []
    assert all(c.source_id is None for c in proj.clips)


def _resolved(project, rows, *, existing=(), rejected=()):
    """``_resolve_analyzed_cuts`` over pause candidates analyzed to ``rows``
    (``(track_id, start, end)``); ``rejected`` indexes were lost in analysis (the join gate).
    Returns the tracks and spans that stand and the skip counts."""
    from podcast_mcp.edits.fillers import (
        _AnalyzedCut,
        _CutCandidate,
        _CutRejected,
        _resolve_analyzed_cuts,
    )

    candidates = [
        _CutCandidate(track_id, start, end, f"pause:{end - start:.2f}s", "pause")
        for track_id, start, end in rows
    ]
    results = [
        _CutRejected("join_continuity")
        if index in rejected
        else _AnalyzedCut(
            hit_id=c.hit_id,
            track_id=c.track_id,
            start=c.start,
            end=c.end,
            reason=c.reason,
            review_required=True,
            crossfade_ms=10,
            cut_confidence=1.0,
            boundary_mode="transcript",
        )
        for index, c in enumerate(candidates)
    ]
    skips: dict[str, int] = {}
    kept = _resolve_analyzed_cuts(
        candidates, results, existing=existing, skip_counts=skips, project=project
    )
    return [(r.track_id, r.start, r.end) for r in kept], skips


def test_two_tracks_quiet_over_the_same_stretch_propose_it_once() -> None:
    project = _two_track_project()

    kept, skips = _resolved(project, [("host", 2.0, 2.6), ("guest", 1.8, 2.9)])

    assert kept == [("guest", 1.8, 2.9)]
    assert skips == {"shared_pause": 1}


def test_pause_trims_that_do_not_overlap_in_the_session_each_stay() -> None:
    project = _two_track_project()
    # The guest's recording starts 5 s into the session: its source 2.0-2.6 is the
    # session's 7.0-7.6, nowhere near the host's 2.0-2.6.
    project.timeline.clips[1].timeline_start = 5.0

    kept, skips = _resolved(project, [("host", 2.0, 2.6), ("guest", 2.0, 2.6)])

    assert kept == [("host", 2.0, 2.6), ("guest", 2.0, 2.6)]
    assert skips == {}


def test_a_twin_stands_when_the_trim_it_was_dropped_for_fails_the_join_gate() -> None:
    # The guest's longer trim is the one the host's would be dropped for; the join gate
    # loses it, and the host's trim of the same stretch is not lost with it.
    project = _two_track_project()

    kept, skips = _resolved(project, [("host", 2.0, 2.6), ("guest", 1.8, 2.9)], rejected=(1,))

    assert kept == [("host", 2.0, 2.6)]
    assert skips == {"join_continuity": 1}


def test_a_twin_stands_when_the_trim_it_was_dropped_for_overlaps_an_applied_cut() -> None:
    from podcast_mcp.models import EditDecision, EditDecisionType

    project = _two_track_project()
    applied = EditDecision(
        id="done",
        track_id="guest",
        type=EditDecisionType.REMOVE,
        start=2.8,
        end=3.2,
        reason="filler:um",
        applied=True,
    )

    kept, skips = _resolved(project, [("host", 2.0, 2.6), ("guest", 1.8, 2.9)], existing=[applied])

    assert kept == [("host", 2.0, 2.6)]
    assert skips == {"applied_overlap": 1}


def test_a_twin_stands_when_the_trim_it_was_dropped_for_went_to_an_acoustic_cut() -> None:
    # The guest's longer pause trim is replaced by the acoustic cut that overlaps it. The
    # host's trim of the same stretch is not dropped for a trim that is no longer proposed.
    from podcast_mcp.edits.fillers import _AnalyzedCut, _CutCandidate, _resolve_analyzed_cuts
    from podcast_mcp.edits.tighten_reasons import ACOUSTIC_FILLER_REASON

    project = _two_track_project()
    candidates = [
        _CutCandidate("host", 2.0, 2.6, "pause:0.60s", "pause"),
        _CutCandidate("guest", 1.8, 2.9, "pause:1.10s", "pause"),
        _CutCandidate(
            "guest", 2.5, 2.8, ACOUSTIC_FILLER_REASON, "filler", min_start=2.5, review_only=True
        ),
    ]
    results = [
        _AnalyzedCut(
            hit_id=c.hit_id,
            track_id=c.track_id,
            start=c.start,
            end=c.end,
            reason=c.reason,
            review_required=True,
            crossfade_ms=10,
            cut_confidence=1.0,
            boundary_mode="transcript",
        )
        for c in candidates
    ]
    skips: dict[str, int] = {}

    kept = _resolve_analyzed_cuts(candidates, results, project=project, skip_counts=skips)

    assert [(r.track_id, r.start, r.end) for r in kept] == [
        ("host", 2.0, 2.6),
        ("guest", 2.5, 2.8),
    ]
    assert skips == {"acoustic:replaced_pause": 1}


def test_a_track_local_pause_trim_is_never_a_twin() -> None:
    from podcast_mcp.edits.fillers import _AnalyzedCut, _CutCandidate, _resolve_analyzed_cuts

    project = _two_track_project()
    candidates = [
        _CutCandidate("host", 2.0, 2.6, "pause:0.60s", "pause"),
        _CutCandidate("guest", 1.8, 2.9, "pause:1.10s", "pause"),
    ]
    results = [
        _AnalyzedCut(
            hit_id=c.hit_id,
            track_id=c.track_id,
            start=c.start,
            end=c.end,
            reason=c.reason,
            review_required=True,
            crossfade_ms=10,
            cut_confidence=1.0,
            boundary_mode="transcript",
            scope=scope,
        )
        for c, scope in zip(candidates, ("track", "session"), strict=True)
    ]

    skips: dict[str, int] = {}
    kept = _resolve_analyzed_cuts(candidates, results, project=project, skip_counts=skips)

    assert kept == results[1:]
    assert skips == {"stored_track_pause": 1}


def test_every_dialogue_track_is_decoded_for_a_pause_trim_a_transcript_or_not() -> None:
    # A session ripple removes the same window from every dialogue track, and a pause trim
    # reads each one. A track with no transcript (a silent second mic) is decoded once with
    # the run's caches, not afresh on every call.
    from unittest.mock import patch

    from podcast_mcp.edits.tighten import propose_tighten_edits
    from podcast_mcp.models import Transcript, TranscriptWord

    project = _two_track_project()
    project.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="hi", start=0.0, end=0.3)])
    ]

    with patch("podcast_mcp.edits.tighten.build_track_audio_caches", return_value={}) as build:
        propose_tighten_edits(project, {"tighten": {}})

    assert set(build.call_args.args[1]) == {"host", "guest"}
