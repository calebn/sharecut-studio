"""Readers of a clip's shift map a clip with a timing map point by point, part 2 (#2860, 4a2)."""

from __future__ import annotations

import wave
from dataclasses import asdict
from pathlib import Path

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.insert_anchor import capture_insert_anchor, resolve_insert_anchor
from podcast_mcp.edits.retained_bleed_alignment import (
    PhraseAlignmentProposal,
    _safe_batch_proposals,
    plan_retained_bleed_alignment,
)
from podcast_mcp.edits.ripple import RippleRemoval
from podcast_mcp.edits.session_air import GeometricPause, PauseActivity
from podcast_mcp.edits.speech_energy_guard import speech_words_in
from podcast_mcp.edits.timeline_ops import LaneUnavailable, _edge_on_timeline, bind_pause_effects
from podcast_mcp.edits.verdict_cache import _heard
from podcast_mcp.engines.bleed_gate import BleedGatePlan
from podcast_mcp.engines.lane_words import lane_transcripts
from podcast_mcp.engines.session_timeline import (
    SessionTimeline,
    _gap_neighbor_drifts,
    shift_at,
)
from podcast_mcp.models import (
    Clip,
    ClipOffSpeakerMuteRegion,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.project.store import save_project
from podcast_mcp.segments.capture import capture_segment
from podcast_mcp.services.app.workspace import ProjectWorkspace
from podcast_mcp.services.document.bleed_inspection import inspect_clip_bleed
from podcast_mcp.util.coded_error import CodedValueError

_STEPS = [
    {"at": 20, "delta_sec": 2},
    {"at": 30, "delta_sec": -0.08, "quiet": {"start_s": 29, "end_s": 32}},
]


def _clip(**kw) -> Clip:
    base = {
        "id": "a",
        "track_id": "host",
        "source_start": 10,
        "source_end": 40,
        "timeline_start": 100,
        "timing": {"steps": _STEPS},
    }
    return Clip.model_validate({**base, **kw})


def _project(*clips: Clip, words: list[TranscriptWord] | None = None) -> EpisodeProject:
    project = EpisodeProject.create("timed_consumers_2", "/tmp/ws-timed-consumers-2")
    project.timeline.tracks = [
        Track(
            id="host",
            label="host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/shared.wav", duration_sec=300.0),
        )
    ]
    project.timeline.clips = list(clips)
    if words is not None:
        project.transcripts = [Transcript(track_id="host", words=words)]
    return project


@pytest.mark.parametrize(
    ("regions", "expected"),
    [
        ([(3, 4), (6, 7)], [(11, 12), (16, 17)]),
        ([(4, 6)], [(12, 16)]),
    ],
)
def test_a_timed_clip_inspection_places_each_region_at_its_own_shift(
    tmp_path: Path, regions: list[tuple[int, int]], expected: list[tuple[int, int]]
) -> None:
    with wave.open(str(tmp_path / "host.wav"), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b"\x01\x00" * 80000)
    project = EpisodeProject.create("inspection", str(tmp_path))
    project.ensure_dirs()
    project.tracks.append(Track(id="host", label="Host", media=MediaAsset(path="host.wav")))
    project.clips = [
        Clip(
            id="timed",
            track_id="host",
            source_start=2,
            source_end=8,
            timeline_start=10,
            timing={"steps": [{"at": 5, "delta_sec": 2}]},
            off_speaker_mute_regions=[
                ClipOffSpeakerMuteRegion(start_s=lo, end_s=hi) for lo, hi in regions
            ],
        )
    ]
    workspace = ProjectWorkspace.open(save_project(project))
    import podcast_mcp.services.document.bleed_inspection as module

    original = module.build_bleed_gate_plan
    module.build_bleed_gate_plan = lambda *_a, **_k: BleedGatePlan()
    try:
        inspection = inspect_clip_bleed(workspace, "timed", track_id="host")
    finally:
        module.build_bleed_gate_plan = original
    assert [(r.timeline.start, r.timeline.end) for r in inspection.regions] == expected


def test_speech_words_keep_their_length_and_shift_per_word() -> None:
    clip = _clip()
    words = [
        TranscriptWord(text="a", start=15, end=15.5),
        TranscriptWord(text="b", start=23, end=23.4),
    ]
    project = _project(clip, words=words)
    found = speech_words_in(
        project,
        "host",
        [(100.0, 140.0)],
        0.03,
        voiced=False,
        defaults=load_defaults(),
    )
    assert [(w.text, w.timeline_start, w.timeline_end) for w in found] == [
        ("a", pytest.approx(105.0), pytest.approx(105.5)),
        ("b", pytest.approx(115.0), pytest.approx(115.4)),
    ]


