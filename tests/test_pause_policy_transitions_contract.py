from __future__ import annotations

import copy

import numpy as np
import pytest

from pause_policy_public_helpers import (
    RATE,
    add_bed,
    configure,
    defaults,
    files,
    pause,
    primary_spans,
    project,
    room,
    voice,
    workspace,
    write_wav,
)
from podcast_mcp.edits import fillers, room_tone
from podcast_mcp.edits.edit_reasons import NL_MANUAL_REASON
from podcast_mcp.edits.ripple import EditMode
from podcast_mcp.edits.room_tone import RecordedBedSample, SampleAbsent
from podcast_mcp.edits.session_air import SessionAir
from podcast_mcp.edits.timeline_ops import (
    LaneSample,
    LaneUnavailable,
    LaneWithoutPlayback,
    room_tone_pad,
)
from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.engines.timeline_render import render_track_from_timeline
from podcast_mcp.models import (
    Clip,
    ClipJoinMode,
    SourceRecording,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
)
from podcast_mcp.services.document import EditService
from podcast_mcp.util.coded_error import CodedError


def _enabled(monkeypatch, *, optimize=False, mode="room_tone"):
    cfg = defaults(acoustic=True, mode=mode)
    cfg["tighten"].update(
        inaudible_opt=optimize,
        leave_in_if_risky=True,
        join_continuity_gate=True,
    )
    cfg["join_continuity"] = {"neural": False, "calibrate": False}
    configure(monkeypatch, cfg)
    for target in (
        "podcast_mcp.edits.inaudible_cuts.load_defaults",
        "podcast_mcp.edits.cut_quality.load_defaults",
        "podcast_mcp.edits.join_continuity.load_defaults",
        "podcast_mcp.config.load_defaults",
    ):
        monkeypatch.setattr(target, lambda: copy.deepcopy(cfg))
    return cfg


def _placed(tmp_path, *, topology="intact", guest=None):
    result = project(tmp_path, topology=topology, guest=guest)
    for index, tid in enumerate(["host", *(["guest"] if guest == "quiet" else [])]):
        audio = room(seed=1410 + index)
        for start, end in ((0, 0.2), (5, 5.2), (5.4, 5.8)):
            voice(audio, start, end)
        write_wav(tmp_path / "raw" / f"{tid}.wav", audio)
        words = [
            TranscriptWord(text="before", start=0, end=0.2),
            TranscriptWord(text="after", start=5, end=5.2),
            TranscriptWord(text="reference", start=5.4, end=5.8),
        ]
        if tid == "host":
            result.transcripts[0].words = words
        else:
            result.transcripts.append(Transcript(track_id=tid, words=words))
    return result


def _render(result, tmp_path, label, tid="host"):
    target = tmp_path.parent / f"{tmp_path.name}-{label}-{tid}.wav"
    path = render_track_from_timeline(result, result.track_by_id(tid), target, {})
    return load_mono_window(
        path, start_sec=0, duration_sec=result.timeline.duration_sec, sample_rate=RATE
    )


def _raw(tmp_path, start, end, tid="host"):
    return load_mono_window(
        tmp_path / "raw" / f"{tid}.wav",
        start_sec=start,
        duration_sec=end - start,
        sample_rate=RATE,
    )


def _same_audio(actual, start, end, expected):
    np.testing.assert_allclose(
        actual[round(start * RATE) : round(end * RATE)], expected, atol=2 / 32768, rtol=0
    )


def _notched(tmp_path, *, foreign=False):
    result = _placed(tmp_path)
    audio = room(seed=1418)
    for start, end in ((0, 0.2), (5, 5.2), (5.4, 5.8)):
        voice(audio, start, end)
    for start, end in ((1.01, 1.03), (2.01, 2.03)):
        lo, hi = round(start * RATE), round(end * RATE)
        audio[lo:hi] = 0
        audio[lo - 1] = 10 / 32767
    write_wav(tmp_path / "raw/host.wav", audio)
    edit = pause("notched", start=1, end=2, gap=None)
    edit.applied = False
    edit.boundary_mode = None
    result.edit_decisions = [edit]
    if foreign:
        add_bed(result, tmp_path)
        result.clips.append(
            Clip(
                id="foreign-after-request",
                track_id="host",
                source_id="room-tone-host",
                source_start=0,
                source_end=0.015,
                timeline_start=2.005,
            )
        )
    return result


