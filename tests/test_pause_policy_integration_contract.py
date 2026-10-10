from __future__ import annotations

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
from podcast_mcp.edits import room_tone
from podcast_mcp.edits.pending_preview import apply_for_suggested, resolve_pending_preview
from podcast_mcp.edits.room_tone import room_tone_span
from podcast_mcp.edits.source_removals import CutScopeHold, inspect_source_remove
from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.engines.timeline_render import render_track_from_timeline
from podcast_mcp.models import Clip, EditDecisionType, Transcript, TranscriptWord, load_project
from podcast_mcp.services.document import EditService
from podcast_mcp.util.coded_error import CodedError
from podcast_mcp.util.timebase import SourceSec


def _acoustic_project(tmp_path, *, topology="intact", guest=None):
    result = project(tmp_path, topology=topology, guest=guest)
    for index, track in enumerate(result.tracks):
        if track.timeline_empty:
            continue
        audio = room(seed=1240 + index)
        for start, end in ((0, 0.2), (5, 5.2), (5.4, 5.8)):
            voice(audio, start, end)
        write_wav(tmp_path / "raw" / f"{track.id}.wav", audio)
    result.transcripts = [
        Transcript(
            track_id=track.id,
            words=[
                TranscriptWord(text="before", start=0, end=0.2),
                TranscriptWord(text="after", start=5, end=5.2),
                TranscriptWord(text="reference", start=5.4, end=5.8),
            ],
        )
        for track in result.tracks
        if not track.timeline_empty
    ]
    return result


def _clip_rows(result):
    return sorted(
        (
            c.track_id,
            c.timeline_start,
            c.source_start,
            c.source_end,
            c.source_id or "",
            c.fade_in_ms,
            c.fade_out_ms,
        )
        for c in result.clips
    )


def _render_audio(result, tmp_path, label, tid="host"):
    output = tmp_path.parent / f"{tmp_path.name}-{label}-{tid}.wav"
    rendered = render_track_from_timeline(result, result.track_by_id(tid), output, {})
    return load_mono_window(
        rendered,
        start_sec=0,
        duration_sec=result.timeline.duration_sec,
        sample_rate=RATE,
    )


@pytest.mark.parametrize("topology", ["intact", "split"])
def test_enabled_saved_and_suggested_keep_the_same_original_suffix_and_next_word(
    tmp_path, monkeypatch, topology
):
    cfg = defaults(acoustic=True)
    configure(monkeypatch, cfg)
    result = _acoustic_project(tmp_path, topology=topology)
    result.edit_decisions = [pause(start=0.3, end=4.7)]
    ws = workspace(result)
    before_files = files(tmp_path)
    current = _render_audio(ws.project, tmp_path, "current")
    snapshot = ws.project.model_copy(deep=True)

    suggested_end = apply_for_suggested(snapshot, resolve_pending_preview(snapshot, "pause"))

    assert suggested_end == pytest.approx(1.05)
    assert files(tmp_path) == before_files
    assert [e.id for e in load_project(ws.path).edit_decisions] == ["pause"]
    assert EditService(ws).approve(["pause"]) == 1
    saved = load_project(ws.path)
    for edited in (snapshot, saved):
        record = edited.editorial.edit_log[0]
        assert record.decision_ids == ["pause"]
        assert (record.source_start, record.source_end) == pytest.approx((0.3, 4.45))
        assert (record.timeline_start, record.timeline_end) == pytest.approx((0.3, 4.45))
        assert record.params["replace_gap_sec"] is None
        assert record.params["pad_samples"] == []
        assert [
            (f["side"], f["source_start"], f["source_end"], f["timeline_sec"], f["milliseconds"])
            for f in record.params["edge_fades"]
        ] == [
            ("left", pytest.approx(0.2), pytest.approx(0.3), pytest.approx(0.3), 100),
            ("right", pytest.approx(4.45), pytest.approx(4.6), pytest.approx(0.3), 150),
        ]
        assert edited.timeline.duration_sec == pytest.approx(1.85)
        assert SessionTimeline(edited).exact_source_span(
            "host", SourceSec(4.45), SourceSec(5)
        ) == pytest.approx((0.3, 0.85))
    assert _clip_rows(saved) == _clip_rows(snapshot)
    assert primary_spans(saved) == (
        [pytest.approx((0, 0.3, 0)), pytest.approx((4.45, 6, 0.3))]
        if topology == "intact"
        else [
            pytest.approx((0, 0.3, 0)),
            pytest.approx((4.45, 4.7, 0.3)),
            pytest.approx((4.7, 6, 0.55)),
        ]
    )
    for edited, label in ((snapshot, "suggested"), (saved, "saved")):
        audio = _render_audio(edited, tmp_path, label)
        np.testing.assert_allclose(
            audio[round(0.45 * RATE) : round(0.84 * RATE)],
            current[round(4.6 * RATE) : round(4.99 * RATE)],
            atol=2 / 32768,
            rtol=0,
        )
        np.testing.assert_allclose(
            audio[round(0.85 * RATE) : round(1.05 * RATE)],
            current[round(5 * RATE) : round(5.2 * RATE)],
            atol=2 / 32768,
            rtol=0,
        )


