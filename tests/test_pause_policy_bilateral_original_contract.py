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
from podcast_mcp.edits.pending_preview import apply_for_suggested, resolve_pending_preview
from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.engines.timeline_render import render_track_from_timeline
from podcast_mcp.models import ClipJoinMode, TranscriptWord, load_project
from podcast_mcp.services.document import EditService
from podcast_mcp.util.coded_error import CodedError


def _enabled(monkeypatch, mode):
    cfg = defaults(acoustic=True, mode=mode)
    cfg["tighten"].update(leave_in_if_risky=True, join_continuity_gate=True)
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


def _placed(tmp_path, *, tail=False):
    result = project(tmp_path, topology="deleted")
    audio = room(seed=1512)
    for lo, hi in ((0, 0.2), (5, 5.2), (5.4, 5.8)):
        voice(audio, lo, hi)
    if tail:
        voice(audio, 0.2, 0.45)
    write_wav(tmp_path / "raw/host.wav", audio)
    result.transcripts[0].words.append(TranscriptWord(text="reference", start=5.4, end=5.8))
    add_bed(result, tmp_path)
    result.edit_decisions = [pause("bilateral", start=0.55, end=2, gap=None)]
    return result


def _render(result, tmp_path, label):
    target = tmp_path.parent / f"{tmp_path.name}-{label}.wav"
    rendered = render_track_from_timeline(result, result.track_by_id("host"), target, {})
    return load_mono_window(
        rendered, start_sec=0, duration_sec=result.timeline.duration_sec, sample_rate=RATE
    )


def _same_raw(played, tmp_path, timeline_start, source_start, seconds):
    expected = load_mono_window(
        tmp_path / "raw/host.wav",
        start_sec=source_start,
        duration_sec=seconds,
        sample_rate=RATE,
    )
    np.testing.assert_allclose(
        played[round(timeline_start * RATE) : round((timeline_start + seconds) * RATE)],
        expected,
        atol=2 / 32768,
        rtol=0,
    )


