from __future__ import annotations

import pytest

from podcast_mcp.gui.assembler import (
    VIEW_PROJECTION_QUERY_DESCRIPTION,
    ViewProjection,
    build_project_view,
    dump_project_projection,
)
from podcast_mcp.models import (
    CombinedTranscript,
    CombinedUtterance,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.services import ProjectWorkspace
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.projection_types import (
    ViewProjection as CanonicalViewProjection,
)
from podcast_mcp.services.document_sync.projection_types import (
    parse_view_projection,
)
from podcast_mcp.services.document_sync.projections import projection_for_command


def _with_transcript(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.4, confidence=0.9),
                TranscriptWord(text="world", start=0.4, end=0.8, confidence=0.9),
            ],
        )
    ]
    ws.project.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=0.8,
                text="hello world",
            )
        ]
    )
    ws.save()
    return ws


def test_assembler_reexports_projection_types() -> None:
    from podcast_mcp.gui import assembler
    from podcast_mcp.services.document_sync import projection_types as types

    assert assembler.ViewProjection is types.ViewProjection
    assert assembler.parse_view_projection is types.parse_view_projection
    assert assembler.VIEW_PROJECTION_QUERY_DESCRIPTION is types.VIEW_PROJECTION_QUERY_DESCRIPTION


def test_parse_view_projection_default_and_invalid() -> None:
    assert parse_view_projection(None) is CanonicalViewProjection.SHELL
    assert parse_view_projection("FULL") is CanonicalViewProjection.FULL
    with pytest.raises(ValueError, match="unknown"):
        parse_view_projection("nope")


def test_shell_omits_words_and_history_groups(minimal_project) -> None:
    ws = _with_transcript(minimal_project)
    shell = build_project_view(ws, projection=ViewProjection.SHELL)
    uts = (shell.transcript or {}).get("utterances") or []
    assert uts
    assert "words" not in uts[0]
    assert shell.history.get("groups") == []
    assert shell.meta["hydration"] == {
        "transcript_words": False,
        "history_groups": False,
    }


def test_full_includes_words(minimal_project) -> None:
    ws = _with_transcript(minimal_project)
    full = build_project_view(ws, projection=ViewProjection.FULL)
    words = (full.transcript or {})["utterances"][0]["words"]
    assert [w["text"] for w in words] == ["hello", "world"]
    assert full.meta["hydration"]["transcript_words"] is True


def test_detail_patch_is_words_and_history(minimal_project) -> None:
    ws = _with_transcript(minimal_project)
    detail = dump_project_projection(ws, projection=ViewProjection.DETAIL)
    assert "tracks" not in detail
    assert detail["transcript"]["utterances"][0]["words"][0]["text"] == "hello"
    assert "groups" in detail["history"]
    assert detail["meta"]["hydration"]["transcript_words"] is True


def test_guest_detail_skips_words_and_history_groups(
    minimal_project, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _with_transcript(minimal_project)

    def _boom_transcript(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("guest DETAIL must not map transcript words")

    def _boom_history(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("guest DETAIL must not list history groups")

    monkeypatch.setattr(
        "podcast_mcp.gui.assembler.map_transcript_utterances_to_timeline",
        _boom_transcript,
    )
    monkeypatch.setattr(
        "podcast_mcp.gui.assembler.HistoryService.list_entries",
        _boom_history,
    )
    detail = dump_project_projection(ws, projection=ViewProjection.DETAIL, audience="guest")
    assert "transcript" not in detail
    assert "history" not in detail
    assert detail["meta"]["hydration"] == {
        "transcript_words": False,
        "history_groups": False,
    }


def test_tracks_projection(minimal_project) -> None:
    ws = ProjectWorkspace.open(minimal_project)
    dumped = dump_project_projection(ws, projection=ViewProjection.TRACKS)
    assert list(dumped.keys()) == ["tracks"]
    assert dumped["tracks"] == []


def test_comments_projection(minimal_project) -> None:
    dumped = dump_project_projection(
        ProjectWorkspace.open(minimal_project),
        projection="comments",
    )
    assert list(dumped.keys()) == ["comments"]


def test_view_projection_query_description_lists_slices() -> None:
    text = VIEW_PROJECTION_QUERY_DESCRIPTION
    assert "clips" in text
    assert "fx" in text
    assert "envelopes" in text
    assert "default shell" in text


def test_clips_fx_envelope_projections(minimal_project) -> None:
    from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole

    ws = ProjectWorkspace.open(minimal_project)
    ws.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    ws.project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        )
    ]
    ws.save()
    clips = dump_project_projection(ws, projection=ViewProjection.CLIPS)
    assert set(clips.keys()) == {"clips", "tracks", "render_status"}
    assert clips["clips"]["clip_count"] == 1
    fx = dump_project_projection(ws, projection=ViewProjection.FX)
    assert set(fx.keys()) == {"effects_by_track", "tracks", "render_status"}
    envelopes = dump_project_projection(ws, projection=ViewProjection.ENVELOPES)
    assert set(envelopes.keys()) == {"envelopes", "tracks", "render_status"}


def test_build_project_view_string_shell_and_rejects_tracks(minimal_project) -> None:
    ws = ProjectWorkspace.open(minimal_project)
    shell = build_project_view(ws, projection="shell")
    assert shell.meta["hydration"]["transcript_words"] is False
    with pytest.raises(ValueError, match="does not support"):
        build_project_view(ws, projection=ViewProjection.TRACKS)


def test_comments_snapshot_has_no_project(minimal_project) -> None:
    svc = DocumentSyncService.open(minimal_project)
    snap = svc.comments_snapshot()
    assert "project" not in snap
    assert "patch" not in snap
    assert "comments" in snap
    assert "history" in snap


def test_reorder_applied_uses_tracks_patch(minimal_project) -> None:
    from podcast_mcp.models import MediaAsset, Track, TrackRole

    ws = ProjectWorkspace.open(minimal_project)
    ws.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=1.0),
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=1.0),
        ),
    ]
    ws.save()
    svc = DocumentSyncService.open(minimal_project)
    result = svc.submit(
        DocumentCommand(
            type="ReorderTrack",
            payload={"track_id": "guest", "index": 0},
            client_id="t",
            role="viewer",
            client_seq=1,
        )
    )
    snap = result["snapshot"]
    assert "project" not in snap
    assert snap["patch"]["tracks"][0]["id"] == "guest"


