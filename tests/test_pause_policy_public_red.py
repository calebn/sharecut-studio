from __future__ import annotations

import pytest

from pause_policy_public_helpers import (
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
from podcast_mcp.edits.cut_speech import CutSpeechConfirmation
from podcast_mcp.edits.pending_preview import apply_for_suggested, resolve_pending_preview
from podcast_mcp.edits.room_tone import RecordedBedSample, SampleAbsent
from podcast_mcp.edits.source_removals import CutScopeHold, inspect_source_remove
from podcast_mcp.edits.tighten import propose_tighten_edits
from podcast_mcp.edits.timeline_ops import LaneSample, LaneUnavailable, room_tone_pad
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import Clip, EditDecisionType, Transcript, load_project
from podcast_mcp.services.document import EditService
from podcast_mcp.util.coded_error import CodedError
from podcast_mcp.util.timebase import SourceSec


def _measured_original_project(tmp_path, *, guest):
    result = project(tmp_path, topology="deleted", guest=guest)
    result.transcripts[0].words[1].end = 5.4
    audio = room()
    voice(audio, 0, 0.2)
    voice(audio, 5, 5.4)
    write_wav(tmp_path / "raw/host.wav", audio)
    result.transcripts.append(
        Transcript(
            track_id="guest", words=[w.model_copy(deep=True) for w in result.transcripts[0].words]
        )
    )
    return result


@pytest.mark.parametrize("topology", ["intact", "split"])
def test_continuous_original_source_keeps_point55_without_a_pad(tmp_path, monkeypatch, topology):
    cfg = defaults()
    configure(monkeypatch, cfg)
    result = project(tmp_path, topology=topology)

    proposal = propose_tighten_edits(result, cfg, intensity="medium")

    assert len(proposal.decisions) == 1
    decision = proposal.decisions[0]
    assert (decision.start, decision.end) == pytest.approx((0.2, 4.45))
    assert decision.replace_gap_sec is None
    assert decision.scope == "session"
    assert decision.reason.startswith("pause:")
    assert SessionTimeline(result).exact_source_span("host", SourceSec(0.2), SourceSec(5)) == (
        SourceSec(0.2),
        SourceSec(5),
    )


def test_real_deleted_source_is_not_restored_by_continuous_split_arithmetic(tmp_path, monkeypatch):
    configure(monkeypatch, defaults())
    result = project(tmp_path, topology="deleted")
    crossed = pause("crossed", end=4.7)
    admissible = pause("admissible")

    assessment = inspect_source_remove(result, crossed)

    assert isinstance(assessment, CutScopeHold)
    assert (assessment.edit_id, assessment.reason) == ("crossed", "source_geometry")
    assert inspect_source_remove(result, admissible) == pytest.approx((0.2, 2))
    assert primary_spans(result) == [(0, 2, 0), (4.7, 6, 2)]


@pytest.mark.parametrize("topology", ["intact", "split"])
def test_saved_oversized_pause_contracts_to_original_air_instead_of_replacement(
    tmp_path, monkeypatch, topology
):
    configure(monkeypatch, defaults())
    result = project(tmp_path, topology=topology)
    result.edit_decisions = [pause(end=4.7)]
    ws = workspace(result)

    assert EditService(ws).approve(["pause"]) == 1

    saved = load_project(ws.path)
    assert saved.timeline.duration_sec == pytest.approx(1.75)
    assert sum(c.source_end - c.source_start for c in saved.clips) == pytest.approx(1.75)
    assert all(c.source_id is None for c in saved.clips)
    record = saved.editorial.edit_log[0]
    assert record.decision_ids == ["pause"]
    assert (record.source_start, record.source_end) == pytest.approx((0.2, 4.45))
    assert record.params["replace_gap_sec"] is None
    assert [w.text for w in saved.transcripts[0].words] == ["before", "after"]


@pytest.mark.parametrize(
    "kind,cause",
    [
        ("missing", "missing_file"),
        ("corrupt", "unreadable_file"),
        ("digital", "digital_silence"),
        ("gated", "gated_live"),
        ("rejected", "rejected"),
    ],
)
def test_original_pause_does_not_consume_an_unavailable_manual_pad_lane(
    tmp_path, monkeypatch, kind, cause
):
    configure(monkeypatch, defaults())
    result = project(tmp_path, topology="deleted", guest=kind)
    add_bed(result, tmp_path)
    planned = room_tone_pad(result, 0.2, 0.25)
    host, guest = planned.lanes
    assert isinstance(host, LaneSample)
    assert isinstance(host.selection, RecordedBedSample)
    assert host.selection.source_id == "room-tone-host"
    assert isinstance(guest, LaneUnavailable)
    assert isinstance(guest.cause, SampleAbsent)
    assert (guest.track_id, guest.cause.cause) == ("guest", cause)
    result.edit_decisions = [pause()]
    ws = workspace(result)
    service = EditService(ws)
    if kind == "missing":
        before_model = ws.project.model_dump(mode="json")
        before_files = files(tmp_path)
        with pytest.raises(CodedError) as held:
            service.approve(["pause"])
        assert held.value.code == "cut_scope_changed"
        assert ws.project.model_dump(mode="json") == before_model
        assert files(tmp_path) == before_files
        assert ws.project.editorial.edit_log == []
        return
    if kind == "rejected":
        before_model = ws.project.model_dump(mode="json")
        before_files = files(tmp_path)
        asked = service.approve(["pause"])
        assert isinstance(asked, CutSpeechConfirmation)
        assert (asked.status, asked.reason) == ("needs_confirmation", "cuts_other_speech")
        assert [track.track_id for track in asked.speech.tracks] == ["guest"]
        assert [(span.start, span.end) for span in asked.speech.tracks[0].sound_spans] == [
            pytest.approx((0.2, 1.75))
        ]
        assert ws.project.model_dump(mode="json") == before_model
        assert files(tmp_path) == before_files
        assert service.approve(["pause"], confirm_cut_speech=True) == 1
    else:
        assert service.approve(["pause"]) == 1
    saved = load_project(ws.path)
    record = saved.editorial.edit_log[0]
    assert record.decision_ids == ["pause"]
    assert (record.source_start, record.source_end) == pytest.approx((0.2, 1.75))
    assert record.params["replace_gap_sec"] is None
    assert record.params["pad_samples"] == []
    assert primary_spans(saved) == [
        pytest.approx((0, 0.2, 0)),
        pytest.approx((1.75, 2, 0.2)),
        pytest.approx((4.7, 6, 0.45)),
    ]
    assert saved.timeline.duration_sec == pytest.approx(1.75)


@pytest.mark.parametrize("kind", ["missing", "corrupt"])
def test_enabled_guards_hold_unknown_peer_audio_and_accept_repaired_original_audio(
    tmp_path, monkeypatch, kind
):
    configure(monkeypatch, defaults(acoustic=True))
    result = _measured_original_project(tmp_path, guest=kind)
    add_bed(result, tmp_path)
    result.edit_decisions = [pause()]
    ws = workspace(result)
    before_model = ws.project.model_dump(mode="json")
    before_files = files(tmp_path)
    with pytest.raises(CodedError) as held:
        EditService(ws).approve(["pause"])
    assert held.value.ids == ("pause",)
    assert held.value.code == "cut_scope_changed"
    assert (held.value.held[0].reason, held.value.held[0].detail) == ("pause_air", "no_room")
    assert ws.project.model_dump(mode="json") == before_model
    assert files(tmp_path) == before_files
    audio = room(seed=1215)
    voice(audio, 0, 0.2)
    voice(audio, 5, 5.4)
    write_wav(tmp_path / "raw/guest.wav", audio)
    assert EditService(ws).approve(["pause"]) == 1
    record = load_project(ws.path).editorial.edit_log[0]
    assert record.decision_ids == ["pause"]
    assert record.source_end == pytest.approx(1.8)
    assert record.params["replace_gap_sec"] is None
    assert record.params["pad_samples"] == []


@pytest.mark.parametrize("guest", ["quiet", "empty"])
def test_nonpause_live_lanes_filled_or_proved_unplayed_use_one_common_gap(
    tmp_path, monkeypatch, guest
):
    configure(monkeypatch, defaults())
    result = project(tmp_path, topology="deleted", guest=guest)
    add_bed(result, tmp_path)
    if guest == "quiet":
        add_bed(result, tmp_path, "guest")
    result.edit_decisions = [pause()]
    result.edit_decisions[0].reason = "filler:um"
    ws = workspace(result)

    assert EditService(ws).approve(["pause"]) == 1

    saved = load_project(ws.path)
    assert saved.timeline.duration_sec == pytest.approx(1.75)
    assert [
        (c.timeline_start, c.timeline_end) for c in saved.clips if c.source_id == "room-tone-host"
    ] == [pytest.approx((0.2, 0.45))]
    if guest == "quiet":
        assert [
            (c.timeline_start, c.timeline_end)
            for c in saved.clips
            if c.source_id == "room-tone-guest"
        ] == [pytest.approx((0.2, 0.45))]
        assert max(c.timeline_end for c in saved.clips if c.track_id == "guest") == pytest.approx(
            1.75
        )
    else:
        assert [c.track_id for c in saved.clips] == ["host", "host", "host"]
    assert saved.editorial.edit_log[0].params["replace_gap_sec"] == 0.25


@pytest.mark.parametrize("order", [("filler", "pause"), ("pause", "filler")])
def test_selected_saved_batch_with_held_pause_restores_bytes_mirrors_and_history(
    tmp_path, monkeypatch, order
):
    cfg = defaults(acoustic=True)
    cfg["tighten"].update(min_retained_solo_pause_sec=2.2, min_retained_pause_sec=2.2)
    configure(monkeypatch, cfg)
    result = _measured_original_project(tmp_path, guest="quiet")
    peer_audio = room(seed=1215)
    voice(peer_audio, 0, 0.2)
    voice(peer_audio, 5, 5.4)
    write_wav(tmp_path / "raw/guest.wav", peer_audio)
    add_bed(result, tmp_path)
    filler = pause("filler", start=5.4, end=5.6, gap=None)
    filler.reason = "filler:um"
    result.edit_decisions = [filler, pause()]
    ws = workspace(result)
    before_model = ws.project.model_dump(mode="json")
    before_files = files(tmp_path)

    with pytest.raises(CodedError) as held:
        EditService(ws).approve(list(order))

    assert held.value.ids == ("pause",)
    assert held.value.code == "cut_scope_changed"
    assert (held.value.held[0].reason, held.value.held[0].detail) == ("pause_air", "no_air")
    assert held.value.held[0].peers == ()
    assert "None of the selected edits were applied." in str(held.value)
    assert files(tmp_path) == before_files
    assert ws.project.model_dump(mode="json") == before_model
    assert [e.id for e in load_project(ws.path).edit_decisions] == ["filler", "pause"]
    cfg["tighten"].update(min_retained_solo_pause_sec=0.55, min_retained_pause_sec=0.18)
    assert EditService(ws).approve(["pause"]) == 1
    saved = load_project(ws.path)
    assert [e.id for e in saved.edit_decisions] == ["filler"]
    assert saved.editorial.edit_log[0].decision_ids == ["pause"]
    assert saved.editorial.edit_log[0].source_end == pytest.approx(1.8)
    assert saved.editorial.edit_log[0].params["replace_gap_sec"] is None


def test_automatic_keeps_valid_filler_and_same_held_pause(tmp_path, monkeypatch):
    cfg = defaults(acoustic=True)
    cfg["tighten"].update(min_retained_solo_pause_sec=2.2, min_retained_pause_sec=2.2)
    configure(monkeypatch, cfg)
    result = _measured_original_project(tmp_path, guest="quiet")
    peer_audio = room(seed=1215)
    voice(peer_audio, 0, 0.2)
    voice(peer_audio, 5, 5.4)
    write_wav(tmp_path / "raw/guest.wav", peer_audio)
    add_bed(result, tmp_path)
    filler = pause("filler", start=5.4, end=5.6, gap=None)
    filler.reason = "filler:um"
    result.edit_decisions = [pause(), filler]
    ws = workspace(result)

    assert EditService(ws).apply_auto() == 1

    saved = load_project(ws.path)
    assert [e.id for e in saved.edit_decisions] == ["pause"]
    assert [r.decision_ids for r in saved.editorial.edit_log] == [["filler"]]
    assert saved.timeline.duration_sec == pytest.approx(3.1)
    assert [w.text for w in saved.transcripts[0].words] == ["before", "after"]
    stable_files = files(tmp_path)
    assert EditService(ws).apply_auto() == 0
    assert files(tmp_path) == stable_files


def test_suggested_hold_changes_neither_snapshot_nor_canonical_saved_bytes(tmp_path, monkeypatch):
    cfg = defaults(acoustic=True)
    cfg["tighten"].update(min_retained_solo_pause_sec=2.2, min_retained_pause_sec=2.2)
    configure(monkeypatch, cfg)
    result = _measured_original_project(tmp_path, guest="quiet")
    peer_audio = room(seed=1215)
    voice(peer_audio, 0, 0.2)
    voice(peer_audio, 5, 5.4)
    write_wav(tmp_path / "raw/guest.wav", peer_audio)
    add_bed(result, tmp_path)
    result.edit_decisions = [pause()]
    ws = workspace(result)
    snapshot = ws.project.model_copy(deep=True)
    before_model = snapshot.model_dump(mode="json")
    before_files = files(tmp_path)

    with pytest.raises(CodedError) as held:
        apply_for_suggested(snapshot, resolve_pending_preview(snapshot, "pause"))

    assert held.value.ids == ("pause",)
    assert held.value.code == "cut_scope_changed"
    assert (held.value.held[0].reason, held.value.held[0].detail) == ("pause_air", "no_air")
    assert held.value.held[0].peers == ()
    assert "Suggested preview is unavailable. The saved project is unchanged." in str(held.value)
    assert snapshot.model_dump(mode="json") == before_model
    assert files(tmp_path) == before_files
    cfg["tighten"].update(min_retained_solo_pause_sec=0.55, min_retained_pause_sec=0.18)
    apply_for_suggested(snapshot, resolve_pending_preview(snapshot, "pause"))
    assert snapshot.editorial.edit_log[0].decision_ids == ["pause"]
    assert snapshot.editorial.edit_log[0].source_end == pytest.approx(1.8)
    assert snapshot.editorial.edit_log[0].params["replace_gap_sec"] is None
    assert files(tmp_path) == before_files


@pytest.mark.parametrize("reason", ["filler:um", "nl:range", "pause:2.10s"])
def test_explicit_configured_silence_remains_a_real_common_gap(tmp_path, monkeypatch, reason):
    configure(monkeypatch, defaults(mode="silence"))
    result = project(tmp_path, topology="deleted", guest="gated")
    edit = pause()
    edit.reason = reason
    result.edit_decisions = [edit]
    ws = workspace(result)

    assert EditService(ws).approve(["pause"]) == 1

    saved = load_project(ws.path)
    assert saved.timeline.duration_sec == pytest.approx(1.75)
    if reason.startswith("pause:"):
        assert primary_spans(saved) == [
            pytest.approx((0, 0.2, 0)),
            pytest.approx((1.75, 2, 0.2)),
            pytest.approx((4.7, 6, 0.45)),
        ]
        assert saved.editorial.edit_log[0].params["replace_gap_sec"] is None
        assert saved.editorial.edit_log[0].params["pad_samples"] == []
    else:
        assert primary_spans(saved) == [pytest.approx((0, 0.2, 0)), pytest.approx((4.7, 6, 0.45))]
        assert saved.editorial.edit_log[0].params["replace_gap_sec"] == 0.25


def test_mute_uses_registered_room_tone_without_shortening_session(tmp_path, monkeypatch):
    configure(monkeypatch, defaults())
    result = project(tmp_path)
    add_bed(result, tmp_path)
    edit = pause(start=1, end=1.3, gap=None)
    edit.type = EditDecisionType.MUTE
    edit.reason = "filler:um"
    result.edit_decisions = [edit]
    ws = workspace(result)

    assert EditService(ws).approve(["pause"]) == 1

    saved = load_project(ws.path)
    assert saved.timeline.duration_sec == 6
    assert primary_spans(saved) == [(0, 6, 0)]
    region = saved.clips[0].mute_regions[0]
    assert region.start_s <= 1 and region.end_s >= 1.3
    assert region.fill.source_id == "room-tone-host"
    assert (region.fill.start_s, region.fill.end_s) == pytest.approx((0, 0.25))


@pytest.mark.parametrize("order", [("host", "guest"), ("guest", "host")])
def test_geometry_held_twin_cannot_suppress_the_real_clean_proposal(tmp_path, monkeypatch, order):
    cfg = defaults()
    configure(monkeypatch, cfg)
    result = project(tmp_path, guest="quiet")
    result.transcripts.append(
        Transcript(
            track_id="guest",
            words=[word.model_copy(deep=True) for word in result.transcripts[0].words],
        )
    )
    result.clips.append(
        Clip(
            id="replayed-host", track_id="host", source_start=0.2, source_end=4.45, timeline_start=9
        )
    )
    result.timeline.duration_sec = 13.25
    tracks = {track.id: track for track in result.tracks}
    result.tracks = [tracks[tid] for tid in order]

    held = inspect_source_remove(result, pause("replayed-host", end=4.45, gap=None))
    assert isinstance(held, CutScopeHold)
    assert (held.edit_id, held.reason) == ("replayed-host", "source_geometry")
    proposal = propose_tighten_edits(result, cfg, intensity="medium")

    assert [(e.track_id, e.start, e.end, e.replace_gap_sec) for e in proposal.decisions] == [
        ("guest", pytest.approx(0.2), pytest.approx(4.45), None),
    ]
    assert [e.id for e in proposal.decisions] == ["cut_pause_200_5000_84983c60f7"]