def test_real_optimizer_preview_update_and_saved_consumption_share_settled_edges(
    tmp_path, monkeypatch
):
    _enabled(monkeypatch, optimize=True)
    ws = workspace(_notched(tmp_path))
    service = EditService(ws)
    before = files(tmp_path)

    suggested = service.preview_pending_cut("notched")

    assert suggested.edit_id == "notched"
    assert (suggested.original_start, suggested.original_end) == (1, 2)
    assert (suggested.optimized.start, suggested.optimized.end) == pytest.approx((1.011, 2.011))
    assert suggested.optimized.details["strategy"] == "word+waveform"
    assert files(tmp_path) == before
    updated = service.update_pending("notched", start=1, end=2, snap=True)
    assert (updated.id, updated.boundary_mode) == ("notched", "vocal_transcript_guided")
    assert (updated.start, updated.end) == pytest.approx((1.011, 2.011))
    assert [(e.id, e.start, e.end) for e in load_project(ws.path).edit_decisions] == [
        ("notched", pytest.approx(1.011), pytest.approx(2.011))
    ]
    assert service.approve(["notched"]) == 1
    saved = load_project(ws.path)
    record = saved.editorial.edit_log[0]
    assert record.decision_ids == ["notched"]
    assert (record.source_start, record.source_end) == pytest.approx((1.011, 2.011))
    assert record.params["replace_gap_sec"] is None
    assert primary_spans(saved) == [
        (0, pytest.approx(1.011), 0),
        (pytest.approx(2.011), 6, pytest.approx(1.011)),
    ]
    _same_audio(_render(saved, tmp_path, "settled"), 4, 4.2, _raw(tmp_path, 5, 5.2))


@pytest.mark.parametrize("delivery", ["update", "automatic"])
def test_real_optimizer_expansion_into_foreign_playback_holds_without_saved_changes(
    tmp_path, monkeypatch, delivery
):
    _enabled(monkeypatch, optimize=True)
    ws = workspace(_notched(tmp_path, foreign=True))
    before_files = files(tmp_path)
    before_model = ws.project.model_dump(mode="json")
    service = EditService(ws)
    suggestion = service.preview_pending_cut("notched")
    assert (suggestion.optimized.start, suggestion.optimized.end) == pytest.approx((1.011, 2.011))

    if delivery == "update":
        with pytest.raises(CodedError) as held:
            service.update_pending("notched", start=1, end=2, snap=True)
        assert held.value.ids == ("notched",)
        assert [(h.edit_id, h.reason) for h in held.value.held] == [("notched", "source_geometry")]
        assert files(tmp_path) == before_files
        assert ws.project.model_dump(mode="json") == before_model
    else:
        assert service.apply_auto() == 0
        saved = load_project(ws.path)
        assert [e.id for e in saved.edit_decisions] == ["notched"]
        assert primary_spans(saved) == [(0, 6, 0)]
        assert saved.editorial.edit_log == []
        assert (
            next(c for c in saved.clips if c.id == "foreign-after-request").timeline_start == 2.005
        )
    assert files(tmp_path)["raw/host.wav"] == before_files["raw/host.wav"]


