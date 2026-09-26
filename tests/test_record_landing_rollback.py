"""Pure unit tests for capture_prior / revert_registration (#366)."""

from __future__ import annotations

import pytest

from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, SourceRecording, Track, TrackRole
from podcast_mcp.services.record.landing_rollback import (
    PriorRegistration,
    capture_prior,
    media_from_remaining_clip,
    prior_from_json,
    prior_to_json,
    registration_present,
    revert_registration,
)


def _project() -> EpisodeProject:
    return EpisodeProject.create("rollback-test", "/tmp/rollback-test")


def test_revert_is_noop_when_source_has_moved():
    project = _project()
    project.sources.append(SourceRecording(id="rec-1", path="raw/newer.wav"))

    prior = capture_prior(
        project, track_id="t1", source_id="rec-1", rel="raw/stale.wav", room_tone=False
    )
    assert revert_registration(project, prior) is False
    assert project.sources[0].path == "raw/newer.wav"


def test_revert_restores_prior_source_clip_and_media():
    project = _project()
    project.sources.append(
        SourceRecording(id="rec-1", path="raw/original.wav", speaker="Ava", duration_sec=5.0)
    )
    project.tracks.append(
        Track(
            id="t1",
            label="Ava",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/original.wav", duration_sec=5.0),
        )
    )
    project.clips.append(
        Clip(
            id="c1",
            track_id="t1",
            source_start=0.0,
            source_end=5.0,
            timeline_start=0.0,
            source_id="rec-1",
        )
    )

    prior = capture_prior(
        project, track_id="t1", source_id="rec-1", rel="raw/stale.wav", room_tone=False
    )

    # Landing overwrites the registration in place, as the mutate() step does.
    project.sources[0].path = "raw/stale.wav"
    project.sources[0].duration_sec = 9.0
    project.clips[0].source_end = 9.0
    project.track_by_id("t1").media = MediaAsset(path="raw/stale.wav", duration_sec=9.0)

    assert revert_registration(project, prior) is True
    assert project.sources[0].path == "raw/original.wav"
    assert project.sources[0].duration_sec == 5.0
    assert project.clips[0].source_end == 5.0
    track = project.track_by_id("t1")
    assert track is not None
    assert track.media is not None
    assert track.media.path == "raw/original.wav"


def test_revert_removes_track_landing_created_when_now_empty():
    project = _project()
    # Nothing existed before landing: capture_prior on an absent track/source/clip.
    prior = capture_prior(
        project, track_id="t1", source_id="rec-1", rel="raw/stale.wav", room_tone=False
    )
    project.tracks.append(
        Track(
            id="t1",
            label="Ava",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/stale.wav", duration_sec=3.0),
        )
    )
    project.sources.append(SourceRecording(id="rec-1", path="raw/stale.wav", duration_sec=3.0))
    project.clips.append(
        Clip(
            id="c1",
            track_id="t1",
            source_start=0.0,
            source_end=3.0,
            timeline_start=0.0,
            source_id="rec-1",
        )
    )

    assert revert_registration(project, prior) is True
    assert project.sources == []
    assert project.clips == []
    assert project.track_by_id("t1") is None


def test_revert_clears_room_tone_bed_at_same_path():
    project = _project()
    project.tracks.append(Track(id="t1", label="Ava", role=TrackRole.DIALOGUE))

    prior = capture_prior(
        project,
        track_id="t1",
        source_id="rt-t1",
        rel="raw/room-tone/ava.wav",
        room_tone=True,
    )
    project.sources.append(
        SourceRecording(id="rt-t1", path="raw/room-tone/ava.wav", duration_sec=2.0)
    )
    project.track_by_id("t1").room_tone = MediaAsset(path="raw/room-tone/ava.wav", duration_sec=2.0)

    assert revert_registration(project, prior) is True
    assert not any(src.id == "rt-t1" for src in project.sources)
    track = project.track_by_id("t1")
    assert track is not None
    assert track.room_tone is None


