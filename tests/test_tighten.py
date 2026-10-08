from __future__ import annotations

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


def test_apply_tighten_decisions_never_applies_a_pause_trim():
    proj = _two_track_project()
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
    ]

    assert apply_tighten_decisions(proj) == 0
    assert [e.id for e in proj.edit_decisions] == ["trim"]


def _prepared(candidate, start: float, end: float, kept=(), scope: str = "session"):
    from podcast_mcp.edits.fillers import _CutPlan, _Join, _PreparedCut

    return _PreparedCut(
        candidate=candidate,
        opt=None,
        jump_cache={},
        plan=_CutPlan(start, end, _Join.SPLICE),
        scope=scope,
        reason=candidate.reason,
        review_required=True,
        replace_gap=None,
        kept_sounds=tuple(kept),
    )


def _analyzed_batch(project, rows):
    """``analyze_candidates`` over pause candidates whose prepared spans are ``rows``
    (``(track_id, start, end, kept)``); returns the outcomes and the candidates the join
    gate and fade sizing were paid for."""
    from unittest.mock import patch

    from podcast_mcp.edits.fillers import (
        _AnalyzedCut,
        _CutCandidate,
        _CutRejected,
        analyze_candidates,
    )

    candidates = [
        _CutCandidate(track_id, start, end, f"pause:{end - start:.2f}s", "pause")
        for track_id, start, end, _kept in rows
    ]
    prepared = {
        id(c): _prepared(c, c.start, c.end, kept)
        for c, (_t, _s, _e, kept) in zip(candidates, rows, strict=True)
    }
    finished: list[str] = []

    def finish(_project, job, _defaults, **_kw):
        finished.append(f"{job.candidate.track_id}:{job.plan.start}")
        return _AnalyzedCut(
            hit_id=job.candidate.hit_id,
            track_id=job.candidate.track_id,
            start=job.plan.start,
            end=job.plan.end,
            reason=job.reason,
            review_required=True,
            crossfade_ms=10,
            cut_confidence=1.0,
            boundary_mode="transcript",
        )

    with (
        patch(
            "podcast_mcp.edits.fillers._prepare_candidate",
            side_effect=lambda _p, c, _d, **_kw: prepared[id(c)],
        ),
        patch("podcast_mcp.edits.fillers._finish_candidate", side_effect=finish),
    ):
        out = analyze_candidates(
            project,
            candidates,
            {},
            audio_caches={},
            speaker_context=None,
            peer_indexes=None,
            word_indexes={},
            max_workers=1,
        )
    assert all(isinstance(o, (_AnalyzedCut, _CutRejected)) for o in out)
    return [o.skip if isinstance(o, _CutRejected) else "kept" for o in out], finished


def test_two_tracks_quiet_over_the_same_stretch_propose_it_once_and_score_one_join() -> None:
    project = _two_track_project()

    outcomes, scored = _analyzed_batch(
        project,
        [("host", 2.0, 2.6, ()), ("guest", 1.8, 2.9, ())],
    )

    assert outcomes == ["shared_pause", "kept"]
    assert scored == ["guest:1.8"]


def test_a_pause_trim_a_longer_twin_holds_a_sound_of_is_scored_and_proposed_too() -> None:
    project = _two_track_project()

    outcomes, scored = _analyzed_batch(
        project,
        [("host", 1.0, 5.0, ()), ("guest", 1.5, 3.0, [(3.0, 3.4)])],
    )

    assert outcomes == ["kept", "kept"]
    assert scored == ["host:1.0", "guest:1.5"]


def test_pause_trims_that_do_not_overlap_in_the_session_each_stay() -> None:
    project = _two_track_project()
    # The guest's recording starts 5 s into the session: its source 2.0-2.6 is the
    # session's 7.0-7.6, nowhere near the host's 2.0-2.6.
    project.timeline.clips[1].timeline_start = 5.0

    outcomes, _scored = _analyzed_batch(project, [("host", 2.0, 2.6, ()), ("guest", 2.0, 2.6, ())])

    assert outcomes == ["kept", "kept"]


def test_a_track_local_pause_trim_is_never_a_twin() -> None:
    from unittest.mock import patch

    from podcast_mcp.edits.fillers import _CutCandidate, analyze_candidates

    project = _two_track_project()
    candidates = [
        _CutCandidate("host", 2.0, 2.6, "pause:0.60s", "pause"),
        _CutCandidate("guest", 1.8, 2.9, "pause:1.10s", "pause"),
    ]
    prepared = [
        _prepared(candidates[0], 2.0, 2.6, scope="track"),
        _prepared(candidates[1], 1.8, 2.9),
    ]
    with (
        patch("podcast_mcp.edits.fillers._prepare_candidate", side_effect=prepared),
        patch(
            "podcast_mcp.edits.fillers._finish_candidate", side_effect=lambda _p, job, _d, **_k: job
        ),
    ):
        out = analyze_candidates(
            project,
            candidates,
            {},
            audio_caches={},
            speaker_context=None,
            peer_indexes=None,
            word_indexes={},
            max_workers=1,
        )

    assert out == prepared