@pytest.mark.parametrize("topology", ["intact", "split"])
def test_final_padded_to_splice_runs_enabled_policies_and_preserves_the_full_next_word(
    tmp_path, monkeypatch, topology
):
    _enabled(monkeypatch, optimize=True)
    result = _placed(tmp_path, topology=topology)
    result.edit_decisions = [pause("retained", start=0.3, end=4.7)]
    result.edit_decisions[0].applied = False
    ws = workspace(result)
    report = EditService(ws).join_quality(
        track_id="host", cut_start=0.3, cut_end=4.45, timebase="source"
    )
    assert report["verdict"] == "pass"
    assert [d["name"] for d in report["detectors"]] == ["inaudible_splice"]

    assert EditService(ws).approve(["retained"]) == 1

    saved = load_project(ws.path)
    record = saved.editorial.edit_log[0]
    assert record.decision_ids == ["retained"]
    assert (record.source_start, record.source_end) == pytest.approx((0.3, 4.45))
    assert record.params["replace_gap_sec"] is None
    assert all(c.source_id is None for c in saved.clips)
    right = next(c for c in saved.clips if c.source_start == pytest.approx(4.45))
    assert right.timeline_start == pytest.approx(0.3)
    assert right.join_in_mode == ClipJoinMode.FADE
    assert 0 < right.fade_in_ms <= 150
    played = _render(saved, tmp_path, "final-splice")
    _same_audio(played, 0.5, 0.84, _raw(tmp_path, 4.65, 4.99))
    _same_audio(played, 0.85, 1.05, _raw(tmp_path, 5, 5.2))


def test_unsafe_final_splice_cannot_reuse_the_stored_padded_approval(tmp_path, monkeypatch):
    _enabled(monkeypatch, optimize=True)
    result = _placed(tmp_path)
    audio = room(seed=1421)
    voice(audio, 0, 0.2)
    voice(audio, 0.22, 4.8, db=-8)
    voice(audio, 5, 5.2)
    voice(audio, 5.4, 5.8)
    write_wav(tmp_path / "raw/host.wav", audio)
    result.edit_decisions = [pause("unsafe-retained", start=0.3, end=4.7)]
    result.edit_decisions[0].applied = False
    ws = workspace(result)
    before_files = files(tmp_path)
    before_model = ws.project.model_dump(mode="json")

    with pytest.raises(CodedError) as held:
        EditService(ws).approve(["unsafe-retained"])

    assert held.value.ids == ("unsafe-retained",)
    assert files(tmp_path) == before_files
    assert ws.project.model_dump(mode="json") == before_model
    assert [e.id for e in load_project(ws.path).edit_decisions] == ["unsafe-retained"]
    _same_audio(
        _render(ws.project, tmp_path, "unsafe-current"), 0.22, 4.8, _raw(tmp_path, 0.22, 4.8)
    )


@pytest.mark.parametrize("mode", ["room_tone", "silence"])
def test_nonpause_explicit_pad_checks_own_release_onset_and_the_real_gap(
    tmp_path, monkeypatch, mode
):
    _enabled(monkeypatch, mode=mode)
    result = _placed(tmp_path, topology="deleted")
    audio = room(seed=1422)
    for start, end in ((0, 0.2), (0.15, 0.27), (5, 5.2), (5.4, 5.8)):
        voice(audio, start, end)
    write_wav(tmp_path / "raw/host.wav", audio)
    add_bed(result, tmp_path)
    result.edit_decisions = [pause("shortfall", start=0.4, end=2, gap=0.25)]
    result.edit_decisions[0].reason = "nl:range"
    result.edit_decisions[0].applied = False
    result.edit_decisions[0].next_burst_sec = 5
    ws = workspace(result)

    assert EditService(ws).approve(["shortfall"]) == 1

    saved = load_project(ws.path)
    record = saved.editorial.edit_log[0]
    assert record.decision_ids == ["shortfall"]
    assert (record.timeline_start, record.timeline_end) == pytest.approx((0.4, 2))
    assert record.params["replace_gap_sec"] == pytest.approx(0.25)
    assert primary_spans(saved) == [(0, 0.4, 0), (4.7, 6, pytest.approx(0.65))]
    left = next(c for c in saved.clips if c.source_end == 0.4)
    right = next(c for c in saved.clips if c.source_start == 4.7)
    assert (left.fade_out_ms, right.fade_in_ms) == (5, 15)
    assert (left.join_in_mode, right.join_in_mode) == (ClipJoinMode.FADE, ClipJoinMode.FADE)
    played = _render(saved, tmp_path, "final-pad")
    _same_audio(played, 0.15, 0.27, _raw(tmp_path, 0.15, 0.27))
    _same_audio(played, 0.95, 1.15, _raw(tmp_path, 5, 5.2))
    pads = [c for c in saved.clips if c.source_id == "room-tone-host"]
    if mode == "room_tone":
        assert [(c.timeline_start, c.timeline_end) for c in pads] == [pytest.approx((0.4, 0.65))]
        expected = load_mono_window(
            tmp_path / "raw/room-tone/host.wav", start_sec=0.02, duration_sec=0.21, sample_rate=RATE
        )
        _same_audio(played, 0.42, 0.63, expected)
    else:
        assert pads == []
        np.testing.assert_array_equal(
            played[round(0.4 * RATE) : round(0.65 * RATE)], np.zeros(round(0.25 * RATE))
        )