def test_revert_restores_room_tone_bed_at_different_prior_path():
    project = _project()
    project.sources.append(
        SourceRecording(id="rt-t1", path="raw/room-tone/old.wav", duration_sec=1.5)
    )
    project.tracks.append(
        Track(
            id="t1",
            label="Ava",
            role=TrackRole.DIALOGUE,
            room_tone=MediaAsset(path="raw/room-tone/old.wav", duration_sec=1.5),
        )
    )

    prior = capture_prior(
        project,
        track_id="t1",
        source_id="rt-t1",
        rel="raw/room-tone/new.wav",
        room_tone=True,
    )
    # Landing overwrote the same source id in place (room-tone sources are per
    # participant, so the raw path can move even though the id stays fixed).
    project.sources[0].path = "raw/room-tone/new.wav"
    project.sources[0].duration_sec = 4.0
    project.track_by_id("t1").room_tone = MediaAsset(path="raw/room-tone/new.wav", duration_sec=4.0)

    assert revert_registration(project, prior) is True
    src = next(s for s in project.sources if s.id == "rt-t1")
    assert src.path == "raw/room-tone/old.wav"
    assert src.duration_sec == 1.5
    track = project.track_by_id("t1")
    assert track is not None
    assert track.room_tone is not None
    assert track.room_tone.path == "raw/room-tone/old.wav"


def test_revert_falls_back_to_remaining_clip_for_media():
    project = _project()
    project.tracks.append(Track(id="t1", label="Ava", role=TrackRole.DIALOGUE))
    project.sources.append(
        SourceRecording(id="rec-kept", path="raw/kept.wav", duration_sec=4.0, sample_rate=48_000)
    )
    project.clips.append(
        Clip(
            id="c-kept",
            track_id="t1",
            source_start=0.0,
            source_end=4.0,
            timeline_start=0.0,
            source_id="rec-kept",
        )
    )

    prior = capture_prior(
        project, track_id="t1", source_id="rec-stale", rel="raw/stale.wav", room_tone=False
    )
    project.sources.append(SourceRecording(id="rec-stale", path="raw/stale.wav", duration_sec=2.0))
    project.clips.append(
        Clip(
            id="c-stale",
            track_id="t1",
            source_start=0.0,
            source_end=2.0,
            timeline_start=4.0,
            source_id="rec-stale",
        )
    )
    project.track_by_id("t1").media = MediaAsset(path="raw/stale.wav", duration_sec=2.0)

    assert revert_registration(project, prior) is True
    assert not any(src.id == "rec-stale" for src in project.sources)
    assert not any(clip.source_id == "rec-stale" for clip in project.clips)
    track = project.track_by_id("t1")
    assert track is not None
    assert track.media is not None
    assert track.media.path == "raw/kept.wav"


def test_prior_json_round_trips_populated_and_empty():
    project = _project()
    project.tracks.append(
        Track(
            id="t1",
            label="Ava",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/a.wav", duration_sec=5.0),
        )
    )
    project.sources.append(SourceRecording(id="rec-1", path="raw/a.wav", duration_sec=5.0))
    project.clips.append(
        Clip(
            id="c1",
            track_id="t1",
            source_start=0.0,
            source_end=5.0,
            timeline_start=0.0,
            source_id="rec-1",
        )
    )
    full = capture_prior(
        project, track_id="t1", source_id="rec-1", rel="raw/b.wav", room_tone=False
    )
    assert prior_from_json(prior_to_json(full)) == full
    empty = capture_prior(project, track_id="tx", source_id="nope", rel="raw/c.wav", room_tone=True)
    assert empty.source is None and empty.clip is None and empty.media is None
    assert prior_from_json(prior_to_json(empty)) == empty


@pytest.mark.parametrize("raw", ["not json", "{}", "[]", '{"track_id": 1}'])
def test_prior_from_json_rejects_garbage(raw):
    with pytest.raises(ValueError):
        prior_from_json(raw)


def test_registration_present_tracks_source_path():
    project = _project()
    prior = PriorRegistration("t1", "rec-1", "raw/x.wav", False, True, None, None, None)
    assert registration_present(project, prior) is False
    project.sources.append(SourceRecording(id="rec-1", path="raw/x.wav"))
    assert registration_present(project, prior) is True
    project.sources[0].path = "raw/y.wav"
    assert registration_present(project, prior) is False


def test_media_from_remaining_clip_skips_stale_sources():
    project = _project()
    for i, sid in enumerate(("rec-a", "rec-b")):
        project.sources.append(SourceRecording(id=sid, path=f"raw/{sid}.wav", duration_sec=1.0))
        project.clips.append(
            Clip(
                id=f"c{i}",
                track_id="t1",
                source_start=0.0,
                source_end=1.0,
                timeline_start=float(i),
                source_id=sid,
            )
        )
    first = media_from_remaining_clip(project, "t1")
    assert first is not None and first.path == "raw/rec-a.wav"
    skipped = media_from_remaining_clip(project, "t1", skip_source_ids=frozenset({"rec-a"}))
    assert skipped is not None and skipped.path == "raw/rec-b.wav"
    assert media_from_remaining_clip(project, "t1", skip_source_ids={"rec-a", "rec-b"}) is None
