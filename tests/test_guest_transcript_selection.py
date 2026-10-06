"""Guest transcript selection follows share capabilities (#6).

``edit`` guests apply a selected range, ``suggest`` guests propose it, and
view/play/comment guests can neither edit nor see timed words.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.edits.range_edits import range_geometry, range_media_seal
from podcast_mcp.edits.share_capabilities import capabilities_for_role
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import (
    Clip,
    CombinedTranscript,
    CombinedUtterance,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
)
from podcast_mcp.models.episode import ExactRangeTarget, RangeInterval
from podcast_mcp.services.app import ProjectWorkspace

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
    ws.project.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host", speaker="Host", start=0.2, end=1.5, text="Um. welcome"
            )
        ]
    )
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


@pytest.mark.parametrize(
    ("capabilities", "words"),
    [(VIEW, None), (SUGGEST, ["Um.", "welcome"]), (EDIT, ["Um.", "welcome"])],
    ids=["viewer", "commenter", "editor"],
)
def test_detail_words_follow_capabilities_and_never_include_suppressed(guest, capabilities, words):
    client, open_share, _path = guest
    token = open_share(capabilities)
    body = client.get(f"/api/review/{token}/daw/document/state", params={"phase": "detail"})
    assert body.status_code == 200
    patch = body.json()["patch"]
    [row] = patch["transcript"]["utterances"]
    got = [w["text"] for w in row["words"]] if "words" in row else None
    assert got == words
    assert patch["meta"] == {
        "hydration": {"transcript_words": words is not None, "history_groups": True}
    }


def test_edit_guest_cut_applies(guest):
    client, open_share, path = guest
    reply = _command(
        client, open_share(EDIT), "EditSelectedRange", {"action": "cut", "target": _um_target(path)}
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
        client, token, "EditSelectedRange", {"action": "cut", "target": _um_target(path)}
    )
    assert reply.status_code == 200
    [proposal] = load_project(path).edit_decisions
    assert (proposal.review_required, proposal.applied, proposal.reason) == (
        True,
        False,
        "guest:suggest",
    )
    assert _clip_spans(path) == [(0.0, 2.0)]
    direct = _command(client, token, "RippleDeleteRange", {"start": 0.2, "end": 0.6})
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
    body = payload if payload is not None else {"action": "cut", "target": _um_target(path)}
    reply = _command(client, open_share(VIEW), command_type, body)
    assert reply.status_code == 403
    assert load_project(path).edit_decisions == []
    assert _clip_spans(path) == [(0.0, 2.0)]
