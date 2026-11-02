"""``UpdateSocialClipDetails``: retitle and approve or unapprove one clip, undo it, host only."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from podcast_mcp.clips.social import SOCIAL_CLIP_TITLE_MAX_CHARS
from podcast_mcp.models import Track, load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role
from podcast_mcp.services.document import ClipService, HistoryService
from podcast_mcp.services.document_sync.capabilities import (
    EDIT_COMMANDS,
    HOST_ONLY_DOCUMENT_COMMANDS,
    authorize_document_command,
    document_command_types_for_caps,
)
from podcast_mcp.services.document_sync.handlers import apply_command
from podcast_mcp.services.document_sync.payloads import DOCUMENT_COMMAND_ADAPTER
from podcast_mcp.util.coded_error import CodedValueError

CMD = "UpdateSocialClipDetails"


@pytest.fixture
def clip(minimal_project):
    project = load_project(minimal_project)
    project.timeline.tracks = [Track(id="host", label="host")]
    project.timeline.duration_sec = 60.0
    save_project(project)
    ws = ProjectWorkspace.open(minimal_project)
    made = ClipService(ws).add_manual(track_id="host", start=1.0, end=4.0, title="Hook")
    return ws, made.id


def _row(ws, clip_id):
    ws.reload()
    return next(c for c in ws.project.social_clip_candidates if c.id == clip_id)


def test_the_title_is_trimmed_and_saved_without_touching_the_rest(clip):
    ws, cid = clip
    out = apply_command(ws, CMD, {"id": cid, "title": "  A better hook \n"})
    assert out["title_suggestion"] == "A better hook"
    row = _row(ws, cid)
    assert row.title_suggestion == "A better hook"
    assert (row.start, row.end, row.approved, row.review_required) == (1.0, 4.0, False, True)


@pytest.mark.parametrize("blank", ["", "  \t\n"])
def test_an_empty_title_clears_it(clip, blank):
    ws, cid = clip
    apply_command(ws, CMD, {"id": cid, "title": blank})
    assert _row(ws, cid).title_suggestion is None


def test_the_longest_title_is_kept(clip):
    ws, cid = clip
    title = "t" * SOCIAL_CLIP_TITLE_MAX_CHARS
    apply_command(ws, CMD, {"id": cid, "title": title})
    assert _row(ws, cid).title_suggestion == title


@pytest.mark.parametrize(
    "title", ["x" * (SOCIAL_CLIP_TITLE_MAX_CHARS + 1), "bad\x00title", "zero​width"]
)
def test_an_invalid_title_is_refused_and_changes_nothing(clip, title):
    ws, cid = clip
    with pytest.raises(CodedValueError) as err:
        apply_command(ws, CMD, {"id": cid, "title": title, "approved": True})
    assert err.value.code == "invalid_clip_title"
    row = _row(ws, cid)
    assert row.title_suggestion == "Hook"
    assert row.approved is False


def test_approving_clears_the_review_flag_and_leaves_the_title(clip):
    ws, cid = clip
    apply_command(ws, CMD, {"id": cid, "approved": True})
    row = _row(ws, cid)
    assert (row.approved, row.review_required, row.title_suggestion) == (True, False, "Hook")


def test_unapproving_keeps_the_review_flag_as_it_was(clip):
    ws, cid = clip
    apply_command(ws, CMD, {"id": cid, "approved": True})
    apply_command(ws, CMD, {"id": cid, "approved": False})
    row = _row(ws, cid)
    assert (row.approved, row.review_required) == (False, False)


def test_a_title_and_an_approval_land_together_as_one_undo_step(clip):
    ws, cid = clip
    apply_command(ws, CMD, {"id": cid, "title": "Final", "approved": True})
    row = _row(ws, cid)
    assert (row.title_suggestion, row.approved) == ("Final", True)
    HistoryService(ws).undo()
    row = _row(ws, cid)
    assert (row.title_suggestion, row.approved, row.review_required) == ("Hook", False, True)
    HistoryService(ws).redo()
    assert _row(ws, cid).title_suggestion == "Final"


def test_an_unknown_clip_is_refused_and_changes_nothing(clip):
    ws, cid = clip
    with pytest.raises(CodedValueError) as err:
        apply_command(ws, CMD, {"id": "nope", "title": "x"})
    assert err.value.code == "social_clip_not_found"
    assert _row(ws, cid).title_suggestion == "Hook"


def test_a_command_that_sets_nothing_is_refused_by_the_service(clip):
    ws, cid = clip
    with pytest.raises(CodedValueError) as err:
        apply_command(ws, CMD, {"id": cid})
    assert err.value.code == "invalid_clip_details"


def _envelope(payload):
    return {"type": CMD, "payload": payload, "client_id": "c1", "client_seq": 1}


def test_the_command_validates_as_an_envelope():
    body = DOCUMENT_COMMAND_ADAPTER.validate_python(_envelope({"id": "s1", "approved": False}))
    assert (body.payload.id, body.payload.title, body.payload.approved) == ("s1", None, False)


@pytest.mark.parametrize(
    "payload", [{"id": "s1"}, {"title": "x"}, {"id": "s1", "approved": "maybe"}]
)
def test_a_payload_without_an_id_or_a_change_is_invalid(payload):
    with pytest.raises(ValidationError):
        DOCUMENT_COMMAND_ADAPTER.validate_python(_envelope(payload))


def test_only_the_host_retitles_and_approves():
    assert CMD in HOST_ONLY_DOCUMENT_COMMANDS
    assert CMD not in EDIT_COMMANDS
    authorize_document_command(None, CMD)
    for role in ("editor", "commenter", "viewer"):
        caps = capabilities_for_role(role)
        assert CMD not in document_command_types_for_caps(caps)
        with pytest.raises(PermissionError) as raised:
            authorize_document_command(caps, CMD)
        assert raised.value.code == "share_capability_required"