def test_above_floor_inventory_reports_actual_pcm_rejection_and_a_clean_positive(
    tmp_path, monkeypatch
):
    configure(monkeypatch, defaults(acoustic=True))
    result = project(tmp_path)
    audio = room(seed=1423)
    audio[round(0.9 * RATE) : round(1.4 * RATE)] = room(0.5, seed=1424, db=-62)
    voice(audio, 3, 3.2)
    write_wav(tmp_path / "raw/host.wav", audio)
    avoid = [(0, 0.9), (1.4, 6)]

    rejected = room_tone.room_tone_span(
        result, "host", near_sec=1.15, duration_sec=0.25, avoid=avoid
    )

    assert rejected is not None
    assert rejected.cause == "rejected"
    assert rejected.rejected_checks == ("above_floor",)
    audio[round(0.9 * RATE) : round(1.4 * RATE)] = room(0.5, seed=1425)
    write_wav(tmp_path / "raw/host.wav", audio)
    accepted = room_tone.room_tone_span(
        result, "host", near_sec=1.15, duration_sec=0.25, avoid=avoid
    )
    assert accepted.sample is not None
    assert (accepted.sample.start, accepted.sample.end) == pytest.approx((1.025, 1.275))
    assert accepted.sample.speech_prob is None


def test_known_gated_pad_lane_and_structurally_empty_lane_keep_distinct_receipts(
    tmp_path, monkeypatch
):
    _enabled(monkeypatch)
    result = _placed(tmp_path, topology="deleted", guest="gated")
    result.tracks.append(
        Track(id="empty", label="Empty", role=TrackRole.DIALOGUE, timeline_empty=True)
    )
    add_bed(result, tmp_path)
    planned = room_tone_pad(result, 0.4, 0.25)
    host, guest, empty = planned.lanes
    assert isinstance(host, LaneSample)
    assert isinstance(host.selection, RecordedBedSample)
    assert (host.selection.source_id, host.selection.start, host.selection.end) == (
        "room-tone-host",
        0,
        0.25,
    )
    assert isinstance(guest, LaneUnavailable)
    assert isinstance(guest.cause, SampleAbsent)
    assert (guest.track_id, guest.cause.cause) == ("guest", "gated_live")
    assert isinstance(empty, LaneWithoutPlayback)
    assert empty.track_id == "empty"
    result.edit_decisions = [pause("three-lanes", start=0.4, end=2)]
    result.edit_decisions[0].applied = False
    ws = workspace(result)
    assert EditService(ws).approve(["three-lanes"]) == 1
    saved = load_project(ws.path)
    assert saved.editorial.edit_log[0].decision_ids == ["three-lanes"]
    assert (saved.editorial.edit_log[0].source_start, saved.editorial.edit_log[0].source_end) == (
        pytest.approx(0.4),
        pytest.approx(1.95),
    )
    assert saved.editorial.edit_log[0].params["replace_gap_sec"] is None
    assert saved.editorial.edit_log[0].params["pad_samples"] == []
    assert primary_spans(saved) == [
        pytest.approx((0, 0.4, 0)),
        pytest.approx((1.95, 2, 0.4)),
        pytest.approx((4.7, 6, 0.45)),
    ]
    assert saved.timeline.duration_sec == pytest.approx(1.75)
    assert all(c.source_id is None for c in saved.clips)
    assert saved.track_by_id("empty").timeline_empty is True
    assert [c for c in saved.clips if c.track_id == "empty"] == []


