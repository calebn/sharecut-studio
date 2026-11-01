"""Readers of a clip's shift map a clip with a timing map point by point, part 2 (#2860, 4a2)."""

from __future__ import annotations

import wave
from pathlib import Path

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.insert_anchor import capture_insert_anchor, resolve_insert_anchor
from podcast_mcp.edits.retained_bleed_alignment import (
    PhraseAlignmentProposal,
    _safe_batch_proposals,
)
from podcast_mcp.edits.speech_energy_guard import speech_words_in
from podcast_mcp.edits.timeline_ops import _edge_on_timeline
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


def test_a_timed_clip_inspection_places_each_region_at_its_own_shift(tmp_path: Path) -> None:
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
                ClipOffSpeakerMuteRegion(start_s=3, end_s=4),
                ClipOffSpeakerMuteRegion(start_s=6, end_s=7),
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
    assert [(r.timeline.start, r.timeline.end) for r in inspection.regions] == [(11, 12), (16, 17)]


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
    for at in (105.0, 115.0, 125.0):
        anchor = capture_insert_anchor(project, at)
        assert resolve_insert_anchor(project, anchor) == pytest.approx(at)
    after = capture_insert_anchor(project, 140.0)
    assert after.side == "after"
    assert after.source_sec == 40
    assert after.offset_s == pytest.approx(140.0 - project.clips[0].timeline_end)
    assert resolve_insert_anchor(project, after) == pytest.approx(140.0)


def test_a_pause_edge_on_a_timed_original_maps_through_its_piece() -> None:
    clip = _clip()
    assert _edge_on_timeline(clip, 25.0) == pytest.approx(117.0)
    assert _edge_on_timeline(clip, 40.0) == pytest.approx(clip.timeline_end)
    assert _edge_on_timeline(clip, 30.04) is None
    untimed = Clip(id="u", track_id="host", source_start=10, source_end=40, timeline_start=100)
    assert _edge_on_timeline(untimed, 25.0) == 115.0


def test_the_footprint_of_a_timed_clip_is_its_timeline_extent() -> None:
    clip = _clip()
    assert clip.timeline_end - clip.timeline_start == pytest.approx(30 + 2 - 0.08)


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


def _proposal(start: float, source_len: float, window: float) -> PhraseAlignmentProposal:
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
        timeline_length=window,
    )


def test_a_proposal_footprint_is_its_timeline_window_not_its_source_span() -> None:
    first = _proposal(100.0, 10.0, 8.0)
    second = _proposal(109.0, 10.0, 8.0)
    kept, reasons = _safe_batch_proposals((first, second))
    assert len(kept) == 2 and reasons == ()
    wide = _proposal(105.0, 10.0, 8.0)
    kept, reasons = _safe_batch_proposals((first, wide))
    assert kept == () and reasons


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
