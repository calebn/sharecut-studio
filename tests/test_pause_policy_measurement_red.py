from __future__ import annotations

import numpy as np
import pytest

from pause_policy_public_helpers import (
    add_bed,
    configure,
    defaults,
    pause,
    project,
    room,
    voice,
    workspace,
    write_wav,
)
from podcast_mcp.edits import room_tone
from podcast_mcp.edits.room_tone import room_tone_span
from podcast_mcp.edits.timeline_ops import fill_with_room_tone, insert_room_tone_pad
from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.engines.timeline_render import render_track_from_timeline
from podcast_mcp.models import Clip, load_project
from podcast_mcp.services.document import EditService


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
def test_real_pcm_availability_failures_keep_distinct_selection_causes(
    tmp_path, monkeypatch, kind, cause
):
    configure(monkeypatch, defaults())
    result = project(tmp_path, guest=kind)

    selected = room_tone_span(result, "guest", near_sec=2, duration_sec=0.25)

    assert selected is not None, f"measurement erased {cause}"
    assert getattr(selected, "cause", None) == cause
    positive = room_tone_span(result, "host", near_sec=2, duration_sec=0.25)
    assert positive is not None
    assert type(positive) is not type(selected)


@pytest.mark.parametrize("metadata,cause", [("track", "missing_track"), ("media", "missing_media")])
def test_absent_track_or_metadata_is_not_a_measured_gate(tmp_path, monkeypatch, metadata, cause):
    configure(monkeypatch, defaults())
    result = project(tmp_path)
    if metadata == "track":
        tid = "absent"
    else:
        tid = "host"
        result.track_by_id(tid).media = None

    selected = room_tone_span(result, tid, near_sec=2, duration_sec=0.25)

    assert selected is not None, f"measurement erased {cause}"
    assert getattr(selected, "cause", None) == cause


def test_pending_exclusions_are_reported_without_authorizing_source_replay(tmp_path, monkeypatch):
    configure(monkeypatch, defaults())
    result = project(tmp_path)

    selected = room_tone_span(result, "host", near_sec=2, duration_sec=0.25, avoid=[(0, 6)])

    assert selected is not None, "measurement erased exhausted exclusions"
    assert getattr(selected, "cause", None) == "excluded"
    positive = room_tone_span(result, "host", near_sec=2, duration_sec=0.25)
    assert positive is not None
    assert type(positive) is not type(selected)


@pytest.mark.parametrize(
    "failure", ["candidate_limit", "window_unreadable", "too_short", "no_quiet_run"]
)
def test_finite_sample_inventory_reports_what_was_actually_tried(tmp_path, monkeypatch, failure):
    configure(monkeypatch, defaults())
    result = project(tmp_path)
    path = tmp_path / "raw" / "host.wav"
    if failure == "candidate_limit":
        audio = room(seconds=17)
        for i in range(17):
            voice(audio, i + 0.8, i + 1)
        probabilities = iter([1.0] * 16 + [0.0])

        class CandidateVad:
            def speech_probs(self, _audio):
                return np.array([next(probabilities)])

        monkeypatch.setattr("podcast_mcp.engines.vad_silero.get_shared_vad", lambda: CandidateVad())
    elif failure == "window_unreadable":
        audio = room()
    elif failure == "too_short":
        audio = room(seconds=2)
        for start in (0, 0.6, 1.2, 1.8):
            voice(audio, start, start + 0.2)
    else:
        audio = room(seconds=2)
        for start in (0, 0.4, 0.8, 1.2, 1.6):
            voice(audio, start, start + 0.3)
    write_wav(path, audio)
    if failure == "window_unreadable":

        def read(_path, **_kwargs):
            raise OSError("candidate window decode failed after complete floor measurement")

        monkeypatch.setattr(room_tone, "load_mono_window", read)

    selected = room_tone_span(result, "host", near_sec=0, duration_sec=0.25)

    assert selected is not None, f"measurement erased {failure}"
    assert getattr(selected, "cause", None) == failure
    if failure == "candidate_limit":
        assert selected.rejected_checks == ("voiced",)
        accepted = room_tone_span(result, "host", near_sec=16.4, duration_sec=0.25)
        assert accepted is not None
        assert type(accepted) is not type(selected)


def test_nonpause_selected_bed_is_consumed_once_and_tiles_with_literal_outer_fades(
    tmp_path, monkeypatch
):
    cfg = defaults()
    cfg["tighten"]["min_retained_solo_pause_sec"] = 0.9
    configure(monkeypatch, cfg)
    result = project(tmp_path, topology="deleted")
    add_bed(result, tmp_path)
    original = room_tone.load_mono_window
    measurements = []

    def measure(path, **kwargs):
        measurements.append(path)
        if len(measurements) > 1:
            raise OSError("second picker cannot read a changed candidate")
        return original(path, **kwargs)

    monkeypatch.setattr(room_tone, "load_mono_window", measure)
    result.edit_decisions = [pause(gap=0.6)]
    result.edit_decisions[0].reason = "nl:range"
    ws = workspace(result)

    assert EditService(ws).approve(["pause"]) == 1
    assert len(measurements) == 1

    saved = load_project(ws.path)
    pads = sorted(
        (c for c in saved.clips if c.source_id == "room-tone-host"), key=lambda c: c.timeline_start
    )
    assert [(c.timeline_start, c.source_start, c.source_end) for c in pads] == [
        pytest.approx((0.2, 0, 0.25)),
        pytest.approx((0.45, 0, 0.25)),
        pytest.approx((0.7, 0, 0.1)),
    ]
    assert [(c.fade_in_ms, c.fade_out_ms) for c in pads] == [(10, 0), (0, 0), (0, 10)]
    assert saved.timeline.duration_sec == pytest.approx(2.1)
    assert saved.editorial.edit_log[0].params["replace_gap_sec"] == 0.6


