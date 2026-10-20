"""Approve all measures the timeline once, not once per cut (#1596)."""

from __future__ import annotations

import wave

import pytest

from podcast_mcp.edits.cut_application import _cut_effect
from podcast_mcp.edits.cut_proof import CutEffect
from podcast_mcp.edits.ripple import RippleRemoval, TrackExtent
from podcast_mcp.edits.transcript_refine_status import REFINE_GATE
from podcast_mcp.engines.audio_audit import build_track_rms_caches
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track, TrackRole, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService
from source_review_helpers import _cut

pytestmark = pytest.mark.refine_gate

LONG_SEC = 120


def _long_project(tmp_path) -> EpisodeProject:
    path = tmp_path / "raw" / "host.wav"
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16_000)
        handle.writeframes(b"\0\0" * 16_000 * LONG_SEC)
    project = EpisodeProject.create("long approve", str(tmp_path))
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(
                path="raw/host.wav", duration_sec=LONG_SEC, sample_rate=16_000, channels=1
            ),
        )
    ]
    project.clips = [
        Clip(id="host", track_id="host", source_start=0, source_end=LONG_SEC, timeline_start=0)
    ]
    project.timeline.duration_sec = LONG_SEC
    return project


def _open(tmp_path, cuts) -> ProjectWorkspace:
    project = _long_project(tmp_path)
    project.edit_decisions = [_cut(f"cut-{start}", start, start + 0.4) for start in cuts]
    REFINE_GATE.mark_done(project, notes="Known synthetic transcript fixture; no real-project test")
    return ProjectWorkspace.open(save_project(project))


def test_cuts_far_apart_share_one_timeline_measurement(tmp_path, monkeypatch):
    ws = _open(tmp_path, [10, 30, 50, 70, 90])
    builds: list[int] = []

    def spy(project, **kwargs):
        builds.append(len(builds) + 1)
        return build_track_rms_caches(project, **kwargs)

    monkeypatch.setattr("podcast_mcp.edits.cut_proof.build_track_rms_caches", spy)

    assert EditService(ws).approve([f"cut-{s}" for s in (10, 30, 50, 70, 90)]) == 5
    assert builds == [1]


def test_the_shared_measurement_leaves_the_same_timeline_as_one_per_cut(tmp_path):
    starts = [10, 30, 50, 70, 90]
    batch = _open(tmp_path / "batch", starts)
    EditService(batch).approve([f"cut-{s}" for s in starts])

    one_by_one = _open(tmp_path / "one", starts)
    for start in reversed(starts):
        EditService(one_by_one).approve([f"cut-{start}"])

    def timeline(ws):
        return [
            (
                c.track_id,
                round(c.source_start, 6),
                round(c.source_end, 6),
                round(c.timeline_start, 6),
            )
            for c in ws.project.clips
        ]

    assert timeline(batch) == timeline(one_by_one)
    assert len(timeline(batch)) == 6


def _effect_project(tmp_path) -> EpisodeProject:
    project = _long_project(tmp_path)
    project.tracks.append(
        Track(id="guest", label="Guest", role=TrackRole.DIALOGUE, media=project.tracks[0].media)
    )
    project.tracks.append(Track(id="music", label="Music", role=TrackRole.MUSIC))
    return project


def test_a_ripple_cut_moves_every_dialogue_track_and_names_its_join_fade_and_pad(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(
        "podcast_mcp.edits.cut_application.filler_pad_mode", lambda defaults: "silence"
    )
    project = _effect_project(tmp_path)
    removal = RippleRemoval.of([TrackExtent("host", 10.0, 10.4)])
    actual = _cut("c", 10.0, 10.4, replace_gap_sec=0.25)
    result = (10.0, 10.4, ["host"], {"crossfade_ms": 12})

    effect = _cut_effect(project, removal, actual, result, {})

    assert effect == CutEffect(
        10.0, 10.4, ("host", "guest"), hole=False, fade_sec=0.012, pad_sec=0.25, pad_silent=True
    )


def test_a_cut_with_room_tone_pad_says_the_pad_is_not_silent(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "podcast_mcp.edits.cut_application.filler_pad_mode", lambda defaults: "room_tone"
    )
    project = _effect_project(tmp_path)
    removal = RippleRemoval.of([TrackExtent("host", 10.0, 10.4)])

    effect = _cut_effect(
        project,
        removal,
        _cut("c", 10.0, 10.4, replace_gap_sec=0.25),
        (10.0, 10.4, ["host"], {}),
        {},
    )

    assert effect is not None
    assert effect.pad_silent is False
    assert effect.fade_sec == 0.0


def test_a_track_scope_cut_leaves_a_hole_in_its_own_track_only(tmp_path):
    project = _effect_project(tmp_path)

    effect = _cut_effect(
        project, None, _cut("c", 10.0, 10.4), (10.0, 10.4, ["host"], {"crossfade_ms": 0}), {}
    )

    assert effect == CutEffect(10.0, 10.4, ("host",), hole=True)


def test_a_removal_of_several_spans_is_not_followed(tmp_path):
    project = _effect_project(tmp_path)
    removal = RippleRemoval.of([TrackExtent("host", 10.0, 10.4), TrackExtent("host", 30.0, 30.4)])

    assert _cut_effect(project, removal, _cut("c"), (10.0, 10.4, ["host"], {}), {}) is None