def test_enabled_original_pause_uses_consumed_seam_despite_a_nearer_peer_join(
    tmp_path, monkeypatch
):
    configure(monkeypatch, defaults(acoustic=True))
    result = _acoustic_project(tmp_path, topology="deleted", guest="quiet")
    result.clips = [c for c in result.clips if c.track_id == "host"] + [
        Clip(id="peer-left", track_id="guest", source_start=0, source_end=0.28, timeline_start=0),
        Clip(id="peer-right", track_id="guest", source_start=2, source_end=6, timeline_start=0.28),
    ]
    add_bed(result, tmp_path)
    add_bed(result, tmp_path, "guest")
    write_wav(tmp_path / "raw/room-tone/guest.wav", room(0.25, seed=1249, db=-58))
    edit = pause(start=0.3)
    edit.next_burst_sec = 5
    result.edit_decisions = [edit]
    ws = workspace(result)

    assert EditService(ws).approve(["pause"]) == 1

    saved = load_project(ws.path)
    record = saved.editorial.edit_log[0]
    assert record.decision_ids == ["pause"]
    assert (record.timeline_start, record.timeline_end) == pytest.approx((0.3, 1.85))
    assert record.params["replace_gap_sec"] is None
    assert record.params["pad_samples"] == []
    assert primary_spans(saved) == [
        pytest.approx((0, 0.3, 0)),
        pytest.approx((1.85, 2, 0.3)),
        pytest.approx((4.7, 6, 0.45)),
    ]
    assert primary_spans(saved, "guest") == [
        pytest.approx((0, 0.28, 0)),
        pytest.approx((2, 2.02, 0.28)),
        pytest.approx((3.57, 6, 0.3)),
    ]
    assert saved.timeline.duration_sec == pytest.approx(2.73)
    for tid, resume in (("host", 1.85), ("guest", 3.57)):
        assert [c for c in saved.clips if c.source_id == f"room-tone-{tid}"] == []
        right = next(
            c for c in saved.clips if c.track_id == tid and c.source_start == pytest.approx(resume)
        )
        assert (right.timeline_start, right.fade_in_ms) == pytest.approx((0.3, 150))
    host_audio = _render_audio(saved, tmp_path, "onset")
    original_onset = load_mono_window(
        tmp_path / "raw/host.wav", start_sec=5, duration_sec=0.2, sample_rate=RATE
    )
    np.testing.assert_allclose(
        host_audio[round(0.75 * RATE) : round(0.95 * RATE)],
        original_onset,
        atol=2 / 32768,
        rtol=0,
    )


