from __future__ import annotations

import pytest

from podcast_mcp.models import EpisodeProject, Track, TrackRole
from podcast_mcp.util.tracks import resolve_track


def test_resolve_track_by_speaker() -> None:
    p = EpisodeProject.create("r", "/tmp")
    p.timeline.tracks = [
        Track(id="host", label="Host", speaker="Alice", role=TrackRole.DIALOGUE),
    ]
    assert resolve_track(p, speaker="alice") == "host"
    assert resolve_track(p, track_id="host") == "host"


def test_resolve_track_missing() -> None:
    p = EpisodeProject.create("r2", "/tmp")
    with pytest.raises(ValueError):
        resolve_track(p, speaker="nobody")


def test_resolve_track_by_label_and_id_substring() -> None:
    p = EpisodeProject.create("r3", "/tmp")
    p.timeline.tracks = [
        Track(id="host_main", label="Host", speaker="Alice", role=TrackRole.DIALOGUE),
    ]
    assert resolve_track(p, speaker="host") == "host_main"
    assert resolve_track(p, speaker="Host") == "host_main"


def test_resolve_track_ambiguous_and_unknown_id() -> None:
    p = EpisodeProject.create("r4", "/tmp")
    p.timeline.tracks = [
        Track(id="a1", label="A", speaker="Sam", role=TrackRole.DIALOGUE),
        Track(id="a2", label="A", speaker="Sam", role=TrackRole.DIALOGUE),
    ]
    with pytest.raises(ValueError, match="ambiguous"):
        resolve_track(p, speaker="Sam")
    with pytest.raises(ValueError, match="unknown track_id"):
        resolve_track(p, track_id="missing")
    with pytest.raises(ValueError, match="track_id or speaker"):
        resolve_track(p)


def test_dialogue_track_ids_keep_muted_tracks_and_the_mix_skips_them() -> None:
    from podcast_mcp.util.tracks import dialogue_track_ids, mixed_dialogue_track_ids

    p = EpisodeProject.create("r5", "/tmp")
    p.timeline.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE),
        Track(id="guest", label="Guest", role=TrackRole.DIALOGUE, muted=True),
        Track(id="bed", label="Bed", role=TrackRole.MUSIC),
    ]
    assert dialogue_track_ids(p) == ["host", "guest"]
    assert mixed_dialogue_track_ids(p) == ["host"]


def test_resolve_track_by_label_without_speaker() -> None:
    p = EpisodeProject.create("r6", "/tmp")
    p.timeline.tracks = [
        Track(id="guest_1", label="Guest", role=TrackRole.DIALOGUE),
    ]
    assert resolve_track(p, speaker="guest") == "guest_1"


def test_resolve_track_by_id_substring_when_speaker_differs() -> None:
    p = EpisodeProject.create("r7", "/tmp")
    p.timeline.tracks = [
        Track(id="guest_1", label="Mic", speaker="Alice", role=TrackRole.DIALOGUE),
    ]
    assert resolve_track(p, speaker="guest") == "guest_1"
