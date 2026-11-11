from __future__ import annotations

import json

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.audio_quality import apply_fade_recommendations
from podcast_mcp.edits.clip_fades import ClipFadeBaseline, ClipFadeEdit
from podcast_mcp.edits.join_modes import (
    auto_join_fade_cap_ms,
    cap_fade_ms,
    fade_joins,
    set_clip_join,
    set_clip_join_mode,
)
from podcast_mcp.edits.timeline_ops import set_clip_fade, set_clips_fade
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track, TrackRole
from podcast_mcp.models.episode import TimelineSection
from podcast_mcp.util.coded_error import CodedValueError


def _project(*, music: bool = False) -> EpisodeProject:
    p = EpisodeProject.create("join_fade", "/tmp/join_fade")
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=20.0),
        )
    ]
    if music:
        p.timeline.tracks.append(
            Track(
                id="bed",
                label="Bed",
                role=TrackRole.MUSIC,
                media=MediaAsset(path="raw/bed.wav", duration_sec=20.0),
            )
        )
    p.timeline.clips = [
        Clip(id="a", track_id="host", source_start=0.0, source_end=3.0, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=3.0, source_end=6.0, timeline_start=3.0),
    ]
    return p


def _by_id(p: EpisodeProject) -> dict[str, Clip]:
    return {c.id: c for c in p.clips}


def test_unset_default_is_omitted_from_the_dump() -> None:
    dumped = json.loads(TimelineSection().model_dump_json())
    assert "join_fade_max_ms" not in dumped
    assert (
        json.loads(TimelineSection(join_fade_max_ms=60).model_dump_json())["join_fade_max_ms"] == 60
    )
    assert "join_fade_max_ms" not in json.loads(_project().model_dump_json())["timeline"]


@pytest.mark.parametrize("bad", [-1, 201])
def test_field_refuses_values_outside_0_to_200(bad: int) -> None:
    with pytest.raises(ValueError):
        TimelineSection(join_fade_max_ms=bad)


def test_resolver_prefers_episode_then_config_then_bundled() -> None:
    p = _project()
    assert auto_join_fade_cap_ms(p, {}) == 40
    assert auto_join_fade_cap_ms(p, {"render": {"join_fade_max_ms": 25}}) == 25
    p.timeline.join_fade_max_ms = 90
    assert auto_join_fade_cap_ms(p, {"render": {"join_fade_max_ms": 25}}) == 90
    p.timeline.join_fade_max_ms = 0
    assert auto_join_fade_cap_ms(p, {}) == 0


@pytest.mark.parametrize("bad", [-5, 201, "x"])
def test_resolver_refuses_a_bad_configured_value(bad: object) -> None:
    with pytest.raises(CodedValueError) as err:
        auto_join_fade_cap_ms(_project(), {"render": {"join_fade_max_ms": bad}})
    assert err.value.code == "out_of_range"


def test_cap_fade_ms_caps_dialogue_only() -> None:
    p = _project(music=True)
    assert cap_fade_ms(p, "host", 400, {}) == 40
    assert cap_fade_ms(p, "bed", 400, {}) == 400
    p.timeline.join_fade_max_ms = 120
    assert cap_fade_ms(p, "host", 400, {}) == 120


def test_set_clip_fade_is_uncapped_for_dialogue() -> None:
    p = _project()
    summary = set_clip_fade(p, "a", 400, 400)
    assert (_by_id(p)["a"].fade_in_ms, _by_id(p)["a"].fade_out_ms) == (400, 400)
    assert summary["fade_in_ms"] == 400
    assert summary["fade_out_ms"] == 400
    assert summary["clamped"] is False


def test_set_clip_fade_reports_a_clip_bound_clamp() -> None:
    p = _project()
    summary = set_clip_fade(p, "a", 5000, 5000)
    assert (summary["fade_in_ms"], summary["fade_out_ms"]) == (3000, 0)
    assert summary["clamped"] is True
    assert _by_id(p)["a"].fade_in_ms == 3000


def test_set_clips_fade_is_uncapped_and_reports_each_clip() -> None:
    p = _project()
    summary = set_clips_fade(
        p,
        [
            ClipFadeEdit("a", 400, 250, expected=ClipFadeBaseline(0, 0)),
            ClipFadeEdit("b", 9000, 0, expected=ClipFadeBaseline(0, 0)),
        ],
    )
    clips = _by_id(p)
    assert (clips["a"].fade_in_ms, clips["a"].fade_out_ms) == (400, 250)
    assert clips["b"].fade_in_ms == 3000
    assert summary["clamped"] is True
    assert summary["fades"] == [
        {"clip_id": "a", "fade_in_ms": 400, "fade_out_ms": 250, "clamped": False},
        {"clip_id": "b", "fade_in_ms": 3000, "fade_out_ms": 0, "clamped": True},
    ]