def test_an_insert_anchor_round_trips_before_and_after_the_step() -> None:
    project = _project(
        _clip(),
        Clip(id="far", track_id="host", source_start=100, source_end=110, timeline_start=300),
    )
    for at in (105.0, 110.0, 111.0, 112.0, 115.0, 125.0):
        anchor = capture_insert_anchor(project, at)
        assert resolve_insert_anchor(project, anchor) == pytest.approx(at)
    after = capture_insert_anchor(project, 140.0)
    assert after.side == "after"
    assert after.source_sec == 40
    assert after.offset_s == pytest.approx(140.0 - project.clips[0].timeline_end)
    assert resolve_insert_anchor(project, after) == pytest.approx(140.0)


def test_a_pause_edge_on_a_timed_original_maps_through_its_piece() -> None:
    clip = _clip()
    assert _edge_on_timeline(clip, 25.0, "right") == pytest.approx(117.0)
    assert _edge_on_timeline(clip, 40.0, "left") == pytest.approx(clip.timeline_end)
    assert _edge_on_timeline(clip, 40.0 + 5e-7, "left") == pytest.approx(
        clip.timeline_end, abs=1e-6
    )
    assert _edge_on_timeline(clip, 30.04, "left") is None
    assert _edge_on_timeline(clip, 30.04, "right") is None
    untimed = Clip(id="u", track_id="host", source_start=10, source_end=40, timeline_start=100)
    assert _edge_on_timeline(untimed, 25.0, "left") == 115.0


def test_a_left_edge_on_a_step_is_the_end_of_the_earlier_piece_and_a_right_edge_the_later() -> None:
    clip = _clip()
    assert _edge_on_timeline(clip, 20.0, "left") == pytest.approx(110.0)
    assert _edge_on_timeline(clip, 20.0, "right") == pytest.approx(112.0)
    assert _edge_on_timeline(clip, 30.0, "left") == pytest.approx(122.0)
    assert _edge_on_timeline(clip, 30.08, "right") == pytest.approx(122.0)


def _pause_project(tmp_path: Path, clip: Clip) -> tuple[EpisodeProject, Path]:
    raw = tmp_path / "raw" / "shared.wav"
    raw.parent.mkdir()
    with wave.open(str(raw), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(8000)
        out.writeframes(b"\x00\x00" * 8000)
    project = EpisodeProject.create("pause", str(tmp_path))
    project.tracks = [
        Track(
            id="host",
            label="host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/shared.wav", duration_sec=60.0),
        )
    ]
    project.clips = [clip]
    return project, raw.resolve()


def _left_fade(project: EpisodeProject, media: Path, quiet_hi_before_edge: float):
    edge = project.clips[0].timeline_end
    sound = PauseActivity("host", None, media, edge - 32.5, edge - quiet_hi_before_edge)
    bound = bind_pause_effects(
        project,
        edge,
        RippleRemoval.of(unselected=[(edge, edge + 0.5)]),
        observation=GeometricPause(activity=(sound,)),
        splice_fade_ms=40000,
        defaults=load_defaults(),
    )
    assert not isinstance(bound, LaneUnavailable)
    (fade,) = [f for f in bound if f.side == "left"]
    return fade


def test_a_pause_fade_capacity_reads_the_timed_clip_footprint(tmp_path: Path) -> None:
    project, media = _pause_project(tmp_path, _clip())
    fade = _left_fade(project, media, 31.0)
    assert (fade.source_sec, fade.milliseconds) == (40.0, 31000)
    assert fade.source_start == pytest.approx(30.08)


def test_the_untimed_pause_fade_footprint_is_the_source_span(tmp_path: Path) -> None:
    untimed = Clip(id="u", track_id="host", source_start=10, source_end=40, timeline_start=100)
    project, media = _pause_project(tmp_path, untimed)
    fade = _left_fade(project, media, 29.0)
    assert (fade.milliseconds, fade.source_start) == (29000, 11.0)


def test_a_word_after_a_step_maps_with_the_second_offset() -> None:
    words = [
        TranscriptWord(text="a", start=15, end=15.5),
        TranscriptWord(text="b", start=23, end=23.4),
    ]
    project = _project(_clip(), words=words)
    (lane,) = lane_transcripts(project, "host")
    assert [(p.source_start, p.source_end, p.offset) for p in lane.placements] == [
        (10, 20, pytest.approx(90.0)),
        (20, 30, pytest.approx(92.0)),
        (pytest.approx(30.08), 40, pytest.approx(91.92)),
    ]
    assert lane.session_span(19.9, 20.2) == (pytest.approx(109.9), pytest.approx(110.2))
    assert lane.session_span(15, 15.5) == (pytest.approx(105.0), pytest.approx(105.5))
    assert lane.session_span(23, 23.4) == (pytest.approx(115.0), pytest.approx(115.4))


