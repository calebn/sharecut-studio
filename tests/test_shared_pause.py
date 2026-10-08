"""A pause trim two tracks both propose is decided once, and never by dropping air a twin kept."""

from __future__ import annotations

import pytest

from podcast_mcp.edits.shared_pause import PauseClaim, shared_pause_twins
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track, TrackRole


def _project(**placed_at: float) -> EpisodeProject:
    """One 20 s dialogue track per keyword, placed that many seconds into the session."""
    project = EpisodeProject.create("t", "/tmp/ws")
    for track_id, at in placed_at.items():
        project.timeline.tracks.append(
            Track(
                id=track_id,
                label=track_id,
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=f"raw/{track_id}.wav", duration_sec=20.0),
            )
        )
        project.timeline.clips.append(
            Clip(
                id=f"c_{track_id}",
                track_id=track_id,
                source_start=0.0,
                source_end=20.0,
                timeline_start=at,
            )
        )
    return project


def _claim(track_id: str, start: float, end: float, kept=()) -> PauseClaim:
    return PauseClaim(track_id, start, end, tuple(kept))


def test_a_trim_nested_in_a_longer_one_on_another_track_is_dropped() -> None:
    project = _project(host=0.0, guest=0.0)
    claims = [_claim("host", 2.0, 2.6), _claim("guest", 1.8, 2.9)]

    assert shared_pause_twins(project, claims) == {0}


def test_equal_twins_keep_the_first_proposed() -> None:
    project = _project(host=0.0, guest=0.0)
    claims = [_claim("host", 2.0, 2.6), _claim("guest", 2.0, 2.6)]

    assert shared_pause_twins(project, claims) == {1}


def test_a_ten_millisecond_overlap_does_not_cost_a_trim_its_two_seconds() -> None:
    project = _project(host=0.0, guest=0.0)
    claims = [_claim("host", 1.0, 3.0), _claim("guest", 2.99, 4.99)]

    assert shared_pause_twins(project, claims) == set()


def test_a_chain_of_partial_overlaps_keeps_every_trim() -> None:
    project = _project(host=0.0, guest=0.0, third=0.0)
    claims = [_claim("host", 1.0, 2.0), _claim("guest", 1.9, 4.0), _claim("third", 3.9, 5.0)]

    assert shared_pause_twins(project, claims) == set()


@pytest.mark.parametrize(("protrusion", "dropped"), [(0.0, {1}), (0.009, {1}), (0.02, set())])
def test_a_twin_that_leaves_its_cover_by_more_than_a_frame_is_another_cut(
    protrusion, dropped
) -> None:
    project = _project(host=0.0, guest=0.0)
    claims = [_claim("host", 1.0, 3.0), _claim("guest", 1.5, 3.0 + protrusion)]

    assert shared_pause_twins(project, claims) == dropped


def test_a_twin_is_kept_when_the_longer_trim_holds_a_sound_it_left_whole() -> None:
    # The guest's trim ends at 3.0 because a sound starts there; the host's longer trim
    # runs on over it. The host's trim does not protect what the guest's did.
    project = _project(host=0.0, guest=0.0)
    claims = [_claim("host", 1.0, 5.0), _claim("guest", 1.5, 3.0, kept=[(3.0, 3.4)])]

    assert shared_pause_twins(project, claims) == set()


def test_a_twin_is_dropped_when_the_sounds_it_left_whole_lie_outside_the_longer_trim() -> None:
    project = _project(host=0.0, guest=0.0)
    claims = [_claim("host", 1.0, 5.0), _claim("guest", 1.5, 3.0, kept=[(0.5, 0.9), (5.2, 5.6)])]

    assert shared_pause_twins(project, claims) == {1}


def test_trims_on_one_track_and_claims_that_are_not_session_pauses_are_left_alone() -> None:
    project = _project(host=0.0, guest=0.0)
    claims = [_claim("host", 2.0, 3.0), None, _claim("host", 2.2, 2.6)]

    assert shared_pause_twins(project, claims) == set()


def test_twins_are_compared_on_the_session_clock_not_in_source_seconds() -> None:
    # The guest's recording starts 5 s into the session: its source 2.0 to 2.6 is session
    # 7.0 to 7.6, nowhere near the host's 2.0 to 2.6.
    apart = _project(host=0.0, guest=5.0)
    claims = [_claim("host", 2.0, 2.6), _claim("guest", 2.0, 2.6)]

    assert shared_pause_twins(apart, claims) == set()
    # Placed so the two are the same session stretch, they are twins.
    same = _project(host=0.0, guest=0.5)
    twin_claims = [_claim("host", 2.5, 3.1), _claim("guest", 2.0, 2.6)]

    assert shared_pause_twins(same, twin_claims) == {1}