def _assert_shell_project_snapshot(snap: dict) -> None:
    assert "project" in snap
    assert "patch" not in snap
    assert snap["project"]["meta"]["hydration"]["transcript_words"] is False
    for utterance in (snap["project"].get("transcript") or {}).get("utterances") or []:
        assert "words" not in utterance


def test_split_applied_uses_shell_snapshot(minimal_project) -> None:
    from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole

    ws = _with_transcript(minimal_project)
    ws.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    ws.project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        )
    ]
    ws.save()
    svc = DocumentSyncService.open(minimal_project)
    result = svc.submit(
        DocumentCommand(
            type="SplitAtTime",
            payload={"at_time": 0.4, "track_ids": ["host"]},
            client_id="t",
            role="viewer",
            client_seq=1,
        )
    )
    _assert_shell_project_snapshot(result["snapshot"])


def test_transcript_command_applied_uses_detail_patch(minimal_project) -> None:
    _with_transcript(minimal_project)
    svc = DocumentSyncService.open(minimal_project)
    result = svc.submit(
        DocumentCommand(
            type="CorrectTranscriptWord",
            payload={"track_id": "host", "word_index": 0, "text": "Hello"},
            client_id="t",
            role="viewer",
            client_seq=1,
        )
    )
    snap = result["snapshot"]
    assert "project" not in snap
    words = snap["patch"]["transcript"]["utterances"][0]["words"]
    assert words[0]["text"] == "Hello"
    assert snap["patch"]["meta"]["hydration"]["transcript_words"] is True


def test_projection_for_command() -> None:
    from podcast_mcp.services.document_sync.handlers.comments import HANDLERS as COMMENT_HANDLERS
    from podcast_mcp.services.document_sync.projections import COMMENT_COMMANDS

    assert frozenset(COMMENT_HANDLERS) == COMMENT_COMMANDS
    assert projection_for_command("AddComment") is ViewProjection.COMMENTS
    assert projection_for_command("AddReply") is ViewProjection.COMMENTS
    assert projection_for_command("SetTrackMeta") is ViewProjection.TRACKS
    assert projection_for_command("SplitAtTime") is ViewProjection.SHELL
    assert projection_for_command("SetClipFade") is ViewProjection.CLIPS
    assert projection_for_command("SetJoinMode") is ViewProjection.CLIPS
    assert projection_for_command("ApplyFadeRecommendations") is ViewProjection.CLIPS
    assert projection_for_command("SetEffectBypass") is ViewProjection.FX
    assert projection_for_command("SetEnvelope") is ViewProjection.ENVELOPES
    assert projection_for_command("UndoHistory") is ViewProjection.SHELL
    assert projection_for_command("CorrectTranscriptWord") is ViewProjection.DETAIL
    assert projection_for_command("CorrectTranscriptPhrase") is ViewProjection.DETAIL
    assert projection_for_command("SetTranscriptWordSuppressed") is ViewProjection.DETAIL
    from podcast_mcp.services.document_sync.handlers.transcript import HANDLERS
    from podcast_mcp.services.document_sync.projections import TRANSCRIPT_WORD_COMMANDS

    assert frozenset(HANDLERS) == TRANSCRIPT_WORD_COMMANDS


def test_http_project_default_is_shell(minimal_project) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    _with_transcript(minimal_project)
    client = TestClient(create_app())
    path = str(minimal_project)
    shell = client.get("/api/project", params={"path": path})
    assert shell.status_code == 200
    uts = (shell.json().get("transcript") or {}).get("utterances") or []
    if uts:
        assert "words" not in uts[0]
    assert shell.json()["meta"]["hydration"]["transcript_words"] is False

    detail = client.get("/api/project", params={"path": path, "phase": "detail"})
    assert detail.status_code == 200
    assert "tracks" not in detail.json()
    words = detail.json()["transcript"]["utterances"][0]["words"]
    assert words[0]["text"] == "hello"

    full = client.get("/api/project", params={"path": path, "phase": "full"})
    assert full.status_code == 200
    assert full.json()["meta"]["hydration"]["transcript_words"] is True

    bad = client.get("/api/project", params={"path": path, "phase": "nope"})
    assert bad.status_code == 400


def test_project_meta_includes_server_seq(minimal_project) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    res = client.get("/api/project/meta", params={"path": str(minimal_project)})
    assert res.status_code == 200
    assert res.json()["server_seq"] == 0


def test_document_server_seq_oserror() -> None:
    from unittest.mock import patch

    from podcast_mcp.services.document_sync.service import document_server_seq

    with patch(
        "podcast_mcp.services.document_sync.service.DocumentSyncService.open",
        side_effect=OSError("nope"),
    ):
        assert document_server_seq("/missing.json") == 0
