"""The guest edit impact and social clip twins: an Editor reads what the host reads."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from guest_helpers import call_tool, mcp_ok
from podcast_mcp.edits import edit_impact_report
from podcast_mcp.gui.schemas import GuestEditImpactRequest, GuestRequest, GuestSocialClipsRequest
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import (
    AppliedEditRecord,
    Clip,
    EditDecision,
    SocialClipCandidate,
    Track,
    TrackRole,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.guest_insight_ops import GUEST_LIST_MAX, WITHHELD
from podcast_mcp.services.collaboration.guest_routes import GUEST_OWNER_ROUTES
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role
from podcast_mcp.services.remote_mcp.allowlist import EDITOR_INSIGHT_TOOLS
from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc
from podcast_mcp.services.remote_mcp.tools import list_tool_defs
from podcast_mcp.util.coded_error import guest_message_for_code

CODE = "x-sharecut-error-code"
PLANTED = "/opt/host/exports/clip.mp4"
IMPACT = "/api/review/{token}/daw/edit-impact"
CLIPS = "/api/review/{token}/daw/social-clips"
TOOLS = {"edit_impact": "guest_edit_impact", "social_clips": "guest_social_clips"}


@pytest.fixture
def world(minimal_project, sample_wav, tmp_workspace):
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.tracks = [
        Track(
            id="room",
            label="Room",
            role=TrackRole.DIALOGUE,
        )
    ]
    ws.project.clips = [
        Clip(id="clip_room", track_id="room", source_start=0.0, source_end=10.0, timeline_start=0.0)
    ]
    ws.project.edit_decisions = [
        EditDecision(id="cut1", track_id="room", start=1.0, end=3.5, reason="filler:um"),
        EditDecision(
            id="cut2",
            track_id="room",
            start=5.0,
            end=6.0,
            reason="pause:1.00s",
            applied=False,
            review_required=True,
        ),
        EditDecision(
            id="cut3",
            track_id="room",
            start=7.0,
            end=7.5,
            reason=f"cut for {PLANTED}",
            author="share:abc",
        ),
    ]
    ws.project.editorial.edit_log = [
        AppliedEditRecord(
            id="log1",
            applied_at="2026-01-01T00:00:00Z",
            operation="ripple_delete",
            track_ids=["room"],
            timeline_start=8.0,
            timeline_end=8.5,
            reason="ripple",
        ),
        AppliedEditRecord(
            id="log2",
            applied_at="2026-01-01T00:00:01Z",
            operation="approve_edits",
            track_ids=["room", "other"],
            timeline_start=9.0,
            timeline_end=9.2,
            reason=f"approved {PLANTED}",
        ),
        AppliedEditRecord(
            id="log3",
            applied_at="2026-01-01T00:00:02Z",
            operation="approve_edits",
            track_ids=["room"],
            timeline_start=9.5,
            timeline_end=9.6,
            params={"mute": True},
        ),
        AppliedEditRecord(
            id="log4",
            applied_at="2026-01-01T00:00:03Z",
            operation="ripple_delete",
            track_ids=["/opt/host/mic"],
            timeline_start=10.0,
            timeline_end=10.1,
        ),
    ]
    ws.project.social_clip_candidates = [
        SocialClipCandidate(
            id="sc1",
            track_id="room",
            start=0.0,
            end=30.0,
            score=0.8,
            reasons=["energy", f"saved at {PLANTED}"],
            title_suggestion="A good bit",
            caption_suggestion="Listen",
            transcript_excerpt="hello there",
            speaker="Ana",
            approved=True,
            review_required=False,
            exported_path=PLANTED,
        ),
        SocialClipCandidate(
            id="sc2",
            track_id="room",
            start=40.0,
            end=60.0,
            title_suggestion=PLANTED,
            caption_suggestion=f"see {PLANTED}",
            speaker=PLANTED,
            exported_path="",
        ),
        SocialClipCandidate(id="/opt/host/sc3", track_id="/opt/host/mic", start=70.0, end=80.0),
    ]
    ws.project.artifacts_dir().mkdir(parents=True, exist_ok=True)
    (ws.project.artifacts_dir() / "premix.wav").write_bytes(sample_wav.read_bytes())
    ws.save()
    version = ReviewService(ws).publish(label="Insight")["id"]
    share = ShareService(ws)
    tokens = {
        role: share.create(
            review_version_id=version, capabilities=capabilities_for_role(role, with_mcp=True)
        )["token"]
        for role in ("viewer", "commenter", "editor")
    }
    app = create_app()
    return SimpleNamespace(client=TestClient(app), ws=ws, tokens=tokens, share=share, app=app)


def _get(world, route: str, role: str = "editor", **params):
    return world.client.get(route.format(token=world.tokens[role]), params=params)


def test_the_rows_are_read_only_editor_twins_that_need_no_opt_in() -> None:
    for name, tool in TOOLS.items():
        row = GUEST_OWNER_ROUTES[name]
        assert (row.method, row.rate_kind, row.needs_guest_render) == ("GET", "read", False)
        assert row.path.startswith("/api/review/{token}/daw/")
        assert tool in EDITOR_INSIGHT_TOOLS
    assert {GUEST_OWNER_ROUTES[n].path for n in TOOLS} == {IMPACT, CLIPS}


@pytest.mark.parametrize("role", ["viewer", "commenter"])
@pytest.mark.parametrize("path", [IMPACT, CLIPS])
def test_a_lesser_role_is_refused_over_http(world, path, role) -> None:
    res = _get(world, path, role)

    assert res.status_code == 403
    assert res.headers[CODE] == "share_capability_required"


@pytest.mark.parametrize("path", [IMPACT, CLIPS])
def test_a_revoked_link_is_not_found(world, path) -> None:
    world.share.revoke(world.tokens["editor"])

    assert _get(world, path).status_code == 404


def test_the_editor_reads_the_hosts_impact_report(world) -> None:
    host = edit_impact_report(world.ws.project)

    body = _get(world, IMPACT).json()

    # four archived edits (a cut, a two-track cut, a mute, a cut on a track named by a path)
    # beside three decisions: the report counts both sources, as the host's does.
    assert host["applied_count"] == 6 and host["pending_review_count"] == 1
    assert body["total_removed_sec"] == host["total_removed_sec"] == pytest.approx(3.8)
    assert body["applied_count"] == host["applied_count"]
    assert body["pending_review_count"] == host["pending_review_count"]
    assert body["clip_count"] == host["clip_count"]
    assert body["gap_count"] == host["gap_count"]
    assert body["timeline_duration_sec"] == host["timeline_duration_sec"]
    assert body["by_track_sec"] == {
        "room": pytest.approx(host["by_track_sec"]["room"]),
        "other": pytest.approx(0.2),
        WITHHELD: pytest.approx(0.1),
    }
    assert body["segments_total"] == len(host["segments"]) == 7
    assert {s["id"] for s in body["segments"]} == {
        "cut1",
        "cut2",
        "cut3",
        "log1",
        "log2",
        "log3",
        "log4",
    }
    assert {s["id"]: s["track_id"] for s in body["segments"]}["log2"] == "room, other"
    assert set(body["segments"][0]) == {
        "id",
        "track_id",
        "start",
        "end",
        "duration_sec",
        "reason",
        "applied",
        "review_required",
    }


def test_the_report_withholds_text_that_names_a_host_path(world) -> None:
    body = _get(world, IMPACT).json()
    rows = {s["id"]: s for s in body["segments"]}

    assert rows["cut1"]["reason"] == "filler:um"
    assert rows["cut3"]["reason"] is None
    assert rows["log2"]["reason"] is None
    assert rows["log4"]["track_id"] is None
    assert PLANTED not in json.dumps(body)
    assert "/opt/host" not in json.dumps(body)


def test_the_markdown_is_the_hosts_format_over_the_filtered_numbers(world) -> None:
    report = edit_impact_report(world.ws.project)
    assert report["segments"][0]["reason"] == "filler:um"

    text = _get(world, IMPACT, markdown="true").json()["markdown"]

    assert text.startswith("# Edit impact")
    assert "Total removed (applied): **3.8s**" in text
    assert "filler:um" in text
    assert "/opt/host" not in text
    assert PLANTED not in text
    assert f"- {WITHHELD}: 0.1s" in text
    assert f"[applied] {WITHHELD}" in text
    assert "None" not in text


def test_the_markdown_lists_at_most_fifty_segments_like_the_hosts(world) -> None:
    world.ws.project.edit_decisions = [
        EditDecision(id=f"c{i}", track_id="room", start=i * 0.01, end=i * 0.01 + 0.005)
        for i in range(60)
    ]
    world.ws.project.editorial.edit_log = []
    world.ws.save()

    text = _get(world, IMPACT, markdown="true").json()["markdown"]

    assert text.count("[applied]") == 50


def test_the_report_lists_at_most_the_cap_and_says_how_many(world) -> None:
    world.ws.project.edit_decisions = [
        EditDecision(id=f"c{i}", track_id="room", start=i * 0.01, end=i * 0.01 + 0.005)
        for i in range(GUEST_LIST_MAX + 7)
    ]
    world.ws.project.editorial.edit_log = []
    world.ws.save()

    body = _get(world, IMPACT).json()

    assert len(body["segments"]) == GUEST_LIST_MAX
    assert body["segments_total"] == GUEST_LIST_MAX + 7


def test_the_editor_lists_the_social_clips_with_no_path(world) -> None:
    body = _get(world, CLIPS).json()
    clips = {c["id"]: c for c in body["clips"] if c["id"]}

    assert body["total"] == 3
    assert clips["sc1"] == {
        "id": "sc1",
        "track_id": "room",
        "start": 0.0,
        "end": 30.0,
        "score": 0.8,
        "reasons": ["energy", None],
        "title_suggestion": "A good bit",
        "caption_suggestion": "Listen",
        "transcript_excerpt": "hello there",
        "speaker": "Ana",
        "review_required": False,
        "approved": True,
        "exported": True,
    }
    assert "exported_path" not in json.dumps(body)
    assert "/opt/host" not in json.dumps(body)


def test_a_path_in_any_clip_text_or_id_is_withheld_and_an_empty_export_is_not_exported(
    world,
) -> None:
    body = _get(world, CLIPS).json()
    rows = {(c["start"]): c for c in body["clips"]}

    sc2 = rows[40.0]
    assert (sc2["title_suggestion"], sc2["caption_suggestion"], sc2["speaker"]) == (None,) * 3
    assert sc2["exported"] is False
    assert (rows[70.0]["id"], rows[70.0]["track_id"]) == (None, None)


def test_the_clip_list_is_capped_and_total_says_how_many(world) -> None:
    world.ws.project.social_clip_candidates = [
        SocialClipCandidate(id=f"c{i}", track_id="room", start=float(i), end=i + 1.0)
        for i in range(GUEST_LIST_MAX + 7)
    ]
    world.ws.save()

    body = _get(world, CLIPS).json()

    assert len(body["clips"]) == GUEST_LIST_MAX
    assert body["total"] == GUEST_LIST_MAX + 7


def test_the_clips_can_be_filtered_like_the_hosts_list(world) -> None:
    approved = _get(world, CLIPS, approved="true").json()
    pending = _get(world, CLIPS, review_required="true").json()
    none = _get(world, CLIPS, approved="true", review_required="true").json()

    assert [c["id"] for c in approved["clips"]] == ["sc1"]
    assert [c["id"] for c in pending["clips"]] == ["sc2", None]
    assert none == {"clips": [], "total": 0}


@pytest.fixture
def one_read_a_minute(monkeypatch):
    from podcast_mcp.services.remote_mcp.limits import reset_host_limiters_for_tests

    monkeypatch.setenv("PODCAST_RATE_LIMIT", "1")
    monkeypatch.setenv("PODCAST_RATE_LIMIT_READ_RPM", "60")
    monkeypatch.setenv("PODCAST_RATE_LIMIT_READ_BURST", "1")
    reset_host_limiters_for_tests(clock=lambda: 0.0)
    yield
    reset_host_limiters_for_tests()


@pytest.mark.parametrize("route", [IMPACT, CLIPS])
def test_both_routes_spend_the_read_bucket_over_http(world, one_read_a_minute, route) -> None:
    first, second = _get(world, route), _get(world, route)

    assert first.status_code == 200
    assert (second.status_code, second.headers[CODE]) == (429, "rate_limited")


@pytest.mark.parametrize("tool", sorted(EDITOR_INSIGHT_TOOLS))
def test_both_tools_spend_the_read_bucket_over_mcp(world, one_read_a_minute, tool) -> None:
    def post(call_id: int):
        return world.client.post(
            f"/mcp/{world.tokens['editor']}/mcp",
            json={
                "jsonrpc": "2.0",
                "id": call_id,
                "method": "tools/call",
                "params": {"name": tool, "arguments": {}},
            },
        )

    first, second = post(1), post(2)

    assert first.status_code == 200 and "error" not in first.json()
    assert second.status_code == 429
    assert second.json()["error"]["code"] == -32029


@pytest.mark.parametrize(("path", "extra"), [(IMPACT, "path"), (CLIPS, "project_path")])
def test_an_unknown_query_field_is_refused(world, path, extra) -> None:
    res = _get(world, path, **{extra: "/etc"})

    assert res.status_code == 422


def test_the_request_models_forbid_unknown_fields() -> None:
    for model in (GuestEditImpactRequest, GuestSocialClipsRequest):
        assert issubclass(model, GuestRequest)
        with pytest.raises(ValidationError):
            model.model_validate({"path": "/x"})


def test_the_studio_view_keeps_its_placeholders_for_every_role(world) -> None:
    from podcast_mcp.services.collaboration.share import share_daw_project_view

    for role in ("viewer", "commenter", "editor"):
        view = share_daw_project_view(world.tokens[role])
        assert view["edit_impact"] == {
            "pending_review_count": 0,
            "total_removed_sec": 0.0,
            "by_track_sec": {},
        }
        assert view["social_clips"] == []


def test_only_an_editor_is_offered_the_tools(world) -> None:
    for role, offered in (
        ("viewer", set()),
        ("commenter", set()),
        ("editor", EDITOR_INSIGHT_TOOLS),
    ):
        listed = handle_mcp_jsonrpc(
            world.tokens[role], {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
        )
        names = {tool["name"] for tool in listed["result"]["tools"]}
        assert names & EDITOR_INSIGHT_TOOLS == offered


@pytest.mark.parametrize("role", ["viewer", "commenter"])
@pytest.mark.parametrize("tool", sorted(EDITOR_INSIGHT_TOOLS))
def test_a_lesser_role_is_refused_over_mcp(world, tool, role) -> None:
    res = call_tool(world, tool, link=role)

    assert res["error"]["code"] == -32003
    assert res["error"]["message"] == guest_message_for_code("share_capability_required")


@pytest.mark.parametrize("tool", sorted(EDITOR_INSIGHT_TOOLS))
def test_a_revoked_link_is_refused_over_mcp(world, tool) -> None:
    world.share.revoke(world.tokens["editor"])

    assert call_tool(world, tool)["error"] == {"code": -32004, "message": "share not found"}


def test_the_tools_answer_what_the_http_twins_answer(world) -> None:
    assert mcp_ok(call_tool(world, "guest_edit_impact")) == _get(world, IMPACT).json()
    assert (
        mcp_ok(call_tool(world, "guest_edit_impact", {"markdown": True}))
        == _get(world, IMPACT, markdown="true").json()
    )
    assert mcp_ok(call_tool(world, "guest_social_clips")) == _get(world, CLIPS).json()
    assert (
        mcp_ok(call_tool(world, "guest_social_clips", {"approved": True}))
        == _get(world, CLIPS, approved="true").json()
    )
    assert PLANTED not in json.dumps(mcp_ok(call_tool(world, "guest_social_clips")))


@pytest.mark.parametrize("tool", sorted(EDITOR_INSIGHT_TOOLS))
def test_an_unknown_argument_is_invalid_params(world, tool) -> None:
    res = call_tool(world, tool, {"project_path": "/etc"})

    assert res["error"]["code"] == -32602
    assert "/etc" not in res["error"]["message"]


def test_the_input_schemas_are_the_request_models() -> None:
    defs = {
        t["name"]: t["inputSchema"]
        for t in list_tool_defs(capabilities_for_role("editor", with_mcp=True))
    }

    assert set(defs["guest_edit_impact"]["properties"]) == {"markdown"}
    assert set(defs["guest_social_clips"]["properties"]) == {"approved", "review_required"}
    assert defs["guest_edit_impact"]["additionalProperties"] is False
