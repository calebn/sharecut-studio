from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from podcast_mcp.edits.transcript_timing import WordTimingTarget
from podcast_mcp.engines.waveform_media import collect_media_refs, track_media_refs
from podcast_mcp.gui.mapper import map_transcript_utterances_to_timeline
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import (
    MediaAsset,
    SourceRecording,
    Track,
    Transcript,
    TranscriptWord,
    load_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.errors import DocumentConflictError
from podcast_mcp.services.document_sync.payloads import validate_payload
from podcast_mcp.services.edit import EditService
from podcast_mcp.services.play import PlayService


@pytest.fixture
def timing_workspace(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    (ws.project.raw_dir() / "extra.wav").write_bytes(b"extra-recording")
    ws.project.tracks = [
        Track(
            id="host",
            label="Host",
            role="dialogue",
            media=MediaAsset(path="raw/host.wav", duration_sec=10, sample_rate=1000),
        )
    ]
    ws.project.sources = [
        SourceRecording(id="extra", path="raw/extra.wav", duration_sec=10, sample_rate=1000),
        SourceRecording(id="alias", path="raw/host.wav", duration_sec=10),
    ]
    ws.project.transcripts = [
        Transcript(
            track_id="host",
            source_id="extra",
            words=[TranscriptWord(text="same", start=1, end=2, ignored=True)],
        ),
        Transcript(track_id="host", words=[TranscriptWord(text="primary", start=1, end=2)]),
    ]
    ws.save()
    return ws


def timing_command(context, seq=1):
    return DocumentCommand(
        type="SetTranscriptWordTiming",
        payload={
            "target": context["target"],
            "expected_token": context["expected_token"],
            "start": 1.25,
            "end": 2.25,
        },
        client_id="host",
        role="host",
        client_seq=seq,
    )


def test_timing_command_audio_projection_stale_and_guest_denial(timing_workspace):
    ws = timing_workspace
    context = EditService(ws).word_timing_context(
        WordTimingTarget("host", "extra", 0), expected_text="same", expected_start=1, expected_end=2
    )
    service = DocumentSyncService.open(ws.path)
    with pytest.raises(PermissionError):
        service.submit(timing_command(context), capabilities=["edit", "suggest"])
    result = service.submit(timing_command(context))
    assert result["type"] == "Applied"
    assert result["snapshot"]["delta"]["projection"] == "transcript_audio"
    snapshot = service.document_snapshot(projection="transcript_audio")
    assert snapshot["state_token"] == result["snapshot"]["state_token"]
    assert {"tracks", "render_status", "transcript"} <= snapshot["patch"].keys()
    persisted = load_project(ws.path)
    assert persisted.transcripts[0].words[0].start == 1.25
    assert persisted.transcripts[1].words[0].start == 1
    with pytest.raises(DocumentConflictError):
        service.submit(timing_command(context, seq=2))


def test_context_route_validation_stale_missing_and_host_auth(timing_workspace, monkeypatch):
    ws = timing_workspace
    monkeypatch.setenv("PODCAST_SESSION_AUTHZ", "strict")
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", "owner")
    body = {
        "path": str(ws.path),
        "target": {"track_id": "host", "source_id": "extra", "word_index": 0},
        "expected_word": {"text": "same", "start": 1, "end": 2},
    }
    with TestClient(create_app(served_project=ws.path)) as client:
        assert client.post("/api/transcript/word-timing-context", json=body).status_code == 403
        headers = {"X-Podcast-Token": "owner"}
        response = client.post("/api/transcript/word-timing-context", json=body, headers=headers)
        assert response.status_code == 200
        assert response.json()["media"]["ref"] == "source:extra"
        body["expected_word"]["text"] = "old"
        assert (
            client.post(
                "/api/transcript/word-timing-context", json=body, headers=headers
            ).status_code
            == 409
        )
        body["expected_word"]["text"] = "same"
        (ws.project.raw_dir() / "extra.wav").unlink()
        assert (
            client.post(
                "/api/transcript/word-timing-context", json=body, headers=headers
            ).status_code
            == 404
        )
        del body["target"]["source_id"]
        assert (
            client.post(
                "/api/transcript/word-timing-context", json=body, headers=headers
            ).status_code
            == 422
        )


def test_raw_source_selection_range_and_nonraw_rejection(timing_workspace):
    ws = timing_workspace
    play = PlayService(ws)
    assert play.resolve_transport_path("raw", track_id="host").path.name == "host.wav"
    assert (
        play.resolve_transport_path("track", track_id="host", source_id="alias").path.name
        == "host.wav"
    )
    assert (
        play.resolve_transport_path("raw", track_id="host", source_id="extra").path.name
        == "extra.wav"
    )
    with pytest.raises(ValueError, match="only supported"):
        play.resolve_transport_path("stem", track_id="host", source_id="extra")
    with TestClient(create_app(served_project=ws.path)) as client:
        response = client.get(
            "/api/audio",
            params={"path": str(ws.path), "kind": "raw", "track_id": "host", "source_id": "extra"},
            headers={"Range": "bytes=0-4"},
        )
        assert response.status_code == 206
        assert response.content == b"extra"
        assert response.headers["content-range"] == "bytes 0-4/15"
        assert (
            client.get(
                "/api/audio", params={"path": str(ws.path), "kind": "premix", "source_id": "extra"}
            ).status_code
            == 400
        )


def test_mapper_provenance_and_unplaced_waveform_refs(timing_workspace):
    project = timing_workspace.project
    combined = {"utterances": [{"track_id": "host", "start": 1, "end": 2, "text": "same"}]}
    shown = map_transcript_utterances_to_timeline(project, combined)
    assert shown["utterances"][0]["words"][0]["timing_target"] == {
        "track_id": "host",
        "source_id": "extra",
        "word_index": 0,
    }
    project.transcripts[0].words[0].suppressed = True
    shown = map_transcript_utterances_to_timeline(project, {"utterances": []})
    assert shown["utterances"][0]["words"][0]["timing_target"]["source_id"] == "extra"
    assert "source:extra" in collect_media_refs(project).refs
    assert "source:extra" in track_media_refs(project, project.tracks[0]).refs
    project.transcripts[0].source_id = None
    project.transcripts = project.transcripts[:1]
    shown = map_transcript_utterances_to_timeline(project, {"utterances": []})
    assert shown["utterances"][0]["words"][0]["timing_target"]["source_id"] is None


def test_payload_requires_explicit_nullable_source():
    payload = {
        "target": {"track_id": "host", "word_index": 0},
        "expected_token": "token",
        "start": 1,
        "end": 2,
    }
    with pytest.raises(ValidationError):
        validate_payload("SetTranscriptWordTiming", payload)
    payload["target"]["source_id"] = None
    assert validate_payload("SetTranscriptWordTiming", payload)["target"]["source_id"] is None


def test_context_can_open_existing_negative_reversed_word(timing_workspace):
    ws = timing_workspace
    ws.project.transcripts[0].words[0].start = -1
    ws.project.transcripts[0].words[0].end = -2
    ws.save()
    with TestClient(create_app(served_project=ws.path)) as client:
        response = client.post(
            "/api/transcript/word-timing-context",
            json={
                "path": str(ws.path),
                "target": {"track_id": "host", "source_id": "extra", "word_index": 0},
                "expected_word": {"text": "same", "start": -1, "end": -2},
            },
        )
        assert response.status_code == 200
        assert response.json()["word"]["start"] == -1


def test_audio_source_containment_and_host_denial(timing_workspace, tmp_path, monkeypatch):
    ws = timing_workspace
    outside = tmp_path / "outside.wav"
    outside.write_bytes(b"outside")
    ws.project.sources[0].path = str(outside)
    ws.save()
    with pytest.raises(ValueError):
        PlayService(ws).resolve_transport_path("raw", track_id="host", source_id="extra")
    monkeypatch.setenv("PODCAST_SESSION_AUTHZ", "strict")
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", "owner")
    with TestClient(create_app(served_project=ws.path)) as client:
        params = {"path": str(ws.path), "kind": "raw", "track_id": "host", "source_id": "extra"}
        assert client.get("/api/audio", params=params).status_code == 403
        assert (
            client.get(
                "/api/audio", params=params, headers={"X-Podcast-Token": "owner"}
            ).status_code
            == 400
        )


def test_transcript_handlers_have_disjoint_complete_projections():
    from podcast_mcp.services.document_sync.handlers.transcript import HANDLERS
    from podcast_mcp.services.document_sync.projection_types import ViewProjection
    from podcast_mcp.services.document_sync.projections import (
        TRANSCRIPT_AUDIO_COMMANDS,
        TRANSCRIPT_WORD_COMMANDS,
        projection_for_command,
    )

    assert not TRANSCRIPT_AUDIO_COMMANDS & TRANSCRIPT_WORD_COMMANDS
    assert HANDLERS.keys() == TRANSCRIPT_AUDIO_COMMANDS | TRANSCRIPT_WORD_COMMANDS
    assert projection_for_command("SetTranscriptWordTiming") == ViewProjection.TRANSCRIPT_AUDIO
    assert projection_for_command("SetTranscriptWordsIgnored") == ViewProjection.TRANSCRIPT_AUDIO
    assert projection_for_command("CorrectTranscriptWord") == ViewProjection.DETAIL
