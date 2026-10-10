from __future__ import annotations

import json
import math

import pytest

from pause_policy_public_helpers import (
    add_bed,
    add_guest,
    configure,
    defaults,
    pause,
    primary_spans,
    project,
    workspace,
)
from podcast_mcp.edits.edit_log import archive_timeline_op
from podcast_mcp.edits.fillers import _CutRejected, _original_pause_support
from podcast_mcp.edits.session_air import GeometricPause
from podcast_mcp.models import Clip, SourceRecording, load_project
from podcast_mcp.services.document import EditService


def _deny_registry(monkeypatch):
    def unavailable():
        raise AssertionError("Internal pause identity reached the public secret registry")

    monkeypatch.setattr("podcast_mcp.edits.share_registry.get_share_registry", unavailable)


def _assert_private_archive(result, tmp_path):
    serialized = json.dumps(
        [record.model_dump(mode="json") for record in result.editorial.edit_log]
    )
    assert "recording_key" not in serialized
    assert "raw/host.wav" not in serialized
    assert str(tmp_path) not in serialized
    assert '"media"' not in serialized


@pytest.mark.parametrize("bed", [False, True])
def test_manual_fill_archives_actual_tiles_once_and_empty_refill_adds_no_record(
    tmp_path, monkeypatch, bed
):
    configure(monkeypatch, defaults())
    _deny_registry(monkeypatch)
    result = project(tmp_path)
    result.clips = [
        Clip(id="left", track_id="host", source_start=0, source_end=0.3, timeline_start=0),
        Clip(id="right", track_id="host", source_start=4.7, source_end=6, timeline_start=0.65),
    ]
    if bed:
        add_bed(result, tmp_path)
    ws = workspace(result)
    summary = EditService(ws).fill_room_tone(track_id="host")
    saved = load_project(ws.path)
    inserted = sorted(
        (clip for clip in saved.clips if clip.id not in {"left", "right"}),
        key=lambda clip: clip.timeline_start,
    )
    assert [(clip.timeline_start, clip.timeline_end) for clip in inserted] == [
        pytest.approx((0.3, 0.55)),
        pytest.approx((0.55, 0.65)),
    ]
    expected = [
        {
            "track_id": "host",
            "source_id": "room-tone-host" if bed else None,
            "source_start": pytest.approx(0 if bed else 0.35),
            "source_end": pytest.approx(0.25 if bed else 0.6),
        },
        {
            "track_id": "host",
            "source_id": "room-tone-host" if bed else None,
            "source_start": pytest.approx(0 if bed else 0.35),
            "source_end": pytest.approx(0.1 if bed else 0.45),
        },
    ]
    assert summary["pad_samples"] == expected
    assert len(saved.editorial.edit_log) == 1
    record = saved.editorial.edit_log[0]
    assert record.operation == "fill_with_room_tone"
    assert record.params["pad_samples"] == expected
    assert record.params["pad_samples"] == [
        {
            "track_id": clip.track_id,
            "source_id": clip.source_id,
            "source_start": clip.source_start,
            "source_end": clip.source_end,
        }
        for clip in inserted
    ]
    if not bed:
        support = _support(saved)
        assert not isinstance(support, _CutRejected)
        assert support.seconds == pytest.approx(0.4)
        history_free = saved.model_copy(deep=True)
        history_free.editorial.edit_log = []
        control = _support(history_free)
        assert not isinstance(control, _CutRejected)
        assert control.seconds == pytest.approx(0.55)
    _assert_private_archive(saved, tmp_path)
    second = EditService(ws).fill_room_tone(track_id="host")
    assert second["pad_samples"] == []
    assert len(load_project(ws.path).editorial.edit_log) == 1


def test_nonpause_replacement_reports_actual_tiles_in_one_outer_decision_record(
    tmp_path, monkeypatch
):
    configure(monkeypatch, defaults())
    _deny_registry(monkeypatch)
    result = project(tmp_path)
    add_bed(result, tmp_path)
    edit = pause("manual-filler", start=0.3, end=4.7, gap=0.35)
    edit.reason = "filler:um"
    result.edit_decisions = [edit]
    ws = workspace(result)
    assert EditService(ws).approve([edit.id]) == 1
    saved = load_project(ws.path)
    assert saved.edit_decisions == []
    assert len(saved.editorial.edit_log) == 1
    record = saved.editorial.edit_log[0]
    assert record.operation == "approve_edits"
    assert record.decision_ids == ["manual-filler"]
    assert record.params["replace_gap_sec"] == 0.35
    assert record.params["pad_samples"] == [
        {"track_id": "host", "source_id": "room-tone-host", "source_start": 0, "source_end": 0.25},
        {
            "track_id": "host",
            "source_id": "room-tone-host",
            "source_start": 0,
            "source_end": pytest.approx(0.1),
        },
    ]
    assert primary_spans(saved) == [
        pytest.approx((0, 0.3, 0)),
        pytest.approx((4.7, 6, 0.65)),
    ]
    _assert_private_archive(saved, tmp_path)