def test_foreign_overlay_cannot_supply_original_air_or_authorize_ordinary_source_removal(
    tmp_path, monkeypatch
):
    _enabled(monkeypatch)
    result = _placed(tmp_path)
    add_bed(result, tmp_path)
    result.clips.append(
        Clip(
            id="foreign-overlap",
            track_id="host",
            source_id="room-tone-host",
            source_start=0,
            source_end=0.25,
            timeline_start=1.5,
        )
    )
    result.edit_decisions = [pause("ordinary", start=1, end=2, gap=None)]
    result.edit_decisions[0].applied = False
    ws = workspace(result)
    before_files = files(tmp_path)
    before_model = ws.project.model_dump(mode="json")

    with pytest.raises(CodedError) as held:
        EditService(ws).approve(["ordinary"])

    assert [(h.edit_id, h.reason) for h in held.value.held] == [("ordinary", "source_geometry")]
    assert files(tmp_path) == before_files
    assert ws.project.model_dump(mode="json") == before_model


def test_nonpause_origin_parked_on_another_lane_uses_actual_placed_audio_and_common_pad(
    tmp_path, monkeypatch
):
    _enabled(monkeypatch)
    result = _placed(tmp_path, topology="deleted", guest="empty")
    result.track_by_id("host").timeline_empty = True
    result.track_by_id("guest").timeline_empty = False
    result.sources.append(
        SourceRecording(
            id="host-recording", path="raw/host.wav", duration_sec=6, sample_rate=RATE, channels=1
        )
    )
    for clip in result.clips:
        clip.track_id = "guest"
        clip.source_id = "host-recording"
    result.transcripts.append(
        Transcript(
            track_id="guest",
            source_id="host-recording",
            words=[word.model_copy(deep=True) for word in result.transcripts[0].words],
        )
    )
    add_bed(result, tmp_path, "guest")
    result.edit_decisions = [pause("parked", start=0.4, end=2)]
    result.edit_decisions[0].reason = "nl:range"
    result.edit_decisions[0].applied = False
    ws = workspace(result)

    assert EditService(ws).approve(["parked"]) == 1

    saved = load_project(ws.path)
    record = saved.editorial.edit_log[0]
    assert record.decision_ids == ["parked"]
    assert (record.source_start, record.source_end) == pytest.approx((0.4, 2))
    assert (record.timeline_start, record.timeline_end) == pytest.approx((0.4, 2))
    assert record.params["replace_gap_sec"] == pytest.approx(0.25)
    assert [
        (c.source_start, c.source_end, c.timeline_start)
        for c in saved.clips
        if c.source_id == "host-recording"
    ] == [(0, 0.4, 0), (4.7, 6, pytest.approx(0.65))]
    assert [c for c in saved.clips if c.track_id == "host"] == []
    assert [
        (c.timeline_start, c.timeline_end) for c in saved.clips if c.source_id == "room-tone-guest"
    ] == [pytest.approx((0.4, 0.65))]
    _same_audio(_render(saved, tmp_path, "parked", "guest"), 0.95, 1.15, _raw(tmp_path, 5, 5.2))