def test_the_verdict_key_moves_with_the_timing_map_and_not_for_an_untimed_clip() -> None:
    untimed = Clip(id="u", track_id="host", source_start=10, source_end=40, timeline_start=100)
    timed = _clip()
    other = _clip(timing={"steps": [{"at": 20, "delta_sec": 3}]})
    assert _heard(timed, 0, 500) != _heard(other, 0, 500)
    assert _heard(timed, 0, 500) != _heard(untimed, 0, 500)
    assert len(_heard(untimed, 0, 500)) == 13
    assert len(_heard(timed, 0, 500)) == 14


def _proposal(start: float, source_len: float) -> PhraseAlignmentProposal:
    return PhraseAlignmentProposal(
        decision_id=f"d{start}",
        direct_track_id="host",
        bleed_track_id="guest",
        clip_id="a",
        source_id=None,
        source_start=10,
        source_end=10 + source_len,
        phrase_source_start=10,
        phrase_source_end=11,
        previous_timeline_start=start,
        timeline_start=start,
        offset_sec=0.0,
        provenance="automatic",
        validation_windows=1,
        max_residual_ms=0.0,
    )


def test_a_proposal_footprint_is_its_timeline_window_when_the_plan_records_one() -> None:
    first, second, wide = _proposal(100.0, 10.0), _proposal(109.0, 10.0), _proposal(105.0, 10.0)
    windows = {first.decision_id: 8.0, second.decision_id: 8.0, wide.decision_id: 8.0}
    kept, reasons = _safe_batch_proposals((first, second), windows)
    assert len(kept) == 2 and reasons == ()
    kept, reasons = _safe_batch_proposals((first, wide), windows)
    assert kept == () and reasons
    kept, reasons = _safe_batch_proposals((first, second))
    assert kept == () and reasons


def test_a_proposal_carries_no_extra_field_so_its_preview_keys_are_unchanged() -> None:
    assert "timeline_length" not in asdict(_proposal(1.0, 1.0))


def test_planning_on_a_timed_clip_records_the_window_and_an_untimed_plan_records_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from test_retained_bleed_alignment import _episode, gate_abstains

    gate_abstains(monkeypatch)
    plan = plan_retained_bleed_alignment(
        _episode(tmp_path / "untimed"), start_sec=0.8, end_sec=3.5, defaults=load_defaults()
    )
    assert len(plan.proposals) == 1 and plan.windows == {}
    timed = _episode(tmp_path / "timed")
    timed.clips[0] = Clip.model_validate(
        {**timed.clips[0].model_dump(), "timing": {"steps": [{"at": 3.21, "delta_sec": 0.1}]}}
    )
    plan = plan_retained_bleed_alignment(
        timed, start_sec=0.8, end_sec=3.5, defaults=load_defaults()
    )
    (proposal,) = plan.proposals
    assert plan.windows == {proposal.decision_id: pytest.approx(2.04)}


def test_a_timed_clip_segment_capture_is_refused_with_its_code(tmp_path: Path) -> None:
    project = EpisodeProject.create("episode", str(tmp_path))
    project.ensure_dirs()
    project.tracks = [Track(id="host", label="Host", media=MediaAsset(path="raw/host.wav"))]
    project.clips = [_clip()]
    workspace = ProjectWorkspace.open(save_project(project))
    with pytest.raises(CodedValueError) as raised:
        capture_segment(workspace, name="x", directory=tmp_path / "cut", clip_ids=["a"])
    assert raised.value.code == "segment_render_unsupported"


def test_the_index_readers_are_right_on_a_timed_clip() -> None:
    clip = _clip(timeline_start=10)
    timeline = SessionTimeline(_project(clip))
    idx = timeline._index("host")
    assert idx is not None
    assert _gap_neighbor_drifts(idx, 0.0) == [pytest.approx(0.0)]
    assert _gap_neighbor_drifts(idx, 500.0) == [pytest.approx(-1.92)]
    assert not timeline.is_identity("host")
    assert timeline.max_drift("host") == pytest.approx(2.0)


def test_one_timed_clip_goes_through_the_remaining_readers_without_raising(tmp_path: Path) -> None:
    clip = _clip()
    assert shift_at(clip, 25.0) == pytest.approx(92.0)
    words = [TranscriptWord(text="b", start=23, end=23.4)]
    project = _project(
        clip,
        Clip(id="far", track_id="host", source_start=100, source_end=110, timeline_start=300),
        words=words,
    )
    anchor = capture_insert_anchor(project, 125.0)
    assert resolve_insert_anchor(project, anchor) == pytest.approx(125.0)
    assert speech_words_in(
        project, "host", [(100.0, 140.0)], 0.03, voiced=False, defaults=load_defaults()
    )
    (lane,) = lane_transcripts(project, "host")
    assert lane.session_span(23, 23.4) is not None