def _sampled_original_deleted(tmp_path):
    result = project(tmp_path)
    result.clips = [
        Clip(id="left", track_id="host", source_start=0, source_end=0.3, timeline_start=0),
        Clip(id="sample-a", track_id="host", source_start=2, source_end=2.1, timeline_start=0.3),
        Clip(id="sample-b", track_id="host", source_start=2.1, source_end=2.25, timeline_start=0.4),
        Clip(id="right", track_id="host", source_start=4.7, source_end=6, timeline_start=0.55),
    ]
    result.timeline.duration_sec = 1.85
    return result


def _support(result):
    return _original_pause_support(
        result, "host", tuple(result.transcripts[0].words), GeometricPause(())
    )


def test_deleted_original_sample_is_excluded_after_split_and_move_with_alias_receipt(
    tmp_path, monkeypatch
):
    _deny_registry(monkeypatch)
    result = _sampled_original_deleted(tmp_path)
    genuine = _support(result)
    assert not isinstance(genuine, _CutRejected)
    assert genuine.seconds == pytest.approx(0.65)
    result.sources.append(SourceRecording(id="same-media", path="raw/host.wav", duration_sec=6))
    archive_timeline_op(
        result,
        operation="fill_with_room_tone",
        track_ids=["host"],
        params={
            "pad_samples": [
                {
                    "track_id": "host",
                    "source_id": "same-media",
                    "source_start": 2,
                    "source_end": 2.25,
                }
            ]
        },
    )
    support = _support(result)
    assert not isinstance(support, _CutRejected)
    assert support.seconds == pytest.approx(0.4)
    assert [(float(piece.source_start), float(piece.source_end)) for piece in support.pieces] == [
        pytest.approx((0.2, 0.3)),
        pytest.approx((4.7, 5)),
    ]
    _assert_private_archive(result, tmp_path)


@pytest.mark.parametrize(
    "receipt",
    [
        {"recording_key": "rec_unresolvable", "source_start": 2, "source_end": 2.25},
        {"track_id": "host", "source_start": 2, "source_end": 2.25},
        {"track_id": "host", "source_id": "missing", "source_start": 2, "source_end": 2.25},
        {"track_id": "host", "source_id": None, "source_start": 2, "source_end": float("nan")},
        {"track_id": "host", "source_id": None, "source_start": 2.25, "source_end": 2},
        "invalid",
    ],
)
def test_indicated_unresolved_or_malformed_sample_holds_instead_of_crediting_air(tmp_path, receipt):
    result = _sampled_original_deleted(tmp_path)
    genuine = _support(result)
    assert not isinstance(genuine, _CutRejected)
    assert genuine.seconds == pytest.approx(0.65)
    archive_timeline_op(
        result,
        operation="fill_with_room_tone",
        track_ids=["host"],
        params={"pad_samples": [receipt]},
    )
    assert isinstance(_support(result), _CutRejected)


def test_known_pad_without_receipt_holds_but_unrelated_nonpad_record_keeps_original_credit(
    tmp_path,
):
    result = _sampled_original_deleted(tmp_path)
    archive_timeline_op(result, operation="move_clips", track_ids=["host"], params={})
    genuine = _support(result)
    assert not isinstance(genuine, _CutRejected)
    assert genuine.seconds == pytest.approx(0.65)
    archive_timeline_op(result, operation="fill_with_room_tone", track_ids=["host"], params={})
    assert isinstance(_support(result), _CutRejected)


def test_saved_pause_uses_private_identity_and_archives_only_finite_effect_geometry(
    tmp_path, monkeypatch
):
    configure(monkeypatch, defaults())
    _deny_registry(monkeypatch)
    result = project(tmp_path)
    result.edit_decisions = [pause("saved", start=0.3, end=4.7, gap=None)]
    ws = workspace(result)
    assert EditService(ws).approve(["saved"]) == 1
    saved = load_project(ws.path)
    assert len(saved.editorial.edit_log) == 1
    record = saved.editorial.edit_log[0]
    assert (record.source_start, record.source_end) == pytest.approx((0.3, 4.45))
    assert record.params["pad_samples"] == []
    assert [
        (edge["track_id"], edge["source_id"], edge["side"]) for edge in record.params["edge_fades"]
    ] == [
        ("host", None, "left"),
        ("host", None, "right"),
    ]
    for edge in record.params["edge_fades"]:
        assert all(
            math.isfinite(edge[key])
            for key in ("source_sec", "timeline_sec", "source_start", "source_end")
        )
        assert 0 < edge["milliseconds"] <= 150
        assert edge["source_end"] - edge["source_start"] == pytest.approx(
            edge["milliseconds"] / 1000
        )
    _assert_private_archive(saved, tmp_path)


def test_missing_pad_receipt_cannot_prove_disjointness_from_foreign_primary_media(tmp_path):
    result = _sampled_original_deleted(tmp_path)
    add_guest(result, tmp_path, "quiet")
    control = _support(result)
    assert not isinstance(control, _CutRejected)
    assert control.seconds == pytest.approx(0.65)
    archive_timeline_op(result, operation="fill_with_room_tone", track_ids=["guest"], params={})
    assert isinstance(_support(result), _CutRejected)
