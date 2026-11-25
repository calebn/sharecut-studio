"""Pin the wire output and clip effects of the fade-recommendation apply calls (#1811)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from podcast_mcp.mcp.tools.timeline import apply_fade_recommendations_tool
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole, load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import AnalysisService
from podcast_mcp.services.document_sync.handlers import edits as handlers
from podcast_mcp.services.document_sync.host_submit import submit_host_command_result

pytestmark = pytest.mark.unscoped_ok

TRACKS = {
    "host": ("Host", [(0.0, 0.5, 0.0), (0.5, 1.0, 0.5), (1.0, 1.5, 1.2)]),
    "guest": ("Guest", [(0.0, 0.5, 0.0), (0.5, 1.0, 0.5)]),
    "solo": ("Solo", [(0.0, 1.0, 0.0)]),
}


def _build(project_path: Path, sample_wav: Path, tracks: dict) -> Path:
    project = load_project(project_path)
    for tid, (speaker, spans) in tracks.items():
        dest = project.workspace_path() / "raw" / f"{tid}.wav"
        dest.write_bytes(sample_wav.read_bytes())
        project.tracks.append(
            Track(
                id=tid,
                label=tid,
                role=TrackRole.DIALOGUE,
                speaker=speaker,
                media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=2.0),
            )
        )
        for index, (start, end, at) in enumerate(spans):
            project.clips.append(
                Clip(
                    id=f"{tid}-{index}",
                    track_id=tid,
                    source_start=start,
                    source_end=end,
                    timeline_start=at,
                )
            )
    save_project(project)
    return project_path


@pytest.fixture
def built(minimal_project, sample_wav) -> Path:
    return _build(minimal_project, sample_wav, TRACKS)


@pytest.fixture
def no_joins(minimal_project, sample_wav) -> Path:
    return _build(minimal_project, sample_wav, {"solo": TRACKS["solo"]})


def _as_dict(result: Any) -> dict:
    return result.model_dump(mode="json") if hasattr(result, "model_dump") else result


def _fades(path: Path) -> dict[str, tuple[int, int]]:
    return {c.id: (c.fade_in_ms, c.fade_out_ms) for c in load_project(path).clips}


def _service(path: Path) -> AnalysisService:
    return AnalysisService(ProjectWorkspace.open(path))


def _list(path: Path, recs: list[dict]) -> dict:
    return _as_dict(
        handlers.apply_fade_recommendation_list(
            ProjectWorkspace.open(path), {"recommendations": recs}
        )
    )


def _per_track(path: Path, **payload: Any) -> dict:
    return _as_dict(handlers.apply_fade_recommendations(ProjectWorkspace.open(path), payload))


def _rec(**fields: Any) -> dict:
    return {"left_clip_id": "host-0", "clip_id": "host-1", **fields}


def test_no_recommendations_wire_text(built):
    before = _fades(built)
    assert apply_fade_recommendations_tool(str(built), []) == '{\n  "applied_fade_updates": 0\n}'
    assert _fades(built) == before


def test_no_recommendations_service_and_handler(built):
    assert _as_dict(_service(built).apply_fade_recommendations([])) == {"applied_fade_updates": 0}
    assert _list(built, []) == {"applied_fade_updates": 0}


def test_pair_wire_text_and_fades(built):
    recs = [_rec(recommended_fade_in_ms=12, recommended_fade_out_ms=9)]
    text = apply_fade_recommendations_tool(str(built), recs)
    assert text == '{\n  "applied_fade_updates": 2\n}'
    fades = _fades(built)
    assert fades["host-0"] == (0, 9)
    assert fades["host-1"] == (12, 0)
    assert fades["host-2"] == (0, 0)


def test_host_command_reply_is_the_bare_dict(built):
    recs = [_rec(recommended_fade_in_ms=12, recommended_fade_out_ms=9)]
    reply = submit_host_command_result(
        str(built), "ApplyFadeRecommendationList", {"recommendations": recs}
    )
    assert reply == {"applied_fade_updates": 2}
    assert list(reply) == ["applied_fade_updates"]


def test_service_pair_returns_exact_dict(built):
    recs = [_rec(recommended_fade_in_ms=12, recommended_fade_out_ms=9)]
    result = _as_dict(_service(built).apply_fade_recommendations(recs))
    assert result == {"applied_fade_updates": 2}
    assert list(result) == ["applied_fade_updates"]


def test_left_only(built):
    recs = [{"left_clip_id": "host-0", "recommended_fade_in_ms": 12, "recommended_fade_out_ms": 9}]
    assert _list(built, recs) == {"applied_fade_updates": 1}
    fades = _fades(built)
    assert fades["host-0"] == (0, 9)
    assert fades["host-1"] == (0, 0)


def test_right_only(built):
    recs = [{"clip_id": "host-1", "recommended_fade_in_ms": 12, "recommended_fade_out_ms": 9}]
    assert _list(built, recs) == {"applied_fade_updates": 1}
    fades = _fades(built)
    assert fades["host-0"] == (0, 0)
    assert fades["host-1"] == (12, 0)


def test_both_ids_across_two_pairs(built):
    recs = [
        _rec(recommended_fade_in_ms=12, recommended_fade_out_ms=9),
        {
            "left_clip_id": "guest-0",
            "clip_id": "guest-1",
            "recommended_fade_in_ms": 7,
            "recommended_fade_out_ms": 5,
        },
    ]
    assert _list(built, recs) == {"applied_fade_updates": 4}
    fades = _fades(built)
    assert fades["host-0"] == (0, 9)
    assert fades["host-1"] == (12, 0)
    assert fades["guest-0"] == (0, 5)
    assert fades["guest-1"] == (7, 0)


def test_unknown_clip_ids_apply_nothing(built):
    before = _fades(built)
    recs = [{"left_clip_id": "nope", "clip_id": "also-nope", "recommended_fade_in_ms": 7}]
    assert _list(built, recs) == {"applied_fade_updates": 0}
    assert _fades(built) == before


def test_one_unknown_id_counts_only_the_known_side(built):
    recs = [{"left_clip_id": "nope", "clip_id": "host-1", "recommended_fade_in_ms": 7}]
    assert _list(built, recs) == {"applied_fade_updates": 1}
    assert _fades(built)["host-1"] == (7, 0)


def test_missing_fade_values_default_to_20(built):
    assert _list(built, [_rec()]) == {"applied_fade_updates": 2}
    fades = _fades(built)
    assert fades["host-0"] == (0, 20)
    assert fades["host-1"] == (20, 0)


def test_only_one_fade_key_present_defaults_the_other(built):
    assert _list(built, [_rec(recommended_fade_in_ms=5)]) == {"applied_fade_updates": 2}
    fades = _fades(built)
    assert fades["host-0"] == (0, 20)
    assert fades["host-1"] == (5, 0)


def test_fades_only_grow_but_still_count(built):
    _list(built, [_rec(recommended_fade_in_ms=30, recommended_fade_out_ms=30)])
    assert _list(built, [_rec(recommended_fade_in_ms=5, recommended_fade_out_ms=5)]) == {
        "applied_fade_updates": 2
    }
    fades = _fades(built)
    assert fades["host-0"] == (0, 30)
    assert fades["host-1"] == (30, 0)


def test_fade_is_capped_at_the_automatic_join_limit(built):
    assert _list(built, [_rec(recommended_fade_in_ms=500, recommended_fade_out_ms=500)]) == {
        "applied_fade_updates": 2
    }
    fades = _fades(built)
    assert fades["host-0"] == (0, 40)
    assert fades["host-1"] == (40, 0)


def test_per_track_with_track_id_after_recommend(built):
    recs = _service(built).recommend_fades(track_id="host")
    assert [(r["clip_id"], r["kind"]) for r in recs] == [
        ("host-1", "harsh_join"),
        ("host-2", "gap_between_clips"),
    ]
    result = _as_dict(_service(built).apply_fade_recommendations_for_track(track_id="host"))
    assert result == {"applied_fade_updates": 3, "recommendation_count": 2}
    assert list(result) == ["applied_fade_updates", "recommendation_count"]
    fades = _fades(built)
    assert fades["host-0"] == (0, 20)
    assert fades["host-1"] == (20, 0)
    assert fades["host-2"] == (20, 0)
    assert fades["guest-0"] == (0, 0)
    assert fades["guest-1"] == (0, 0)
    assert fades["solo-0"] == (0, 0)


def test_per_track_with_speaker(built):
    result = _as_dict(_service(built).apply_fade_recommendations_for_track(speaker="Guest"))
    assert result == {"applied_fade_updates": 2, "recommendation_count": 1}
    fades = _fades(built)
    assert fades["guest-0"] == (0, 20)
    assert fades["guest-1"] == (20, 0)
    assert fades["host-1"] == (0, 0)


def test_per_track_with_no_track_covers_every_dialogue_track(built):
    result = _as_dict(_service(built).apply_fade_recommendations_for_track())
    assert result == {"applied_fade_updates": 5, "recommendation_count": 3}
    fades = _fades(built)
    assert fades["host-0"] == (0, 20)
    assert fades["host-1"] == (20, 0)
    assert fades["host-2"] == (20, 0)
    assert fades["guest-0"] == (0, 20)
    assert fades["guest-1"] == (20, 0)
    assert fades["solo-0"] == (0, 0)


def test_per_track_handler_with_and_without_track_id(built):
    assert _per_track(built, track_id="guest") == {
        "applied_fade_updates": 2,
        "recommendation_count": 1,
    }
    assert _per_track(built) == {"applied_fade_updates": 3, "recommendation_count": 2}
    assert _fades(built)["host-2"] == (20, 0)


def test_per_track_host_command_reply(built):
    reply = submit_host_command_result(
        str(built), "ApplyFadeRecommendations", {"track_id": "guest"}
    )
    assert reply == {"applied_fade_updates": 2, "recommendation_count": 1}
    assert list(reply) == ["applied_fade_updates", "recommendation_count"]


def test_per_track_with_no_joins_reports_zero_recommendations(no_joins):
    before = _fades(no_joins)
    result = _as_dict(_service(no_joins).apply_fade_recommendations_for_track(track_id="solo"))
    assert result == {"applied_fade_updates": 0, "recommendation_count": 0}
    assert list(result) == ["applied_fade_updates", "recommendation_count"]
    assert _per_track(no_joins) == {"applied_fade_updates": 0, "recommendation_count": 0}
    reply = submit_host_command_result(str(no_joins), "ApplyFadeRecommendations", {})
    assert json.dumps(reply) == '{"applied_fade_updates": 0, "recommendation_count": 0}'
    assert _fades(no_joins) == before


def test_per_track_is_idempotent_once_fades_exist(built):
    _service(built).apply_fade_recommendations_for_track(track_id="guest")
    assert _service(built).recommend_fades(track_id="guest") == []
    assert _as_dict(_service(built).apply_fade_recommendations_for_track(track_id="guest")) == {
        "applied_fade_updates": 0,
        "recommendation_count": 0,
    }
