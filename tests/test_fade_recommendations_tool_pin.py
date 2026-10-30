"""apply_fade_recommendations_tool keeps its reply, effects and history shape (#1847)."""

from __future__ import annotations

import json
from pathlib import Path

from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.mcp.tools import timeline as mcp_timeline
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole, load_project, save_project


def _project_path(tmp_path: Path) -> str:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    project = load_project(Path(path))
    raw = project.workspace_path() / "raw" / "host.wav"
    raw.parent.mkdir(parents=True, exist_ok=True)
    raw.write_bytes(b"\x00" * 100)
    project.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    )
    for index, (start, end, at) in enumerate(((0.0, 3.0, 0.0), (5.0, 8.0, 3.0))):
        project.clips.append(
            Clip(
                id=f"host-{index}",
                track_id="host",
                source_start=start,
                source_end=end,
                timeline_start=at,
            )
        )
    save_project(project)
    return path


def _clips(path: str) -> dict[str, Clip]:
    return {clip.id: clip for clip in load_project(Path(path)).clips}


def _rec(**fields) -> dict:
    return {"left_clip_id": "host-0", "clip_id": "host-1", **fields}


def test_pair_applies_both_fades_and_counts_two(tmp_path):
    path = _project_path(tmp_path)
    recs = [_rec(recommended_fade_in_ms=12, recommended_fade_out_ms=9)]
    reply = json.loads(mcp_timeline.apply_fade_recommendations_tool(path, recs))
    assert reply == {"applied_fade_updates": 2}
    clips = _clips(path)
    assert clips["host-0"].fade_out_ms == 9
    assert clips["host-1"].fade_in_ms == 12


def test_missing_fade_keys_default_to_20_ms(tmp_path):
    path = _project_path(tmp_path)
    mcp_timeline.apply_fade_recommendations_tool(path, [_rec()])
    clips = _clips(path)
    assert clips["host-0"].fade_out_ms == 20
    assert clips["host-1"].fade_in_ms == 20


def test_fades_only_grow(tmp_path):
    path = _project_path(tmp_path)
    mcp_timeline.apply_fade_recommendations_tool(
        path, [_rec(recommended_fade_in_ms=30, recommended_fade_out_ms=30)]
    )
    reply = json.loads(
        mcp_timeline.apply_fade_recommendations_tool(
            path, [_rec(recommended_fade_in_ms=5, recommended_fade_out_ms=5)]
        )
    )
    assert reply == {"applied_fade_updates": 2}
    clips = _clips(path)
    assert clips["host-0"].fade_out_ms == 30
    assert clips["host-1"].fade_in_ms == 30


def test_unknown_clip_ids_are_skipped(tmp_path):
    path = _project_path(tmp_path)
    recs = [{"left_clip_id": "nope", "clip_id": "host-1", "recommended_fade_in_ms": 7}]
    reply = json.loads(mcp_timeline.apply_fade_recommendations_tool(path, recs))
    assert reply == {"applied_fade_updates": 1}
    assert _clips(path)["host-1"].fade_in_ms == 7


def test_empty_list_applies_nothing(tmp_path):
    path = _project_path(tmp_path)
    reply = json.loads(mcp_timeline.apply_fade_recommendations_tool(path, []))
    assert reply == {"applied_fade_updates": 0}


def test_history_records_before_and_after_entries(tmp_path):
    from podcast_mcp.mcp.tools.history import history_status_tool

    path = _project_path(tmp_path)
    before = json.loads(history_status_tool(path))["total"]
    mcp_timeline.apply_fade_recommendations_tool(path, [_rec(recommended_fade_in_ms=9)])
    assert json.loads(history_status_tool(path))["total"] == before + 2


def test_an_applying_run_journals_a_single_command_row(tmp_path):
    from podcast_mcp.services.document_sync import DocumentSyncService

    path = _project_path(tmp_path)
    mcp_timeline.apply_fade_recommendations_tool(path, [_rec(recommended_fade_in_ms=9)])
    types = [r["type"] for r in DocumentSyncService.open(path).store.commands_after(0)]
    assert types == ["ApplyFadeRecommendationList"]


def test_the_registered_tool_journals_a_single_command_row(tmp_path):
    import asyncio

    from mcp.client import Client

    from podcast_mcp.services.document_sync import DocumentSyncService

    path = _project_path(tmp_path)

    async def call():
        async with Client(mcp_server.mcp) as client:
            return await client.call_tool(
                "apply_fade_recommendations_tool",
                {"project_path": path, "recommendations": [_rec(recommended_fade_in_ms=9)]},
            )

    result = asyncio.run(call())
    assert not result.is_error
    types = [r["type"] for r in DocumentSyncService.open(path).store.commands_after(0)]
    assert types == ["ApplyFadeRecommendationList"]


def test_a_non_int_value_rolls_back_and_leaves_clips_unchanged(tmp_path):
    from podcast_mcp.services.document_sync import DocumentSyncService

    path = _project_path(tmp_path)
    before = _clips(path)
    recs = [_rec(recommended_fade_in_ms=9), _rec(recommended_fade_in_ms="loud")]
    try:
        mcp_timeline.apply_fade_recommendations_tool(path, recs)
    except Exception:
        pass
    else:
        raise AssertionError("a non-int fade value must raise")
    assert _clips(path) == before
    assert DocumentSyncService.open(path).store.commands_after(0) == []


def test_the_applying_run_records_an_other_render_invalidation(tmp_path):
    from podcast_mcp.engines.render_invalidations import invalidations_as_dicts

    path = _project_path(tmp_path)
    mcp_timeline.apply_fade_recommendations_tool(path, [_rec(recommended_fade_in_ms=9)])
    reasons = {entry["reason"] for entry in invalidations_as_dicts(load_project(Path(path)))}
    assert reasons == {"other"}


def test_the_command_is_for_the_host_and_editors_only():
    import pytest

    from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role
    from podcast_mcp.services.document_sync.capabilities import authorize_document_command

    authorize_document_command(None, "ApplyFadeRecommendationList")
    authorize_document_command(
        capabilities_for_role("editor", with_mcp=True), "ApplyFadeRecommendationList"
    )
    for role in ("viewer", "commenter"):
        with pytest.raises(PermissionError) as raised:
            authorize_document_command(
                capabilities_for_role(role, with_mcp=True), "ApplyFadeRecommendationList"
            )
        assert raised.value.code == "share_capability_required"


def test_the_payload_requires_the_list():
    import pytest

    from podcast_mcp.services.document_sync.payloads import validate_payload

    validate_payload("ApplyFadeRecommendationList", {"recommendations": []})
    with pytest.raises(ValueError):
        validate_payload("ApplyFadeRecommendationList", {})


def test_recommendation_list_is_bounded():
    import pytest
    from pydantic import ValidationError

    from podcast_mcp.services.document_sync.payloads import (
        FADE_RECOMMENDATIONS_MAX,
        ApplyFadeRecommendationListPayload,
    )

    ApplyFadeRecommendationListPayload(recommendations=[{}] * FADE_RECOMMENDATIONS_MAX)
    with pytest.raises(ValidationError):
        ApplyFadeRecommendationListPayload(recommendations=[{}] * (FADE_RECOMMENDATIONS_MAX + 1))