def test_public_nonpause_tiles_an_actual_own_sample_and_a_registered_peer_in_one_gap(
    tmp_path, monkeypatch
):
    cfg = defaults(acoustic=True)
    cfg["tighten"]["min_retained_solo_pause_sec"] = 0.9
    configure(monkeypatch, cfg)
    result = _acoustic_project(tmp_path, topology="deleted", guest="quiet")
    add_bed(result, tmp_path, "guest")
    excluded = pause("pending-mute", start=0.2, end=4.6, gap=None)
    excluded.type = EditDecisionType.MUTE
    excluded.reason = "filler:um"
    excluded.review_required = True
    excluded_tail = pause("pending-tail-mute", start=4.85, end=6, gap=None)
    excluded_tail.type = EditDecisionType.MUTE
    excluded_tail.reason = "filler:um"
    excluded_tail.review_required = True
    requested = pause(start=0.3, gap=0.6)
    requested.reason = "nl:range"
    result.edit_decisions = [excluded, excluded_tail, requested]
    ws = workspace(result)

    assert EditService(ws).approve(["pause"]) == 1

    saved = load_project(ws.path)
    assert [e.id for e in saved.edit_decisions] == ["pending-mute", "pending-tail-mute"]
    assert [r.decision_ids for r in saved.editorial.edit_log] == [["pause"]]
    assert saved.editorial.edit_log[0].params["replace_gap_sec"] == pytest.approx(0.6)
    assert saved.timeline.duration_sec == pytest.approx(2.2)
    host_pads = sorted(
        (c for c in saved.clips if c.track_id == "host" and 0.3 <= c.timeline_start < 0.9),
        key=lambda c: c.timeline_start,
    )
    assert [(c.timeline_start, c.source_start, c.source_end) for c in host_pads] == [
        pytest.approx((0.3, 4.6, 4.85)),
        pytest.approx((0.55, 4.6, 4.85)),
        pytest.approx((0.8, 4.6, 4.7)),
    ]
    assert [c.source_id for c in host_pads] == [None, None, None]
    assert [(c.fade_in_ms, c.fade_out_ms) for c in host_pads] == [(10, 0), (0, 0), (0, 10)]
    guest_pads = sorted(
        (c for c in saved.clips if c.source_id == "room-tone-guest"),
        key=lambda c: c.timeline_start,
    )
    assert [(c.timeline_start, c.source_start, c.source_end) for c in guest_pads] == [
        pytest.approx((0.3, 0, 0.25)),
        pytest.approx((0.55, 0, 0.25)),
        pytest.approx((0.8, 0, 0.1)),
    ]
    assert [(c.fade_in_ms, c.fade_out_ms) for c in guest_pads] == [(10, 0), (0, 0), (0, 10)]
    played = _render_audio(saved, tmp_path, "own-tiles")
    for at, seconds in ((0.32, 0.21), (0.57, 0.21), (0.82, 0.06)):
        expected = load_mono_window(
            tmp_path / "raw/host.wav", start_sec=4.62, duration_sec=seconds, sample_rate=RATE
        )
        np.testing.assert_allclose(
            played[round(at * RATE) : round((at + seconds) * RATE)],
            expected,
            atol=2 / 32768,
            rtol=0,
        )
    for tid in ("host", "guest"):
        assert max(c.timeline_end for c in saved.clips if c.track_id == tid) == pytest.approx(2.2)