def test_real_own_sample_tiles_point25_point25_point10_with_only_outer_fades(tmp_path, monkeypatch):
    configure(monkeypatch, defaults())
    result = project(tmp_path)
    result.clips = [
        Clip(id="left", track_id="host", source_start=0, source_end=1, timeline_start=0),
        Clip(id="right", track_id="host", source_start=2, source_end=6, timeline_start=1),
    ]

    insert_room_tone_pad(result, 1, 0.6, sample_duration_sec=0.25)

    pads = sorted(
        (c for c in result.clips if c.id not in {"left", "right"}), key=lambda c: c.timeline_start
    )
    assert [(c.timeline_start, c.source_start, c.source_end) for c in pads] == [
        pytest.approx((1, 0.875, 1.125)),
        pytest.approx((1.25, 0.875, 1.125)),
        pytest.approx((1.5, 0.875, 0.975)),
    ]
    assert [(c.fade_in_ms, c.fade_out_ms) for c in pads] == [(10, 0), (0, 0), (0, 10)]
    assert result.timeline.duration_sec == pytest.approx(5.6)


def test_actual_render_plays_the_bound_own_sample_inside_each_literal_tile(tmp_path, monkeypatch):
    configure(monkeypatch, defaults())
    result = project(tmp_path)
    result.clips = [
        Clip(id="left", track_id="host", source_start=0, source_end=1, timeline_start=0),
        Clip(id="right", track_id="host", source_start=2, source_end=6, timeline_start=1),
    ]
    insert_room_tone_pad(result, 1, 0.6, sample_duration_sec=0.25)

    rendered = render_track_from_timeline(
        result, result.track_by_id("host"), tmp_path / "bound.wav", {}
    )

    for at, seconds in ((1.02, 0.21), (1.27, 0.21), (1.52, 0.06)):
        played = load_mono_window(rendered, start_sec=at, duration_sec=seconds, sample_rate=16000)
        expected = load_mono_window(
            tmp_path / "raw" / "host.wav", start_sec=0.895, duration_sec=seconds, sample_rate=16000
        )
        np.testing.assert_allclose(played, expected, atol=2 / 32768, rtol=0)
    pad = load_mono_window(rendered, start_sec=1, duration_sec=0.6, sample_rate=16000)
    assert pad.size == 9600
    assert np.sqrt(np.mean(pad**2)) == pytest.approx(10 ** (-70 / 20), abs=0.00004)


def test_unreadable_registered_render_source_falls_back_to_actual_own_air(tmp_path, monkeypatch):
    configure(monkeypatch, defaults())
    result = project(tmp_path)
    add_bed(result, tmp_path)
    result.source_by_id("room-tone-host").path = "raw/not-the-measured-bed.wav"
    result.clips = [
        Clip(id="left", track_id="host", source_start=0, source_end=1, timeline_start=0),
        Clip(id="right", track_id="host", source_start=2, source_end=6, timeline_start=1),
    ]

    insert_room_tone_pad(result, 1, 0.3)

    pads = [c for c in result.clips if c.id not in {"left", "right"}]
    assert len(pads) == 1
    assert (pads[0].timeline_start, pads[0].timeline_end) == pytest.approx((1, 1.3))
    assert pads[0].source_id is None
    assert (pads[0].fade_in_ms, pads[0].fade_out_ms) == (10, 10)


def test_manual_gap_fill_keeps_registered_bed_tiling_and_outer_fades(tmp_path, monkeypatch):
    configure(monkeypatch, defaults())
    result = project(tmp_path)
    add_bed(result, tmp_path)
    result.clips = [
        Clip(id="left", track_id="host", source_start=0, source_end=1, timeline_start=0),
        Clip(id="right", track_id="host", source_start=2, source_end=6, timeline_start=1.6),
    ]

    fill_with_room_tone(result, "host")

    pads = sorted(
        (c for c in result.clips if c.source_id == "room-tone-host"), key=lambda c: c.timeline_start
    )
    assert [(c.timeline_start, c.source_end - c.source_start) for c in pads] == [
        pytest.approx((1, 0.25)),
        pytest.approx((1.25, 0.25)),
        pytest.approx((1.5, 0.1)),
    ]
    assert [(c.fade_in_ms, c.fade_out_ms) for c in pads] == [(10, 0), (0, 0), (0, 10)]
    assert result.timeline.duration_sec == pytest.approx(5.6)