def test_set_clip_join_is_uncapped_for_dialogue() -> None:
    p = _project()
    set_clip_join(p, "a", "b", "crossfade", length_ms=400, defaults=load_defaults())
    clips = _by_id(p)
    assert (clips["a"].fade_out_ms, clips["b"].fade_in_ms) == (400, 400)
    set_clip_join(p, "a", "b", "fade", length_ms=300, defaults=load_defaults())
    assert (clips["a"].fade_out_ms, clips["b"].fade_in_ms) == (300, 300)


def test_set_clip_join_mode_keeps_long_fades() -> None:
    p = _project()
    set_clip_fade(p, "a", 0, 400)
    set_clip_join_mode(p, "a", "fade")
    assert _by_id(p)["a"].fade_out_ms == 400


def test_fade_joins_follow_the_default_and_report_applied_values() -> None:
    p = _project()
    summary = fade_joins(p, fade_ms=100, defaults=load_defaults())
    assert summary["fade_ms"] == 40
    assert summary["requested_fade_ms"] == 100
    assert summary["cap_ms"] == 40
    p = _project()
    p.timeline.join_fade_max_ms = 90
    summary = fade_joins(p, fade_ms=100, defaults=load_defaults())
    assert (_by_id(p)["a"].fade_out_ms, _by_id(p)["b"].fade_in_ms) == (90, 90)
    assert (summary["fade_ms"], summary["cap_ms"]) == (90, 90)


def test_fade_joins_use_the_configured_default_and_the_episode_beats_it() -> None:
    cfg = {"render": {"join_fade_max_ms": 25}}
    p = _project()
    fade_joins(p, fade_ms=100, defaults=cfg)
    assert _by_id(p)["b"].fade_in_ms == 25
    p = _project()
    p.timeline.join_fade_max_ms = 60
    fade_joins(p, fade_ms=100, defaults=cfg)
    assert _by_id(p)["b"].fade_in_ms == 60


def test_fade_joins_never_shrink_a_longer_manual_fade() -> None:
    p = _project()
    set_clip_fade(p, "a", 0, 400)
    set_clip_fade(p, "b", 300, 0)
    p.timeline.join_fade_max_ms = 10
    fade_joins(p, fade_ms=100, defaults=load_defaults())
    assert (_by_id(p)["a"].fade_out_ms, _by_id(p)["b"].fade_in_ms) == (400, 300)


def test_fade_joins_dry_run_reports_the_applied_values() -> None:
    p = _project()
    summary = fade_joins(p, fade_ms=100, defaults=load_defaults(), dry_run=True)
    assert (summary["fade_ms"], summary["cap_ms"]) == (40, 40)
    assert _by_id(p)["b"].fade_in_ms == 0


def test_smooth_all_joins_follow_the_default_and_never_shrink() -> None:
    recs = [
        {
            "left_clip_id": "a",
            "clip_id": "b",
            "recommended_fade_in_ms": 80,
            "recommended_fade_out_ms": 80,
        }
    ]
    p = _project()
    apply_fade_recommendations(p, recs, defaults=load_defaults())
    assert (_by_id(p)["a"].fade_out_ms, _by_id(p)["b"].fade_in_ms) == (40, 40)
    p = _project()
    p.timeline.join_fade_max_ms = 75
    apply_fade_recommendations(p, recs, defaults=load_defaults())
    assert (_by_id(p)["a"].fade_out_ms, _by_id(p)["b"].fade_in_ms) == (75, 75)
    set_clip_fade(p, "a", 0, 300)
    p.timeline.join_fade_max_ms = 20
    apply_fade_recommendations(p, recs, defaults=load_defaults())
    assert _by_id(p)["a"].fade_out_ms == 300
    assert _by_id(p)["b"].fade_in_ms == 75


def test_approve_time_join_fades_follow_the_default_and_never_shrink() -> None:
    from podcast_mcp.edits import cut_application
    from podcast_mcp.models import EditDecision, EditDecisionType
    from podcast_mcp.util.batch_scope import batch_scope

    def write(project: EpisodeProject, ms: int) -> None:
        with batch_scope():
            cut_application._write_join_fades(
                project,
                [
                    EditDecision(
                        id="e",
                        track_id="host",
                        type=EditDecisionType.REMOVE,
                        start=1,
                        end=2,
                        crossfade_ms=ms,
                    )
                ],
                defaults=load_defaults(),
            )

    p = _project()
    p.timeline.clips = [
        Clip(id="a", track_id="host", source_start=0, source_end=1, timeline_start=0),
        Clip(id="b", track_id="host", source_start=2, source_end=3, timeline_start=1),
    ]
    p.edit_decisions = []
    write(p, 150)
    assert (_by_id(p)["a"].fade_out_ms, _by_id(p)["b"].fade_in_ms) == (40, 40)
    p.timeline.join_fade_max_ms = 120
    write(p, 150)
    assert (_by_id(p)["a"].fade_out_ms, _by_id(p)["b"].fade_in_ms) == (120, 120)
    p.timeline.join_fade_max_ms = 10
    write(p, 150)
    assert (_by_id(p)["a"].fade_out_ms, _by_id(p)["b"].fade_in_ms) == (120, 120)
