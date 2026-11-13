"""Guest transcript selection follows share capabilities (#6).

``edit`` guests apply a selected range, ``suggest`` guests propose it, and
Viewers read timed words and neither select, edit nor suggest.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.edits.range_target import range_geometry, range_media_seal
from podcast_mcp.engines.transcript_sync import rebuild_combined
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import (
    Clip,
    CutIntent,
    MediaAsset,
    ProposalOrigin,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
)
from podcast_mcp.models.episode import ExactRangeTarget, RangeInterval
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.share import (
    guest_selects_transcript_words,
    guest_words,
    sanitize_guest_project_view,
    share_project_view,
)
from podcast_mcp.services.collaboration.share_capabilities import (
    REVIEW_ROLE_CAPABILITIES,
    GuestWords,
    capabilities_for_role,
    guest_reads_transcript_words,
)

VIEW = capabilities_for_role("viewer")
SUGGEST = capabilities_for_role("commenter")
EDIT = capabilities_for_role("editor")


@pytest.fixture
def guest(minimal_project, published_share):
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    ws.project.timeline.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=2.0, timeline_start=0.0)
    ]
    ws.project.timeline.duration_sec = 2.0
    ws.project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="Um.", start=0.2, end=0.6, confidence=0.9),
                TranscriptWord(text="welcome", start=0.8, end=1.2, confidence=0.9),
                TranscriptWord(text="bleed", start=1.3, end=1.5, suppressed=True),
            ],
        )
    ]
    rebuild_combined(ws.project, defaults=ws.effective_config())
    ws.save()
    client = TestClient(create_app())

    def open_share(capabilities: list[str]) -> str:
        return published_share(capabilities=capabilities)[2]["token"]

    return client, open_share, minimal_project


def _um_target(project_path) -> dict:
    project = load_project(project_path)
    spans = [RangeInterval(start=0.2, end=0.6)]
    return ExactRangeTarget(
        intervals=spans,
        track_ids=["host"],
        clips=range_geometry(project, spans, ["host"]),
        media_seals={"host": range_media_seal(project, "host")},
    ).model_dump(mode="json")


def _command(client: TestClient, token: str, command_type: str, payload: dict):
    return client.post(
        f"/api/review/{token}/daw/document/command",
        json={
            "client_id": "g",
            "client_seq": 1,
            "role": "guest",
            "type": command_type,
            "payload": payload,
        },
    )


def _clip_spans(project_path) -> list[tuple[float, float]]:
    return sorted((c.source_start, c.source_end) for c in load_project(project_path).clips)


READING_KEYS = {
    "text",
    "start",
    "end",
    "timeline_start",
    "timeline_end",
    "mappable",
    "word_index",
    "ignored",
}
NO_ROLE = [["play"], ["comment"], ["join", "monitor", "comment"]]


def _detail(client: TestClient, token: str) -> dict:
    body = client.get(f"/api/review/{token}/daw/document/state", params={"phase": "detail"})
    assert body.status_code == 200
    return body.json()["patch"]


@pytest.mark.parametrize(
    "capabilities", [VIEW, SUGGEST, EDIT], ids=["viewer", "commenter", "editor"]
)
def test_detail_words_follow_capabilities_and_never_include_suppressed(guest, capabilities):
    client, open_share, _path = guest
    patch = _detail(client, open_share(capabilities))
    [row] = patch["transcript"]["utterances"]
    assert [w["text"] for w in row["words"]] == ["Um.", "welcome"]
    assert "bleed" not in row["text"]
    assert patch["meta"] == {"hydration": {"transcript_words": True, "history_groups": True}}


def test_viewer_words_carry_text_and_timing_only(guest):
    client, open_share, _path = guest
    [viewer_row] = _detail(client, open_share(VIEW))["transcript"]["utterances"]
    for word in viewer_row["words"]:
        assert set(word) == READING_KEYS
    [commenter_row] = _detail(client, open_share(SUGGEST))["transcript"]["utterances"]
    um = commenter_row["words"][0]
    assert um["confidence"] == 0.9
    assert um["unsure"] is False
    assert um["suppressed"] is False
    assert um["timing_target"] == {"track_id": "host", "source_id": None, "word_index": 0}
    assert {k: um[k] for k in READING_KEYS} == viewer_row["words"][0]


@pytest.mark.parametrize("caps", NO_ROLE, ids=["play", "comment", "join-monitor-comment"])
def test_a_share_with_no_role_reads_no_words(guest, caps):
    client, open_share, _path = guest
    assert guest_selects_transcript_words(caps) is False
    assert guest_words(caps) is GuestWords.NONE
    assert guest_words(None) is GuestWords.NONE
    full = {
        "project_path": "/x",
        "meta": {"name": "ep", "hydration": {"transcript_words": True}},
        "transcript": {"utterances": [{"text": "hi", "words": [{"text": "hi", "start": 0}]}]},
    }
    out = sanitize_guest_project_view(full, words=guest_words(caps))
    assert "words" not in out["transcript"]["utterances"][0]
    assert out["meta"]["hydration"]["transcript_words"] is False
    token = open_share(caps)
    for route in ("daw/document/state", "daw/project"):
        assert client.get(f"/api/review/{token}/{route}").status_code == 403


def test_a_viewer_with_a_stray_capability_still_reads(guest):
    assert guest_words(["view", "suggest"]) is GuestWords.READING


def test_selecting_implies_reading():
    sets = (
        [list(caps) for caps in REVIEW_ROLE_CAPABILITIES.values()] + NO_ROLE + [["view", "suggest"]]
    )
    for caps in sets:
        if guest_selects_transcript_words(caps):
            assert guest_reads_transcript_words(caps)
    assert guest_words(VIEW) is GuestWords.READING
    assert guest_words(SUGGEST) is GuestWords.SELECTABLE
    assert guest_words(EDIT) is GuestWords.SELECTABLE


@pytest.mark.parametrize(
    "capabilities", [VIEW, SUGGEST, EDIT], ids=["viewer", "commenter", "editor"]
)
def test_bootstrap_words_flag_matches_the_document_state_route(guest, capabilities):
    client, open_share, _path = guest
    token = open_share(capabilities)
    assert share_project_view(token)["reads_transcript_words"] is True
    [row] = _detail(client, token)["transcript"]["utterances"]
    assert "words" in row


@pytest.mark.parametrize("caps", NO_ROLE, ids=["play", "comment", "join-monitor-comment"])
def test_bootstrap_words_flag_is_false_for_a_share_with_no_role(guest, caps):
    _client, open_share, _path = guest
    assert share_project_view(open_share(caps))["reads_transcript_words"] is False


def test_edit_guest_cut_applies(guest):
    client, open_share, path = guest
    reply = _command(
        client,
        open_share(EDIT),
        "EditSelectedRange",
        {"action": "cut", "targets": [_um_target(path)]},
    )
    assert reply.status_code == 200
    project = load_project(path)
    assert _clip_spans(path) == [(0.0, 0.2), (0.6, 2.0)]
    assert project.edit_decisions == []
    assert project.editorial.edit_log[-1].params["action"] == "cut"


def test_suggest_guest_cut_is_a_pending_suggestion_and_direct_edits_are_refused(guest):
    client, open_share, path = guest
    token = open_share(SUGGEST)
    reply = _command(
        client, token, "EditSelectedRange", {"action": "cut", "targets": [_um_target(path)]}
    )
    assert reply.status_code == 200
    [proposal] = load_project(path).edit_decisions
    assert (proposal.review_required, proposal.applied, proposal.reason) == (
        True,
        False,
        "guest:suggest",
    )
    assert (proposal.proposal_origin, proposal.boundary_intent) == (
        ProposalOrigin.PROGRAMMATIC,
        CutIntent.PROGRAMMATIC,
    )
    assert _clip_spans(path) == [(0.0, 2.0)]
    direct = _command(client, token, "CutRange", {"start": 0.2, "end": 0.6, "mode": "ripple"})
    assert direct.status_code == 403
    approve = _command(client, token, "ApproveEdits", {"ids": [proposal.id]})
    assert approve.status_code == 403
    assert _clip_spans(path) == [(0.0, 2.0)]


@pytest.mark.parametrize(
    ("command_type", "payload"),
    [
        ("EditSelectedRange", None),
        ("SuggestPendingEdit", {"track_id": "host", "start": 0.2, "end": 0.6}),
    ],
)
def test_view_guest_can_neither_edit_nor_suggest(guest, command_type, payload):
    client, open_share, path = guest
    body = payload if payload is not None else {"action": "cut", "targets": [_um_target(path)]}
    reply = _command(client, open_share(VIEW), command_type, body)
    assert reply.status_code == 403
    assert load_project(path).edit_decisions == []
    assert _clip_spans(path) == [(0.0, 2.0)]


@pytest.mark.parametrize(
    ("caps", "reads"),
    [
        (VIEW, True),
        (SUGGEST, True),
        (EDIT, True),
        (["view", "suggest"], True),
        (["play"], False),
        (["comment"], False),
        (["join", "monitor", "comment"], False),
    ],
    ids=["viewer", "commenter", "editor", "viewer-stray-suggest", "play", "comment", "record"],
)
def test_bootstrap_words_flag_is_true_exactly_when_the_share_reads_words(guest, caps, reads):
    _client, open_share, _path = guest
    assert share_project_view(open_share(caps))["reads_transcript_words"] is reads


def test_viewer_interior_suppressed_word_never_reaches_words_or_utterance_text(guest):
    client, open_share, path = guest
    from podcast_mcp.models import CombinedTranscript, CombinedUtterance

    ws = ProjectWorkspace.open(path)
    ws.project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="Um.", start=0.2, end=0.6, confidence=0.9),
                TranscriptWord(text="bleed", start=0.7, end=0.8, suppressed=True),
                TranscriptWord(text="welcome", start=0.9, end=1.2, confidence=0.9),
            ],
        )
    ]
    ws.project.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host", speaker="Host", start=0.2, end=1.2, text="Um. bleed welcome"
            )
        ]
    )
    ws.save()
    token = open_share(VIEW)
    for phase in ("shell", "detail", "full"):
        body = client.get(f"/api/review/{token}/daw/document/state", params={"phase": phase})
        assert "bleed" not in json.dumps(body.json()), phase


def test_viewer_ws_hello_pump_and_command_reply_carry_no_words(guest):
    client, open_share, path = guest
    viewer = open_share(VIEW)
    with client.websocket_connect(f"/api/review/{viewer}/daw/ws") as guest_ws:
        hello = [guest_ws.receive_json(), guest_ws.receive_json()]
        assert all('"words"' not in json.dumps(m) for m in hello)
        commenter = open_share(SUGGEST)
        reply = _command(
            client,
            commenter,
            "EditSelectedRange",
            {"action": "cut", "targets": [_um_target(path)]},
        )
        assert reply.status_code == 200
        assert '"words"' not in json.dumps(reply.json())
        pumped = []
        for _ in range(10):
            msg = guest_ws.receive_json()
            pumped.append(msg)
            if msg.get("type") == "Applied" and msg.get("plane") == "document":
                break
        assert any(m.get("plane") == "document" for m in pumped)
        assert all('"words"' not in json.dumps(m) for m in pumped)


ROW_OVERLAY_FIELDS = (
    "text",
    "locked_word_indices",
    "ignored_word_indices",
    "edge_suppressed_word_indices",
    "suppressed_only",
)


def _overlay_rows(utterances: list[dict]) -> list[dict]:
    return [{k: row.get(k) for k in ROW_OVERLAY_FIELDS} for row in utterances]


def _mcp_project(token: str) -> dict:
    from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc

    out = handle_mcp_jsonrpc(
        token,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "guest_get_project", "arguments": {}},
        },
    )
    return json.loads(out["result"]["content"][0]["text"])


@pytest.mark.parametrize("role", ["viewer", "commenter", "editor"])
def test_row_fields_the_client_overlay_compares_agree_on_every_route(guest, role):
    """gui/web/src/document/projectPatch.ts keeps a loaded word overlay only while
    ``text``, ``locked_word_indices``, ``ignored_word_indices``,
    ``edge_suppressed_word_indices`` and ``suppressed_only`` match the previous row,
    so a guest must get the same values from ``document/state`` as from every
    route that sanitizes with the default word mode."""
    client, open_share, path = guest
    ws = ProjectWorkspace.open(path)
    ws.project.transcripts[0].words[1].audibility_locked = True
    rebuild_combined(ws.project, defaults=ws.effective_config())
    ws.save()
    token = open_share(capabilities_for_role(role, with_mcp=True))
    base = f"/api/review/{token}/daw"

    def state(phase: str) -> list[dict]:
        body = client.get(f"{base}/document/state", params={"phase": phase})
        assert body.status_code == 200
        payload = body.json()
        view = payload["patch"] if "patch" in payload else payload["project"]
        return view["transcript"]["utterances"]

    reference = _overlay_rows(state("detail"))
    assert reference[0]["locked_word_indices"] == [1]
    assert reference[0]["edge_suppressed_word_indices"] == [2]
    assert _overlay_rows(state("full")) == reference

    routes: dict[str, list[dict]] = {}
    for name, params in (("project", {}), ("project-shell", {"phase": "shell"})):
        body = client.get(f"{base}/project", params=params)
        assert body.status_code == 200
        routes[name] = body.json()["transcript"]["utterances"]
    with client.websocket_connect(f"{base}/ws") as guest_ws:
        hello = [guest_ws.receive_json(), guest_ws.receive_json()]
    [document] = [m for m in hello if m["plane"] == "document"]
    routes["ws-hello"] = document["snapshot"]["project"]["transcript"]["utterances"]
    routes["remote-mcp"] = _mcp_project(token)["transcript"]["utterances"]

    for name, utterances in routes.items():
        assert _overlay_rows(utterances) == reference, name