@pytest.mark.parametrize("floor,loss,eligible", [(4.51, 0.49, False), (4.5, 0.5, True)])
def test_existing_timing_jnd_uses_final_loss_in_a_literal_five_second_original_pause(
    tmp_path, monkeypatch, floor, loss, eligible
):
    cfg = _enabled(monkeypatch)
    cfg["tighten"].update(min_retained_solo_pause_sec=floor, min_retained_pause_sec=floor)
    result = _placed(tmp_path)
    result.clips = [
        Clip(id="before", track_id="host", source_start=0, source_end=0.5, timeline_start=0),
        Clip(id="placed", track_id="host", source_start=0.5, source_end=6, timeline_start=0.5),
    ]
    result.timeline.duration_sec = 6
    result.transcripts[0].words = [
        TranscriptWord(text="before", start=0, end=0.5),
        TranscriptWord(text="after", start=5.5, end=5.7),
        TranscriptWord(text="reference", start=5.8, end=6),
    ]
    audio = room(seed=1426)
    for start, end in ((0, 0.5), (5.5, 5.7), (5.8, 6)):
        voice(audio, start, end)
    write_wav(tmp_path / "raw/host.wav", audio)
    result.edit_decisions = [pause("jnd", start=1, end=2, gap=None)]
    result.edit_decisions[0].applied = False
    ws = workspace(result)
    before_files = files(tmp_path)
    before_model = ws.project.model_dump(mode="json")
    assert SessionAir(ws.project).silence_around(1, 2) == pytest.approx(5)
    native_jnd = fillers.pause_trim_is_imperceptible
    jnd_checks = []

    def observe_jnd(removed_sec, pause_sec):
        imperceptible = native_jnd(removed_sec, pause_sec)
        jnd_checks.append((removed_sec, pause_sec, imperceptible))
        return imperceptible

    monkeypatch.setattr(fillers, "pause_trim_is_imperceptible", observe_jnd)

    if eligible:
        assert EditService(ws).approve(["jnd"]) == 1
        saved = load_project(ws.path)
        record = saved.editorial.edit_log[0]
        assert record.decision_ids == ["jnd"]
        assert (record.source_start, record.source_end) == pytest.approx((1, 1.5))
        assert (record.timeline_start, record.timeline_end) == pytest.approx((1, 1.5))
        assert record.params["replace_gap_sec"] is None
        assert saved.timeline.duration_sec == pytest.approx(6 - loss)
        _same_audio(_render(saved, tmp_path, "jnd"), 5, 5.2, _raw(tmp_path, 5.5, 5.7))
    else:
        with pytest.raises(CodedError) as held:
            EditService(ws).approve(["jnd"])
        assert [(h.edit_id, h.reason, h.detail) for h in held.value.held] == [
            ("jnd", "pause_air", "no_air")
        ]
        assert files(tmp_path) == before_files
        assert ws.project.model_dump(mode="json") == before_model
    assert (pytest.approx(loss), pytest.approx(5), not eligible) in jnd_checks


def test_original_pause_cannot_credit_an_unplayed_timeline_hole(tmp_path, monkeypatch):
    _enabled(monkeypatch)
    result = _placed(tmp_path)
    result.clips = [
        Clip(id="before", track_id="host", source_start=0, source_end=0.5, timeline_start=0),
        Clip(id="placed", track_id="host", source_start=0.5, source_end=6, timeline_start=3.2),
    ]
    result.timeline.duration_sec = 8.7
    result.edit_decisions = [pause("hole", start=1, end=2, gap=None)]
    ws = workspace(result)
    before_files = files(tmp_path)
    before_model = ws.project.model_dump(mode="json")
    with pytest.raises(CodedError) as held:
        EditService(ws).approve(["hole"])
    assert [(h.edit_id, h.reason) for h in held.value.held] == [("hole", "source_geometry")]
    assert files(tmp_path) == before_files
    assert ws.project.model_dump(mode="json") == before_model


