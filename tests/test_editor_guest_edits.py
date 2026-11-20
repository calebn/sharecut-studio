from __future__ import annotations

import pytest

from aligned_share_world import MOODY, UNCLE, AlignedShareWorld, build_aligned_share_world
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.models import load_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role
from podcast_mcp.services.document.boundary import TrimBoundaryTarget, boundary_context


@pytest.fixture
def world(tmp_path, tmp_workspace) -> AlignedShareWorld:
    return build_aligned_share_world(
        tmp_path,
        {
            "commenter": capabilities_for_role("commenter"),
            "editor": capabilities_for_role("editor"),
            "second": capabilities_for_role("editor"),
            "mcp": capabilities_for_role("editor", with_mcp=True),
        },
    )


def _clip_of(path, track_id):
    return next(c for c in load_project(path).clips if c.track_id == track_id)


def _suggest_cut(world, word_index):
    suggested = world.guest(
        "commenter", "EditSelectedRange", {"action": "cut", "targets": [world.target(word_index)]}
    )
    assert suggested.status_code == 200, suggested.text
    return [e.id for e in load_project(world.path).edit_decisions]


@pytest.mark.parametrize("action", ["cut", "mute"])
def test_editor_cut_and_mute_apply_like_the_host(world, action):
    host = world.host("EditSelectedRange", {"action": action, "targets": [world.target(UNCLE)]})
    assert host.status_code == 200, host.text
    editor = world.guest(
        "editor", "EditSelectedRange", {"action": action, "targets": [world.target(MOODY)]}
    )
    assert editor.status_code == 200, editor.text
    assert len(load_project(world.path).editorial.edit_log) == 2


def test_editor_approves_a_commenter_suggestion(world):
    ids = _suggest_cut(world, UNCLE)
    approved = world.guest("editor", "ApproveEdits", {"ids": ids})
    assert approved.status_code == 200, approved.text
    project = load_project(world.path)
    assert project.edit_decisions == []
    assert len(project.editorial.edit_log) == 1


def test_commenter_cut_still_proposes(world):
    ids = _suggest_cut(world, UNCLE)
    project = load_project(world.path)
    [proposal] = project.edit_decisions
    assert proposal.id == ids[0]
    assert proposal.boundary_intent == "programmatic"
    assert proposal.review_required is True
    assert project.editorial.edit_log == []


def test_editor_cut_is_undone_by_that_editor_only(world):
    cut = world.guest(
        "editor", "EditSelectedRange", {"action": "cut", "targets": [world.target(UNCLE)]}
    )
    head = cut.json()["history_head_id"]
    assert len(load_project(world.path).clips) == 3
    refused = world.guest("second", "UndoHistory", {"expected_head_id": head})
    assert refused.status_code == 400
    assert refused.headers["x-sharecut-error-code"] == "nothing_of_yours_to_undo"
    assert refused.json()["detail"] == (
        "There is nothing of yours to undo. The latest change is someone else's."
    )
    undone = world.guest("editor", "UndoHistory", {"expected_head_id": head})
    assert undone.status_code == 200, undone.text
    assert len(load_project(world.path).clips) == 2


def test_guest_mcp_editor_cut_stays_programmatic(world):
    out = world.mcp("mcp", "EditSelectedRange", {"action": "cut", "targets": [world.target(UNCLE)]})
    assert "error" not in out, out
    assert out["result"]["isError"] is True
    assert load_project(world.path).editorial.edit_log == []


def test_editor_cut_range_over_http_matches_host(world):
    word = load_project(world.path).transcripts[0].words[UNCLE]
    payload = {"start": word.start, "end": word.end, "mode": "ripple", "track_ids": ["reference"]}
    editor = world.guest("editor", "CutRange", payload)
    assert editor.status_code == 200, editor.text
    assert len(load_project(world.path).editorial.edit_log) == 1


def test_editor_trim_clip_edge_matches_host(world):
    clip = _clip_of(world.path, "reference")
    token = boundary_context(
        ProjectWorkspace.open(world.path).project,
        TrimBoundaryTarget(clip_id=clip.id, edge="in", mode="gap"),
        defaults=load_defaults(),
    ).token
    payload = {
        "clip_id": clip.id,
        "edge": "in",
        "source_sec": 2.6,
        "mode": "gap",
        "expected_token": token,
    }
    editor = world.guest("editor", "TrimClipEdge", payload)
    assert editor.status_code == 200, editor.text
    assert len(load_project(world.path).editorial.edit_log) == 1


def test_editor_delete_clip_applies_commenter_proposes(world):
    clip = _clip_of(world.path, "guest")
    payload = {"clip_id": clip.id, "mode": "ripple"}
    proposed = world.guest("commenter", "DeleteClip", payload)
    assert proposed.status_code == 200, proposed.text
    assert len(load_project(world.path).clips) == 2
    editor = world.guest("editor", "DeleteClip", payload)
    assert editor.status_code == 200, editor.text
    assert "needs_confirmation" not in editor.json()
    assert load_project(world.path).clips == []


def test_editor_apply_suggested_actions_follows_host_intent(world):
    word = load_project(world.path).transcripts[0].words[UNCLE]
    staged = world.host(
        "StageTimeRangeCut",
        {
            "track_id": "reference",
            "start": word.start,
            "end": word.end,
            "reason": "filler:um",
            "review_required": True,
        },
    )
    assert staged.status_code == 200, staged.text
    applied = world.guest("editor", "ApplySuggestedActions", {})
    assert applied.status_code == 200, applied.text
    project = load_project(world.path)
    assert project.edit_decisions == []
    assert len(project.editorial.edit_log) == 1