@pytest.mark.parametrize("failure", ["missing", "corrupt", "digital", "unregistered", "path"])
def test_saved_nonpause_uses_clean_own_air_when_the_registered_render_bed_is_unusable(
    tmp_path, monkeypatch, failure
):
    configure(monkeypatch, defaults(acoustic=True))
    result = _acoustic_project(tmp_path, topology="deleted")
    add_bed(result, tmp_path)
    bed_path = tmp_path / "raw/room-tone/host.wav"
    if failure == "missing":
        bed_path.unlink()
    elif failure == "corrupt":
        bed_path.write_bytes(b"this is not an audio container")
    elif failure == "digital":
        write_wav(bed_path, np.zeros(round(0.25 * RATE)))
    elif failure == "unregistered":
        result.sources = []
    else:
        result.source_by_id("room-tone-host").path = "raw/absent-render-bed.wav"
    excluded = pause("sample-excluded", start=0.2, end=2, gap=None)
    excluded.type = EditDecisionType.MUTE
    excluded.reason = "nl:sampling exclusion"
    excluded.review_required = True
    requested = pause(start=0.3)
    requested.reason = "nl:range"
    result.edit_decisions = [excluded, requested]
    ws = workspace(result)
    raw_bytes = (tmp_path / "raw/host.wav").read_bytes()

    assert EditService(ws).approve(["pause"]) == 1

    saved = load_project(ws.path)
    assert [e.id for e in saved.edit_decisions] == ["sample-excluded"]
    assert [r.decision_ids for r in saved.editorial.edit_log] == [["pause"]]
    record = saved.editorial.edit_log[0]
    assert (record.timeline_start, record.timeline_end) == pytest.approx((0.3, 2))
    assert record.params["replace_gap_sec"] == pytest.approx(0.25)
    assert primary_spans(saved) == [
        pytest.approx((0, 0.3, 0)),
        pytest.approx((2, 2.25, 0.3)),
        pytest.approx((4.7, 6, 0.55)),
    ]
    pad = next(c for c in saved.clips if c.timeline_start == pytest.approx(0.3))
    assert pad.source_id is None
    assert (pad.fade_in_ms, pad.fade_out_ms) == (10, 10)
    played = _render_audio(saved, tmp_path, "bed-fallback")
    expected = load_mono_window(
        tmp_path / "raw/host.wav", start_sec=2.02, duration_sec=0.21, sample_rate=RATE
    )
    np.testing.assert_allclose(
        played[round(0.32 * RATE) : round(0.53 * RATE)], expected, atol=2 / 32768, rtol=0
    )
    assert (tmp_path / "raw/host.wav").read_bytes() == raw_bytes


@pytest.mark.parametrize("order", [("pad", "pause"), ("pause", "pad")])
def test_sequential_public_approvals_recheck_replay_and_removed_source_in_both_orders(
    tmp_path, monkeypatch, order
):
    configure(monkeypatch, defaults(acoustic=True))
    result = _acoustic_project(tmp_path)
    edits = {
        "pad": pause("pad", start=2, end=3, gap=0.6),
        "pause": pause("pause", start=1.7, end=2.3, gap=None),
    }
    edits["pad"].reason = "filler:um"
    result.edit_decisions = [edits[order[0]]]
    ws = workspace(result)
    service = EditService(ws)

    assert service.approve([order[0]]) == 1

    first = load_project(ws.path)
    assert [r.decision_ids for r in first.editorial.edit_log] == [[order[0]]]
    if order[0] == "pad":
        assert primary_spans(first) == [
            pytest.approx((0, 2, 0)),
            pytest.approx((1.7, 2.3, 2)),
            pytest.approx((3, 6, 2.6)),
        ]
        assert first.editorial.edit_log[0].params["replace_gap_sec"] == pytest.approx(0.6)
        played = _render_audio(first, tmp_path, "replay")
        expected = load_mono_window(
            tmp_path / "raw/host.wav", start_sec=1.72, duration_sec=0.56, sample_rate=RATE
        )
        np.testing.assert_allclose(
            played[round(2.02 * RATE) : round(2.58 * RATE)], expected, atol=2 / 32768, rtol=0
        )
    else:
        assert primary_spans(first) == [pytest.approx((0, 1.7, 0)), pytest.approx((2.3, 6, 1.7))]
        assert first.editorial.edit_log[0].params["replace_gap_sec"] is None
    ws.mutate(
        "before stage second source request",
        "after stage second source request",
        lambda p: p.edit_decisions.append(edits[order[1]].model_copy(deep=True)),
    )
    before_files = files(tmp_path)
    before_model = ws.project.model_dump(mode="json")

    with pytest.raises(CodedError) as held:
        service.approve([order[1]])

    assert held.value.code == "cut_scope_changed"
    assert held.value.ids == (order[1],)
    assert [(h.edit_id, h.reason, h.peers) for h in held.value.held] == [
        (order[1], "source_geometry", ())
    ]
    assert files(tmp_path) == before_files
    assert ws.project.model_dump(mode="json") == before_model
    saved = load_project(ws.path)
    assert [e.id for e in saved.edit_decisions] == [order[1]]
    assert [r.decision_ids for r in saved.editorial.edit_log] == [[order[0]]]
    assert primary_spans(saved) == primary_spans(first)
    assert saved.timeline.duration_sec == pytest.approx(5.6 if order[0] == "pad" else 5.4)