@pytest.mark.parametrize("mode", ["room_tone", "silence"])
@pytest.mark.parametrize(
    "tail,end,duration,next_word,preview_end,left_fade,spans",
    [
        (False, 2, 1.85, 0.85, 1.05, 150, [(0, 0.55, 0), (4.7, 6, 0.55)]),
        (True, 1.8, 2.05, 1.05, 1.25, 50, [(0, 0.55, 0), (1.8, 2, 0.55), (4.7, 6, 0.75)]),
    ],
)
def test_saved_and_suggested_retain_original_bilateral_air_without_a_pad(
    tmp_path, monkeypatch, mode, tail, end, duration, next_word, preview_end, left_fade, spans
):
    _enabled(monkeypatch, mode)
    ws = workspace(_placed(tmp_path, tail=tail))
    before_files = files(tmp_path)
    before_model = ws.project.model_dump(mode="json")
    snapshot = ws.project.model_copy(deep=True)

    assert apply_for_suggested(snapshot, resolve_pending_preview(snapshot, "bilateral")) == (
        pytest.approx(preview_end)
    )
    assert files(tmp_path) == before_files
    assert ws.project.model_dump(mode="json") == before_model
    assert [(e.id, e.applied) for e in load_project(ws.path).edit_decisions] == [
        ("bilateral", False)
    ]
    assert EditService(ws).approve(["bilateral"]) == 1
    saved = load_project(ws.path)

    for edited in (snapshot, saved):
        assert edited.edit_decisions == []
        assert len(edited.editorial.edit_log) == 1
        record = edited.editorial.edit_log[0]
        assert record.decision_ids == ["bilateral"]
        assert (record.source_start, record.source_end) == pytest.approx((0.55, end))
        assert (record.timeline_start, record.timeline_end) == pytest.approx((0.55, end))
        assert record.params["scope"] == "session"
        assert record.params["replace_gap_sec"] is None
        assert record.params["pad_samples"] == []
        assert record.params["loss_sec"] == pytest.approx(end - 0.55)
        assert record.params["crossfade_ms"] == 150
        assert edited.timeline.duration_sec == pytest.approx(duration)
        assert primary_spans(edited) == [pytest.approx(span) for span in spans]
        assert len(edited.clips) == len(spans)
        assert [c.source_id for c in edited.clips] == [None] * len(spans)
        fades = record.params["edge_fades"]
        assert [(f["track_id"], f["source_id"], f["side"]) for f in fades] == [
            ("host", None, "left"),
            ("host", None, "right"),
        ]
        assert [
            (f["source_start"], f["source_end"], f["timeline_sec"], f["milliseconds"])
            for f in fades
        ] == [
            pytest.approx((0.55 - left_fade / 1000, 0.55, 0.55, left_fade)),
            pytest.approx((end if tail else 4.7, (end if tail else 4.7) + 0.15, 0.55, 150)),
        ]
        first, second = sorted(edited.clips, key=lambda c: c.timeline_start)[:2]
        assert (first.fade_out_ms, second.fade_in_ms) == (left_fade, 150)
        assert first.join_in_mode == second.join_in_mode == ClipJoinMode.FADE
        assert [(w.text, w.start, w.end) for w in edited.transcripts[0].words] == [
            ("before", 0, 0.2),
            ("after", 5, 5.2),
            ("reference", 5.4, 5.8),
        ]

    suggested_pcm = _render(snapshot, tmp_path, "suggested")
    saved_pcm = _render(saved, tmp_path, "saved")
    np.testing.assert_array_equal(saved_pcm, suggested_pcm)
    assert saved_pcm.size == round(duration * RATE)
    _same_raw(saved_pcm, tmp_path, 0, 0, 0.2)
    _same_raw(saved_pcm, tmp_path, next_word, 5, 0.2)
    _same_raw(saved_pcm, tmp_path, next_word + 0.4, 5.4, 0.4)
    _same_raw(saved_pcm, tmp_path, next_word - 0.1, 4.9, 0.09)
    if tail:
        _same_raw(saved_pcm, tmp_path, 0.3, 0.3, 0.15)
        _same_raw(saved_pcm, tmp_path, 0.71, 1.96, 0.03)
    else:
        _same_raw(saved_pcm, tmp_path, 0.25, 0.25, 0.14)
    assert files(tmp_path)["raw/host.wav"] == before_files["raw/host.wav"]
    stable_files = files(tmp_path)
    assert EditService(ws).apply_auto() == 0
    assert files(tmp_path) == stable_files


@pytest.mark.parametrize("mode", ["room_tone", "silence"])
@pytest.mark.parametrize(
    "unavailable", [False, True], ids=["insufficient-original", "missing-audio"]
)
def test_original_only_hold_preserves_saved_bytes_and_pending_preview_state(
    tmp_path, monkeypatch, mode, unavailable
):
    cfg = _enabled(monkeypatch, mode)
    if not unavailable:
        cfg["tighten"].update(min_retained_solo_pause_sec=2.2, min_retained_pause_sec=2.2)
    ws = workspace(_placed(tmp_path))
    if unavailable:
        (tmp_path / "raw/host.wav").unlink()
    before_files = files(tmp_path)
    before_model = ws.project.model_dump(mode="json")
    snapshot = ws.project.model_copy(deep=True)

    with pytest.raises(CodedError) as suggested_hold:
        apply_for_suggested(snapshot, resolve_pending_preview(snapshot, "bilateral"))
    assert [h.edit_id for h in suggested_hold.value.held] == ["bilateral"]
    assert snapshot.model_dump(mode="json") == before_model
    assert files(tmp_path) == before_files
    with pytest.raises(CodedError) as saved_hold:
        EditService(ws).approve(["bilateral"])
    assert [h.edit_id for h in saved_hold.value.held] == ["bilateral"]
    assert ws.project.model_dump(mode="json") == before_model
    assert files(tmp_path) == before_files
    persisted = load_project(ws.path)
    assert [(e.id, e.start, e.end, e.applied) for e in persisted.edit_decisions] == [
        ("bilateral", 0.55, 2, False)
    ]
    assert primary_spans(persisted) == [(0, 2, 0), (4.7, 6, 2)]
    assert persisted.timeline.duration_sec == pytest.approx(3.3)
    assert persisted.editorial.edit_log == []
    assert EditService(ws).apply_auto() == 0
    assert files(tmp_path) == before_files
    assert ws.project.model_dump(mode="json") == before_model