def test_nonpause_actual_one_second_removal_and_point_two_gap_lose_point_eight_on_every_lane(
    tmp_path, monkeypatch
):
    cfg = _enabled(monkeypatch)
    cfg["tighten"].update(min_retained_solo_pause_sec=0.5, min_retained_pause_sec=0.5)
    result = _placed(tmp_path, topology="deleted", guest="quiet")
    result.transcripts[0].words[0].end = 0.3
    audio = room(seed=1428)
    for start, end in ((0, 0.3), (5, 5.2), (5.4, 5.8)):
        voice(audio, start, end)
    write_wav(tmp_path / "raw/host.wav", audio)
    result.clips = [c for c in result.clips if c.track_id == "host"] + [
        Clip(id="long-peer", track_id="guest", source_start=0, source_end=6, timeline_start=0)
    ]
    result.timeline.duration_sec = 6
    add_bed(result, tmp_path)
    add_bed(result, tmp_path, "guest")
    result.edit_decisions = [pause("actual-loss", start=1, end=2, gap=0.2)]
    result.edit_decisions[0].reason = "nl:range"
    result.edit_decisions[0].applied = False
    ws = workspace(result)
    assert SessionAir(ws.project).silence_around(1, 2) == pytest.approx(2)

    assert EditService(ws).approve(["actual-loss"]) == 1

    saved = load_project(ws.path)
    record = saved.editorial.edit_log[0]
    assert record.decision_ids == ["actual-loss"]
    assert (record.timeline_start, record.timeline_end) == (1, 2)
    assert record.params["replace_gap_sec"] == pytest.approx(0.2)
    assert saved.timeline.duration_sec == pytest.approx(5.2)
    assert primary_spans(saved) == [(0, 1, 0), (4.7, 6, pytest.approx(1.2))]
    assert primary_spans(saved, "guest") == [(0, 1, 0), (2, 6, pytest.approx(1.2))]
    for tid in ("host", "guest"):
        assert [
            (c.timeline_start, c.timeline_end)
            for c in saved.clips
            if c.source_id == f"room-tone-{tid}"
        ] == [pytest.approx((1, 1.2))]
    _same_audio(_render(saved, tmp_path, "actual-loss"), 1.5, 1.7, _raw(tmp_path, 5, 5.2))
    _same_audio(
        _render(saved, tmp_path, "actual-loss", "guest"), 4.2, 4.4, _raw(tmp_path, 5, 5.2, "guest")
    )


@pytest.mark.parametrize("mode", ["room_tone", "silence"])
@pytest.mark.parametrize("minimum,cap,gap", [(0.35, 1, 0.68), (0.9, 1, 0.9), (0.35, 0.6, 0.6)])
def test_public_nl_coalescing_recalculates_fraction_floor_and_cap_from_the_final_span(
    tmp_path, monkeypatch, mode, minimum, cap, gap
):
    cfg = _enabled(monkeypatch, mode=mode)
    cfg["tighten"].update(
        min_gap_after_filler_sec=minimum,
        filler_gap_retain_fraction=0.85,
        filler_replace_gap_max_sec=cap,
    )
    result = _placed(tmp_path)
    add_bed(result, tmp_path)
    first = pause("nl-first", start=1, end=1.4, gap=minimum)
    first.reason = NL_MANUAL_REASON
    first.applied = False
    first.review_required = True
    first.boundary_mode = "vocal_transcript_guided"
    result.edit_decisions = [first]
    ws = workspace(result)

    EditService(ws).cut_time_range(
        "host", 1.39, 1.8, reason=NL_MANUAL_REASON, use_inaudible_opt=False
    )

    pending = load_project(ws.path).edit_decisions
    assert [(e.id, e.start, e.end, e.replace_gap_sec) for e in pending] == [
        ("nl-first", 1, 1.8, pytest.approx(gap))
    ]
    assert EditService(ws).approve(["nl-first"]) == 1
    saved = load_project(ws.path)
    record = saved.editorial.edit_log[0]
    assert record.decision_ids == ["nl-first"]
    assert (record.source_start, record.source_end) == (1, 1.8)
    assert record.params["replace_gap_sec"] == pytest.approx(gap)
    assert saved.timeline.duration_sec == pytest.approx(5.2 + gap)
    assert primary_spans(saved) == [(0, 1, 0), (1.8, 6, pytest.approx(1 + gap))]
    pads = [c for c in saved.clips if c.source_id == "room-tone-host"]
    played = _render(saved, tmp_path, "coalesced")
    if mode == "room_tone":
        assert sum(c.source_end - c.source_start for c in pads) == pytest.approx(gap)
        assert min(c.timeline_start for c in pads) == 1
        assert max(c.timeline_end for c in pads) == pytest.approx(1 + gap)
        expected = load_mono_window(
            tmp_path / "raw/room-tone/host.wav", start_sec=0.02, duration_sec=0.21, sample_rate=RATE
        )
        _same_audio(played, 1.02, 1.23, expected)
    else:
        assert pads == []
        np.testing.assert_array_equal(
            played[RATE : round((1 + gap) * RATE)], np.zeros(round(gap * RATE))
        )
    _same_audio(played, 4.2 + gap, 4.4 + gap, _raw(tmp_path, 5, 5.2))