@pytest.mark.parametrize("order", [("held", "eligible"), ("eligible", "held")])
@pytest.mark.parametrize("delivery", ["saved", "automatic"])
def test_shared_held_row_leaves_the_literal_eligible_id_in_both_orders(
    tmp_path, monkeypatch, order, delivery
):
    configure(monkeypatch, defaults(acoustic=True))
    result = _acoustic_project(tmp_path, guest="quiet")
    result.clips.append(
        Clip(
            id="replayed-host",
            track_id="host",
            source_start=0.3,
            source_end=4.45,
            timeline_start=9,
        )
    )
    result.timeline.duration_sec = 13.15
    edits = {
        "held": pause("held", start=0.2, end=4.7),
        "eligible": pause("eligible", start=0.3, end=4.45, gap=None, track_id="guest"),
    }
    result.edit_decisions = [edits[key] for key in order]
    ws = workspace(result)
    service = EditService(ws)
    before_files = files(tmp_path)
    before_model = ws.project.model_dump(mode="json")

    if delivery == "saved":
        with pytest.raises(CodedError) as held:
            service.approve(list(order))
        assert held.value.code == "cut_scope_changed"
        assert held.value.ids == ("held",)
        assert [(h.edit_id, h.reason, h.peers) for h in held.value.held] == [
            ("held", "source_geometry", ())
        ]
        assert files(tmp_path) == before_files
        assert ws.project.model_dump(mode="json") == before_model
        assert [e.id for e in load_project(ws.path).edit_decisions] == list(order)

    assert service.apply_auto() == 1

    saved = load_project(ws.path)
    assert [e.id for e in saved.edit_decisions] == ["held"]
    assert [r.decision_ids for r in saved.editorial.edit_log] == [["eligible"]]
    record = saved.editorial.edit_log[0]
    assert (record.source_start, record.source_end) == pytest.approx((0.3, 4.45))
    assert (record.timeline_start, record.timeline_end) == pytest.approx((0.3, 4.45))
    assert record.params["replace_gap_sec"] is None
    assert primary_spans(saved, "guest") == [
        pytest.approx((0, 0.3, 0)),
        pytest.approx((4.45, 6, 0.3)),
    ]
    assert primary_spans(saved) == [
        pytest.approx((0, 0.3, 0)),
        pytest.approx((0.3, 4.45, 4.85)),
        pytest.approx((4.45, 6, 0.3)),
    ]
    assert saved.timeline.duration_sec == pytest.approx(9)


@pytest.mark.parametrize("order", [("host", "guest"), ("guest", "host")])
def test_enabled_public_proposal_emits_the_same_clean_twin_id_in_both_orders(
    tmp_path, monkeypatch, order
):
    configure(monkeypatch, defaults(acoustic=True))
    result = _acoustic_project(tmp_path, guest="quiet")
    result.clips.append(
        Clip(
            id="replayed-host",
            track_id="host",
            source_start=0.2,
            source_end=4.45,
            timeline_start=9,
        )
    )
    result.timeline.duration_sec = 13.25
    tracks = {t.id: t for t in result.tracks}
    transcripts = {t.track_id: t for t in result.transcripts}
    result.tracks = [tracks[tid] for tid in order]
    result.transcripts = [transcripts[tid] for tid in order]
    ws = workspace(result)

    held = inspect_source_remove(ws.project, pause("replayed-host", end=4.45, gap=None))
    assert isinstance(held, CutScopeHold)
    assert (held.edit_id, held.reason) == ("replayed-host", "source_geometry")
    proposal = EditService(ws).propose_tighten(intensity="medium")

    assert [d.id for d in proposal.decisions] == ["cut_pause_200_5000_84983c60f7"]
    decision = proposal.decisions[0]
    assert (decision.track_id, decision.scope, decision.replace_gap_sec) == (
        "guest",
        "session",
        None,
    )
    assert 0.2 <= decision.start <= 0.3
    assert decision.end == pytest.approx(4.45)
    saved = load_project(ws.path)
    assert [d.id for d in saved.edit_decisions] == ["cut_pause_200_5000_84983c60f7"]
    assert saved.editorial.edit_log == []
    assert primary_spans(saved, "guest") == [(0, 6, 0)]
    assert primary_spans(saved) == [(0, 6, 0), (0.2, 4.45, 9)]


