"""Readers that took one shift for a whole clip now follow a timing map piece by piece (#2956)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits import conversation_align
from podcast_mcp.edits.audition_context import build_audition_context
from podcast_mcp.edits.verdict_cache import _heard
from podcast_mcp.engines.bleed_gate import gate_scope_for_window
from podcast_mcp.models import Clip
from podcast_mcp.util.coded_error import CodedValueError
from test_audition_context import _two_track_project
from test_timed_clip_consumers import _clip, _project

_PIECES = [(10, 20, 100), (20, 30, 112), (31, 40, 122)]


def _plain(src_a: float, src_b: float, tl_a: float, index: int) -> Clip:
    return Clip(
        id=f"p{index}",
        track_id="host",
        source_id="src",
        source_start=src_a,
        source_end=src_b,
        timeline_start=tl_a,
    )


def test_the_heard_key_of_an_untimed_clip_is_unchanged() -> None:
    clip = Clip(
        id="a", track_id="host", source_id="s", source_start=10, source_end=40, timeline_start=100
    )
    assert _heard(clip, 90, 120) == [
        "host",
        "s",
        90.0,
        10.0,
        30.0,
        100.0,
        120,
        0,
        None,
        "fade",
        [],
        [],
        None,
    ]


def test_two_step_maps_with_the_same_window_hear_differently() -> None:
    first = _clip(source_id="s")
    second = _clip(source_id="s", timing={"steps": [{"at": 20, "delta_sec": 3}]})
    assert _heard(first, 90, 140) != _heard(second, 90, 140)
    assert _heard(first, 90, 140) != _heard(_clip(source_id="s", timing=None), 90, 140)


def test_audition_alignment_reads_the_shift_at_the_first_clips_source_start(
    minimal_project, sample_wav, tmp_workspace
) -> None:
    project = _two_track_project(minimal_project, sample_wav, tmp_workspace)
    host = next(c for c in project.clips if c.id == "c_host")
    host.timing = Clip.model_validate(
        {
            "id": "t",
            "track_id": "host",
            "source_start": 10,
            "source_end": 40,
            "timeline_start": 0,
            "timing": {"steps": [{"at": 20, "delta_sec": 2}]},
        }
    ).timing
    ctx = build_audition_context(project, 2.0, 6.0, defaults=load_defaults())
    assert ctx["clip_skew"]["any_skewed"] is False


def test_a_gate_scope_window_over_a_timed_clip_equals_the_same_pieces_untimed() -> None:
    timed = _project(_clip(source_id="src"))
    plain = _project(*[_plain(*piece, i) for i, piece in enumerate(_PIECES)])
    for window in [(105.0, 125.0), (100.0, 133.0), (113.0, 118.0), (111.0, 123.0)]:
        expected = gate_scope_for_window(plain, "host", *window)
        assert gate_scope_for_window(timed, "host", *window) == expected
    scopes = gate_scope_for_window(timed, "host", 105.0, 125.0)
    assert [(s.start_s, s.end_s) for s in scopes] == [(15.0, 30.0), (31.0, 34.0)]


def test_alignment_refuses_a_timed_clip_once_at_entry(monkeypatch: pytest.MonkeyPatch) -> None:
    timed = _clip()
    plain = Clip(id="b", track_id="guest", source_start=0, source_end=10, timeline_start=0)
    monkeypatch.setattr(
        conversation_align,
        "dialogue_align_units",
        lambda _p: [(SimpleNamespace(id="host"), timed, [], 30.0)],
    )
    with pytest.raises(CodedValueError) as err:
        conversation_align.plan_conversation_alignment(_project(timed), defaults=load_defaults())
    assert err.value.code == "timing_map_alignment_unsupported"
    monkeypatch.setattr(
        conversation_align,
        "dialogue_align_units",
        lambda _p: [(SimpleNamespace(id="guest"), plain, [], 10.0)],
    )
    result = conversation_align.plan_conversation_alignment(
        _project(plain), defaults=load_defaults()
    )
    assert result.skipped_reason == "skipped (<2 dialogue clips)"