@pytest.mark.parametrize("reverse", [False, True])
def test_automatic_original_shortage_leaves_a_real_filler_survivor_and_the_same_pending_pause(
    tmp_path, monkeypatch, reverse
):
    cfg = _enabled(monkeypatch)
    cfg["tighten"].update(min_retained_solo_pause_sec=2.2, min_retained_pause_sec=2.2)
    result = _placed(tmp_path, topology="deleted", guest="quiet")
    add_bed(result, tmp_path)
    audio = room(seed=1427)
    for start, end in ((0, 0.2), (0.6, 0.8), (5, 5.2), (5.4, 5.8)):
        voice(audio, start, end)
    write_wav(tmp_path / "raw/host.wav", audio)
    result.transcripts[0].words.insert(1, TranscriptWord(text="um", start=0.6, end=0.8))
    filler = pause("filler-survivor", start=0.6, end=0.8, gap=None)
    filler.reason = "filler:um"
    held_pause = pause("pad-held", start=1, end=2)
    held_pause.applied = False
    result.edit_decisions = [filler, held_pause]
    if reverse:
        result.edit_decisions.reverse()
    ws = workspace(result)
    before_raw = files(tmp_path)["raw/host.wav"]

    assert EditService(ws).apply_auto() == 1

    saved = load_project(ws.path)
    assert [(e.id, e.applied) for e in saved.edit_decisions] == [("pad-held", False)]
    assert [r.decision_ids for r in saved.editorial.edit_log] == [["filler-survivor"]]
    assert primary_spans(saved) == [
        (0, 0.6, 0),
        (0.8, 2, pytest.approx(0.6)),
        (4.7, 6, pytest.approx(1.8)),
    ]
    assert primary_spans(saved, "guest") == [(0, 0.6, 0), (0.8, 3.3, pytest.approx(0.6))]
    assert [c for c in saved.clips if c.source_id == "room-tone-host"] == []
    assert files(tmp_path)["raw/host.wav"] == before_raw
    _same_audio(_render(saved, tmp_path, "survivor"), 2.1, 2.3, _raw(tmp_path, 5, 5.2))
    stable_files = files(tmp_path)
    assert EditService(ws).apply_auto() == 0
    assert files(tmp_path) == stable_files
    assert [r.decision_ids for r in load_project(ws.path).editorial.edit_log] == [
        ["filler-survivor"]
    ]


@pytest.mark.parametrize("action", ["exact", "clip"])
def test_exact_occurrence_and_direct_clip_actions_preserve_the_other_source_copy(
    tmp_path, monkeypatch, action
):
    _enabled(monkeypatch)
    result = _placed(tmp_path)
    result.clips = [
        Clip(id="first", track_id="host", source_start=1, source_end=2, timeline_start=0),
        Clip(id="selected-copy", track_id="host", source_start=1, source_end=2, timeline_start=3),
    ]
    result.timeline.duration_sec = 4
    result.edit_decisions = [pause("ambiguous", start=1, end=2, gap=None)]
    result.edit_decisions[0].applied = False
    ws = workspace(result)
    service = EditService(ws)

    if action == "exact":
        target = service.selected_range_target(3, 4, ["host"])
        applied = service.edit_selected_range(
            target,
            "cut",
            propose=False,
            reason="manual exact occurrence",
            action_id="selected-occurrence",
        )
        assert applied["action_id"] == "selected-occurrence"
        assert applied["proposed"] is False
    else:
        applied = service.delete_clips(["selected-copy"], mode=EditMode.GAP)
        assert applied["operation"] == "delete_clips"
    saved = load_project(ws.path)
    assert [
        (c.id, c.track_id, c.source_id, c.source_start, c.source_end, c.timeline_start)
        for c in saved.clips
    ] == [("first", "host", None, 1, 2, 0)]
    assert [(e.id, e.applied) for e in saved.edit_decisions] == [("ambiguous", False)]
    _same_audio(_render(saved, tmp_path, "occurrence"), 0, 1, _raw(tmp_path, 1, 2))
