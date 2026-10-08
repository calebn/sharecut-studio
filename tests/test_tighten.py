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


def _pause(track: str, start: float, end: float, name: str) -> EditDecision:
    return EditDecision(
        id=name,
        track_id=track,
        type=EditDecisionType.REMOVE,
        start=start,
        end=end,
        reason="pause:1.00s",
        review_required=True,
        applied=False,
    )


def _collapsed(project: EpisodeProject, *decisions: EditDecision) -> tuple[list[str], dict]:
    from podcast_mcp.edits.tighten import _collapse_shared_pauses

    project.edit_decisions = list(decisions)
    skips: dict[str, int] = {}
    kept = _collapse_shared_pauses(project, list(decisions), skips)
    assert [d.id for d in project.edit_decisions] == [d.id for d in kept]
    return [d.id for d in kept], skips


def test_two_tracks_quiet_over_the_same_stretch_propose_it_once_the_longer_one() -> None:
    project = _two_track_project()

    kept, skips = _collapsed(
        project,
        _pause("host", 2.0, 2.6, "host-short"),
        _pause("guest", 1.8, 2.9, "guest-long"),
    )

    assert (kept, skips) == (["guest-long"], {"shared_pause": 1})


def test_pause_trims_that_do_not_overlap_in_the_session_each_stay() -> None:
    project = _two_track_project()
    # The guest's recording starts 5 s into the session: its source 2.0-2.6 is the
    # session's 7.0-7.6, nowhere near the host's 2.0-2.6.
    project.timeline.clips[1].timeline_start = 5.0

    kept, skips = _collapsed(
        project,
        _pause("host", 2.0, 2.6, "host"),
        _pause("guest", 2.0, 2.6, "guest"),
    )

    assert (kept, skips) == (["host", "guest"], {})


def test_pause_trims_on_one_track_are_left_to_coalescing_and_other_cuts_are_left_alone() -> None:
    project = _two_track_project()
    filler = _pause("guest", 2.0, 2.6, "filler")
    filler.reason = "filler:um"

    kept, skips = _collapsed(
        project,
        _pause("host", 2.0, 2.6, "first"),
        _pause("host", 2.4, 3.0, "second"),
        filler,
    )

    assert (kept, skips) == (["first", "second", "filler"], {})


def test_the_longest_pause_trim_of_a_chain_stays_and_both_it_overlaps_go() -> None:
    project = _two_track_project()
    project.timeline.tracks.append(
        Track(
            id="third",
            label="Third",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/third.wav", duration_sec=10.0),
        )
    )
    project.timeline.clips.append(
        Clip(
            id="full_third", track_id="third", source_start=0.0, source_end=10.0, timeline_start=0.0
        )
    )

    kept, skips = _collapsed(
        project,
        _pause("host", 1.0, 2.0, "left"),
        _pause("guest", 1.9, 4.0, "middle"),
        _pause("third", 3.9, 5.0, "right"),
    )

    assert (kept, skips) == (["middle"], {"shared_pause": 2})