@pytest.mark.parametrize("gap", [0.25, 0.35])
@pytest.mark.parametrize("order", [("loss-held", "eligible"), ("eligible", "loss-held")])
def test_zero_and_negative_loss_rows_cannot_consume_the_eligible_twin(
    tmp_path, monkeypatch, gap, order
):
    configure(monkeypatch, defaults(acoustic=True))
    result = _acoustic_project(tmp_path, guest="quiet")
    edits = {
        "loss-held": pause("loss-held", start=1, end=1.25, gap=gap),
        "eligible": pause("eligible", start=0.7, end=1.5, gap=None, track_id="guest"),
    }
    final_loss = inspect_source_remove(result, edits["loss-held"])
    assert isinstance(final_loss, CutScopeHold)
    assert (final_loss.edit_id, final_loss.reason) == ("loss-held", "pause_not_shorter")
    edits["loss-held"].replace_gap_sec = None
    result.edit_decisions = [edits[key] for key in order]
    ws = workspace(result)
    service = EditService(ws)
    before_files = files(tmp_path)
    before_model = ws.project.model_dump(mode="json")

    with pytest.raises(CodedError) as held:
        service.approve(["loss-held"])

    assert held.value.code == "cut_scope_changed"
    assert held.value.ids == ("loss-held",)
    assert [(h.edit_id, h.reason) for h in held.value.held] == [
        ("loss-held", "pause_imperceptible")
    ]
    assert files(tmp_path) == before_files
    assert ws.project.model_dump(mode="json") == before_model
    assert service.apply_auto() == 1
    saved = load_project(ws.path)
    assert [e.id for e in saved.edit_decisions] == ["loss-held"]
    assert [r.decision_ids for r in saved.editorial.edit_log] == [["eligible"]]
    assert (
        saved.editorial.edit_log[0].timeline_start,
        saved.editorial.edit_log[0].timeline_end,
    ) == pytest.approx((0.7, 1.5))
    assert saved.editorial.edit_log[0].params["replace_gap_sec"] is None
    for tid in ("host", "guest"):
        assert primary_spans(saved, tid) == [
            pytest.approx((0, 0.7, 0)),
            pytest.approx((1.5, 6, 0.7)),
        ]
    assert saved.timeline.duration_sec == pytest.approx(5.2)


