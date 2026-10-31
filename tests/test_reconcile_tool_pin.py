"""reconcile_transcript_tool keeps its replies, errors and effects (#1847)."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.mcp.tools import transcript as mcp_transcript
from podcast_mcp.mcp.tools.transcript import transcript_refine_waive_tool
from podcast_mcp.models import (
    Clip,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from test_bleed_suppress import _GUEST_TO_HOST_MEASURED, _fake_rms

_REPLY_KEYS = {"suppress", "unsuppress", "reattribute", "applied", "reconciliation"}


def _two_track_path(tmp_path: Path) -> str:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    project = load_project(Path(path))
    for tid, speaker in (("host", "Host"), ("guest", "Guest")):
        raw = project.workspace_path() / "raw" / f"{tid}.wav"
        raw.parent.mkdir(parents=True, exist_ok=True)
        raw.write_bytes(b"\x00" * 100)
        project.tracks.append(
            Track(
                id=tid,
                label=speaker,
                role=TrackRole.DIALOGUE,
                speaker=speaker,
                media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=10.0),
            )
        )
        project.clips.append(
            Clip(
                id=f"c-{tid}",
                track_id=tid,
                source_start=0.0,
                source_end=10.0,
                timeline_start=0.0,
            )
        )
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.5, confidence=0.9),
                TranscriptWord(
                    text="bleed",
                    start=1.0,
                    end=1.5,
                    confidence=0.9,
                    audibility_status="bleed",
                    dominant_track="guest",
                ),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[TranscriptWord(text="bleed", start=1.0, end=1.5, confidence=0.9)],
        ),
    ]
    project.combined_transcript = TranscriptionEngine(defaults=load_defaults()).merge_transcripts(
        project
    )
    save_project(project, Path(path))
    transcript_refine_waive_tool(path, "pin")
    return path


def _host_suppressed(path: str) -> list[bool]:
    transcript = load_project(Path(path)).transcript_for_track("host")
    assert transcript is not None
    return [w.suppressed for w in transcript.words]


@_GUEST_TO_HOST_MEASURED
def test_apply_suppresses_the_bleed_word_and_replies(tmp_path):
    path = _two_track_path(tmp_path)
    with patch("podcast_mcp.engines.audio_audit._rms_for_track_at_timeline", side_effect=_fake_rms):
        reply = json.loads(
            mcp_transcript.reconcile_transcript_tool(path, track_id="host", dry_run=False)
        )
    assert reply.keys() >= _REPLY_KEYS
    assert len(reply["suppress"]) == 1
    assert _host_suppressed(path) == [False, True]


@_GUEST_TO_HOST_MEASURED
def test_dry_run_reports_the_same_rows_and_changes_no_word(tmp_path):
    path = _two_track_path(tmp_path)
    with patch("podcast_mcp.engines.audio_audit._rms_for_track_at_timeline", side_effect=_fake_rms):
        reply = json.loads(
            mcp_transcript.reconcile_transcript_tool(path, track_id="host", dry_run=True)
        )
    assert reply.keys() >= _REPLY_KEYS
    assert len(reply["suppress"]) == 1
    assert _host_suppressed(path) == [False, False]


@_GUEST_TO_HOST_MEASURED
def test_time_range_limits_the_apply(tmp_path):
    path = _two_track_path(tmp_path)
    with patch("podcast_mcp.engines.audio_audit._rms_for_track_at_timeline", side_effect=_fake_rms):
        reply = json.loads(
            mcp_transcript.reconcile_transcript_tool(
                path, track_id="host", dry_run=False, start_sec=5.0, end_sec=6.0
            )
        )
    assert reply["suppress"] == []
    assert _host_suppressed(path) == [False, False]


def test_unknown_track_keeps_its_code(tmp_path):
    path = _two_track_path(tmp_path)
    with pytest.raises(ValueError) as caught:
        mcp_transcript.reconcile_transcript_tool(path, track_id="nope", dry_run=False)
    assert caught.value.code == "track_not_found"


def _history_total(path: str) -> int:
    from podcast_mcp.mcp.tools.history import history_status_tool

    return json.loads(history_status_tool(path))["total"]


@_GUEST_TO_HOST_MEASURED
@pytest.mark.parametrize("dry_run", [None, False])
def test_an_applying_run_journals_through_the_document_plane(tmp_path, dry_run):
    from podcast_mcp.services.document_sync import DocumentSyncService

    path = _two_track_path(tmp_path)
    with patch("podcast_mcp.engines.audio_audit._rms_for_track_at_timeline", side_effect=_fake_rms):
        mcp_transcript.reconcile_transcript_tool(path, track_id="host", dry_run=dry_run)
    types = [r["type"] for r in DocumentSyncService.open(path).store.commands_after(0)]
    assert types == ["ReconcileTranscript"]


@_GUEST_TO_HOST_MEASURED
def test_a_dry_run_is_read_only_and_never_journals(tmp_path):
    from podcast_mcp.services.document_sync import DocumentSyncService

    path = _two_track_path(tmp_path)
    before = _history_total(path)
    with patch("podcast_mcp.engines.audio_audit._rms_for_track_at_timeline", side_effect=_fake_rms):
        mcp_transcript.reconcile_transcript_tool(path, track_id="host", dry_run=True)
    assert DocumentSyncService.open(path).store.commands_after(0) == []
    assert _history_total(path) == before


def test_a_preview_cannot_be_submitted_as_a_command():
    from podcast_mcp.services.document_sync import validate_payload

    with pytest.raises(ValueError):
        validate_payload("ReconcileTranscript", {"dry_run": True})


def test_unknown_track_journals_nothing(tmp_path):
    from podcast_mcp.services.document_sync import DocumentSyncService

    path = _two_track_path(tmp_path)
    with pytest.raises(ValueError):
        mcp_transcript.reconcile_transcript_tool(path, track_id="nope", dry_run=False)
    assert DocumentSyncService.open(path).store.commands_after(0) == []