def _stage_cut_then_move_its_audio(world):
    staged = world.host(
        "StageWordsCut",
        {"track_id": "reference", "start_word_index": UNCLE, "end_word_index": UNCLE},
    )
    assert staged.status_code == 200, staged.text
    split = world.host("SplitAtTime", {"at_time": 2.65, "track_ids": ["reference"]})
    assert split.status_code == 200, split.text
    right = next(
        c
        for c in load_project(world.path).clips
        if c.track_id == "reference" and c.timeline_start > 2.0
    )
    moved = world.host(
        "MoveClips",
        {
            "clips": [
                {
                    "clip_id": right.id,
                    "timeline_start": right.timeline_start + 1.0,
                    "track_id": "reference",
                }
            ]
        },
    )
    assert moved.status_code == 200, moved.text
    return [e.id for e in load_project(world.path).edit_decisions]


HELD_SENTENCE = (
    "Reference's cut at 0:02.5 was not applied because that part of the recording is no longer "
    "in one piece on the timeline. Nothing was changed."
)


def test_guest_hold_reaches_the_editor_in_words(world):
    ids = _stage_cut_then_move_its_audio(world)
    refused = world.guest("editor", "ApproveEdits", {"ids": ids})
    assert refused.status_code == 400
    assert refused.headers["x-sharecut-error-code"] == "cut_scope_changed"
    assert refused.json()["detail"] == HELD_SENTENCE
    assert [r.operation for r in load_project(world.path).editorial.edit_log] == [
        "split_clips_at",
        "move_clips",
    ]


def test_guest_mcp_editor_hold_reads_the_plain_acoustic_sentence(world):
    out = world.mcp("mcp", "EditSelectedRange", {"action": "cut", "targets": [world.target(UNCLE)]})
    result = out["result"]
    assert result["isError"] is True
    assert result["structuredContent"] == {
        "ok": False,
        "error": (
            "Reference's cut at 0:02.5 was not applied because the edit would start or end "
            "inside a word or a breath, and that could be heard. Nothing was changed."
        ),
        "error_code": "cut_scope_changed",
    }


def test_host_approve_rows_name_the_hold_code(world):
    ids = _stage_cut_then_move_its_audio(world)
    approved = world.host("ApproveEdits", {"ids": ids, "hold_blocked": True})
    assert approved.status_code == 200, approved.text
    held = approved.json()["command"]["payload"]["result"]["held"]
    assert held == [
        {
            "id": ids[0],
            "label": "reference's cut at 0:02.5",
            "reason": "the selected audio no longer has one complete, continuous placement",
            "code": "source_geometry",
        }
    ]


def test_editor_reject_reply_carries_the_count_the_page_parses(world):
    ids = _suggest_cut(world, UNCLE)
    rejected = world.guest("editor", "RejectEdits", {"ids": ids})
    assert rejected.status_code == 200, rejected.text
    body = rejected.json()
    assert body["review_result"] == {"count": 1, "held": []}
    assert body["command"] == {"type": "RejectEdits"}


def test_editor_approve_reply_carries_count_and_no_held_rows(world):
    ids = _suggest_cut(world, UNCLE)
    approved = world.guest("editor", "ApproveEdits", {"ids": ids})
    assert approved.status_code == 200, approved.text
    body = approved.json()
    assert body["review_result"] == {"count": 1, "held": []}
    assert body["command"] == {"type": "ApproveEdits"}


def test_editor_approve_reply_names_a_held_cut_in_words_without_its_code(world):
    ids = _stage_cut_then_move_its_audio(world)
    approved = world.guest("editor", "ApproveEdits", {"ids": ids, "hold_blocked": True})
    assert approved.status_code == 200, approved.text
    assert approved.json()["review_result"] == {
        "count": 0,
        "held": [
            {
                "id": ids[0],
                "label": "Reference's cut at 0:02.5",
                "reason": "that part of the recording is no longer in one piece on the timeline",
            }
        ],
        "approved_ids": [],
    }


def test_editor_approve_reply_lists_the_ids_it_approved(world):
    ids = _suggest_cut(world, UNCLE)
    approved = world.guest("editor", "ApproveEdits", {"ids": ids, "hold_blocked": True})
    assert approved.status_code == 200, approved.text
    assert approved.json()["review_result"] == {"count": 1, "held": [], "approved_ids": ids}


def test_host_reply_has_the_same_review_result(world):
    ids = _stage_cut_then_move_its_audio(world)
    approved = world.host("ApproveEdits", {"ids": ids, "hold_blocked": True})
    assert approved.status_code == 200, approved.text
    assert approved.json()["review_result"] == {
        "count": 0,
        "held": [
            {
                "id": ids[0],
                "label": "reference's cut at 0:02.5",
                "reason": "the selected audio no longer has one complete, continuous placement",
            }
        ],
        "approved_ids": [],
    }


def test_a_retried_reject_carries_the_same_review_result(world):
    ids = _suggest_cut(world, UNCLE)
    first = world.guest("editor", "RejectEdits", {"ids": ids}, command_id="cmd_reject_once")
    retry = world.guest("editor", "RejectEdits", {"ids": ids}, command_id="cmd_reject_once")
    assert retry.status_code == 200, retry.text
    assert retry.json()["idempotent"] is True
    assert (
        retry.json()["review_result"] == first.json()["review_result"] == {"count": 1, "held": []}
    )