@pytest.mark.parametrize("lane", ["host", "guest"])
@pytest.mark.parametrize("kind", ["word", "breath"])
def test_saved_pause_keeps_both_edge_sounds_whole_with_acoustic_checks_enabled(
    tmp_path, monkeypatch, lane, kind
):
    configure(monkeypatch, defaults(acoustic=True))
    result = _acoustic_project(tmp_path, guest="quiet")
    audio = room(seed=1260)
    for start, end in ((0, 0.2), (5, 5.2), (5.4, 5.8)):
        voice(audio, start, end)
    if kind == "word":
        voice(audio, 2.9, 3.15)
        voice(audio, 3.85, 4.1)
    else:
        rng = np.random.default_rng(1261)
        for start, end in ((2.9, 3.15), (3.85, 4.1)):
            lo, hi = round(start * RATE), round(end * RATE)
            audio[lo:hi] += rng.normal(0, 10 ** (-50 / 20), hi - lo)
    write_wav(tmp_path / f"raw/{lane}.wav", audio)
    result.edit_decisions = [pause(start=3, end=4, gap=None)]
    ws = workspace(result)
    current = _render_audio(ws.project, tmp_path, "whole-current", lane)

    assert EditService(ws).approve(["pause"]) == 1

    saved = load_project(ws.path)
    record = saved.editorial.edit_log[0]
    assert record.decision_ids == ["pause"]
    assert record.params["replace_gap_sec"] is None
    assert 3.15 <= record.source_start <= 3.25
    assert 3.75 <= record.source_end <= 3.85
    assert record.source_end - record.source_start == pytest.approx(0.64, abs=0.06)
    played = _render_audio(saved, tmp_path, "whole-saved", lane)
    np.testing.assert_allclose(
        played[round(2.9 * RATE) : round(3.15 * RATE)],
        current[round(2.9 * RATE) : round(3.15 * RATE)],
        atol=2 / 32768,
        rtol=0,
    )
    right = SessionTimeline(saved).exact_source_span(lane, SourceSec(3.85), SourceSec(4.1))
    assert right is not None
    assert right[1] - right[0] == pytest.approx(0.25)
    np.testing.assert_allclose(
        played[round(right[0] * RATE) : round(right[1] * RATE)],
        current[round(3.85 * RATE) : round(4.1 * RATE)],
        atol=2 / 32768,
        rtol=0,
    )
    assert saved.timeline.duration_sec == pytest.approx(5.36, abs=0.06)


def test_public_selection_preserves_mixed_real_rejection_and_window_decode_evidence(
    tmp_path, monkeypatch
):
    configure(monkeypatch, defaults())
    result = project(tmp_path)
    path = tmp_path / "raw/host.wav"
    audio = room(seconds=2.4, seed=1262, db=-40)
    voice(audio, 0.7, 1, db=-20)
    write_wav(path, audio)
    result.track_by_id("host").media.duration_sec = 2.4
    real_read = room_tone.load_mono_window

    def fail_first_window(path, **kwargs):
        if kwargs["start_sec"] < 0.55:
            raise OSError("first candidate decode failed after real floor measurement")
        return real_read(path, **kwargs)

    monkeypatch.setattr(room_tone, "load_mono_window", fail_first_window)

    selected = room_tone_span(result, "host", near_sec=0, duration_sec=0.25)

    assert selected is not None
    assert getattr(selected, "cause", None) == "rejected"
    assert selected.rejected_checks == ("near_speech",)
    assert selected.unreadable_windows == 1
    monkeypatch.setattr(room_tone, "load_mono_window", real_read)
    clean = room(seconds=2.4, seed=1262)
    voice(clean, 0.7, 1)
    write_wav(path, clean)
    accepted = room_tone_span(result, "host", near_sec=0, duration_sec=0.25)
    assert accepted is not None
    assert (accepted.sample.start, accepted.sample.end) == pytest.approx((0, 0.25))
    assert accepted.sample.speech_prob is None


def test_real_seventeen_run_inventory_exposes_candidate_limit_and_clean_distant_control(
    tmp_path, monkeypatch
):
    configure(monkeypatch, defaults())
    result = project(tmp_path)
    audio = room(seconds=17, seed=1263, db=-40)
    audio[16 * RATE :] = room(seconds=1, seed=1264)
    for index in range(17):
        voice(audio, index + 0.8, index + 1, db=-20)
    write_wav(tmp_path / "raw/host.wav", audio)
    result.track_by_id("host").media.duration_sec = 17

    selected = room_tone_span(result, "host", near_sec=0, duration_sec=0.25)

    assert selected is not None
    assert getattr(selected, "cause", None) == "candidate_limit"
    assert selected.rejected_checks == ("near_speech",)
    assert selected.unreadable_windows == 0
    accepted = room_tone_span(result, "host", near_sec=16.4, duration_sec=0.25)
    assert accepted is not None
    assert (accepted.sample.start, accepted.sample.end) == pytest.approx((16.275, 16.525))
    assert accepted.sample.speech_prob is None
