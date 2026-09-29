"""Document-plane sync for comment, history, and edit commands."""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from threading import Event
from unittest.mock import patch

import jsonschema
import pytest
from fastapi.testclient import TestClient
from filelock import Timeout
from pydantic import ValidationError

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import (
    AutomationEnvelope,
    AutomationPoint,
    Clip,
    EditDecision,
    EditDecisionType,
    MediaAsset,
    ProjectStateSnapshot,
    SavedDocumentCommand,
    Track,
    TrackRole,
    load_project,
    save_project,
)
from podcast_mcp.project_merge import ProjectMergeConflict
from podcast_mcp.services import ProjectWorkspace
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.errors import (
    DocumentConflictError,
    DocumentSequenceConflictError,
)
from podcast_mcp.services.document_sync.handlers import apply_command
from podcast_mcp.services.document_sync.payloads import parse_document_command, validate_payload
from podcast_mcp.services.history import HistoryService
from podcast_mcp.services.session_sync.authz import authorize_client
from podcast_mcp.services.session_sync.hub import get_hub
from podcast_mcp.util.project_state import RenderBusyError
from sqlite_helpers import FailingConnection
from sync_helpers import _foreign_document_write


def test_document_add_comment_and_idempotent(minimal_project):
    svc = DocumentSyncService.open(minimal_project)
    cmd = DocumentCommand(
        type="AddComment",
        payload={
            "body": "Live note",
            "author": "viewer",
            "timeline_start": 2.5,
        },
        client_id="c1",
        role="viewer",
        client_seq=1,
    )
    result = svc.submit(cmd)
    assert result["ok"]
    assert result["type"] == "Applied"
    assert len(result["snapshot"]["comments"]) == 1
    assert result["snapshot"]["comments"][0]["body"] == "Live note"
    assert "history" in result["snapshot"]
    assert "can_undo" in result["snapshot"]["history"]
    assert "entries" not in result["snapshot"]["history"]
    groups = result["snapshot"]["history"]["groups"]
    assert groups
    assert any(
        g.get("kind") == "mutation"
        and "add comment" in str(g.get("title") or g.get("label") or "").lower()
        for g in groups
    )

    again = svc.submit(cmd)
    assert again.get("idempotent") is True
    assert len(again["snapshot"]["comments"]) == 1


def test_a_command_applies_on_top_of_a_change_saved_since_open(minimal_project):
    """Each request opens its own service; the later commit must not drop the
    earlier one by saving the copy it loaded before the lock."""
    first = DocumentSyncService.open(minimal_project)
    second = DocumentSyncService.open(minimal_project)

    def add(seq: int, body: str) -> DocumentCommand:
        return DocumentCommand(
            type="AddComment",
            payload={"body": body, "author": "viewer", "timeline_start": 1.0},
            client_id=f"c{seq}",
            role="viewer",
            client_seq=seq,
        )

    assert first.submit(add(1, "first"))["ok"]
    assert second.submit(add(2, "second"))["ok"]
    saved = ProjectWorkspace.open(minimal_project).project
    assert sorted(c.body for c in saved.review.comments) == ["first", "second"]


def test_document_reply_via_command(minimal_project):
    svc = DocumentSyncService.open(minimal_project)
    add = svc.submit(
        DocumentCommand(
            type="AddComment",
            payload={
                "body": "Parent",
                "author": "a",
                "timeline_start": 1.0,
            },
            client_id="c1",
            role="viewer",
            client_seq=1,
        )
    )
    cid = add["snapshot"]["comments"][0]["id"]
    reply = svc.submit(
        DocumentCommand(
            type="AddReply",
            payload={"comment_id": cid, "body": "Hi", "author": "b"},
            client_id="c1",
            role="viewer",
            client_seq=2,
        )
    )
    assert len(reply["snapshot"]["comments"][0]["replies"]) == 1


def _undoable_rejection(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.edit_decisions = [
        EditDecision(
            id="d1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1.0,
            end=2.0,
            reason="noise",
            applied=False,
        )
    ]
    ws.save()
    svc = DocumentSyncService.open(minimal_project)
    svc.submit(
        DocumentCommand(
            type="RejectEdits", payload={"ids": ["d1"]}, client_id="c1", role="viewer", client_seq=1
        )
    )
    return svc


@pytest.mark.parametrize("command", ["UndoHistory", "RedoHistory"])
def test_document_history_move_render_failure_is_a_conflict_with_the_advice(
    minimal_project, command
):
    svc = _undoable_rejection(minimal_project)
    if command == "RedoHistory":
        svc.submit(
            DocumentCommand(
                type="UndoHistory", payload={}, client_id="c1", role="viewer", client_seq=2
            )
        )

    def failing_render(_project):
        raise OSError("ffmpeg failed")

    with patch("podcast_mcp.services.history.rerender_preview", failing_render):
        with pytest.raises(
            DocumentConflictError, match="re-render the preview instead of repeating"
        ) as exc:
            svc.submit(
                DocumentCommand(
                    type=command,
                    payload={"rerender": True},
                    client_id="c1",
                    role="viewer",
                    client_seq=3,
                )
            )
    assert "ffmpeg failed" in str(exc.value)
    assert exc.value.conflict is True


def test_document_history_move_merge_conflict_is_a_conflict_with_the_advice(minimal_project):
    svc = _undoable_rejection(minimal_project)
    with patch("podcast_mcp.services.document_sync.handlers.history.HistoryService") as history:
        history.return_value.undo.side_effect = ProjectMergeConflict(["tracks[host].gain_db"])
        with pytest.raises(DocumentConflictError, match="re-run it"):
            svc.submit(
                DocumentCommand(
                    type="UndoHistory",
                    payload={"rerender": True},
                    client_id="c1",
                    role="viewer",
                    client_seq=2,
                )
            )


def test_document_undo_redo_history(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.edit_decisions = [
        EditDecision(
            id="d1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1.0,
            end=2.0,
            reason="noise",
            applied=False,
        )
    ]
    ws.save()

    svc = DocumentSyncService.open(minimal_project)
    rejected = svc.submit(
        DocumentCommand(
            type="RejectEdits",
            payload={"ids": ["d1"]},
            client_id="c1",
            role="viewer",
            client_seq=1,
        )
    )
    assert rejected["ok"]
    assert rejected["snapshot"]["history"]["can_undo"] is True

    undo = svc.submit(
        DocumentCommand(
            type="UndoHistory",
            payload={},
            client_id="c1",
            role="viewer",
            client_seq=2,
        )
    )
    assert undo["ok"]
    assert undo["snapshot"]["history"]["can_redo"] is True
    ws_after_undo = ProjectWorkspace.open(minimal_project)
    assert any(e.id == "d1" for e in ws_after_undo.project.edit_decisions)

    again = svc.submit(
        DocumentCommand(
            type="UndoHistory",
            payload={},
            client_id="c1",
            role="viewer",
            client_seq=2,
        )
    )
    assert again.get("idempotent") is True

    redo = svc.submit(
        DocumentCommand(
            type="RedoHistory",
            payload={},
            client_id="c1",
            role="viewer",
            client_seq=3,
        )
    )
    assert redo["snapshot"]["history"]["can_undo"] is True
    ws_after_redo = ProjectWorkspace.open(minimal_project)
    assert not any(e.id == "d1" for e in ws_after_redo.project.edit_decisions)


def test_document_reject_and_approve_edits(minimal_project):
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
    ws.project.edit_decisions = [
        EditDecision(
            id="d-reject",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1.0,
            end=2.0,
            reason="noise",
            applied=False,
        ),
        EditDecision(
            id="d-approve",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=3.0,
            end=4.0,
            reason="filler",
            applied=False,
        ),
    ]
    ws.save()

    svc = DocumentSyncService.open(minimal_project)
    rejected = svc.submit(
        DocumentCommand(
            type="RejectEdits",
            payload={"ids": ["d-reject"]},
            client_id="c1",
            role="viewer",
            client_seq=1,
        )
    )
    assert rejected["ok"]
    assert rejected["command"]["payload"]["result"]["count"] == 1

    approved = svc.submit(
        DocumentCommand(
            type="ApproveEdits",
            payload={"ids": ["d-approve"]},
            client_id="c1",
            role="viewer",
            client_seq=2,
        )
    )
    assert approved["ok"]
    assert approved["command"]["payload"]["result"]["count"] == 1

    ws2 = ProjectWorkspace.open(minimal_project)
    ids = {e.id for e in ws2.project.edit_decisions}
    assert "d-reject" not in ids
    assert "d-approve" not in ids


def test_document_update_pending_and_restore(minimal_project):
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
    ws.project.edit_decisions = [
        EditDecision(
            id="d1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=2.0,
            end=4.0,
            reason="cut",
            applied=False,
        )
    ]
    ws.save()

    svc = DocumentSyncService.open(minimal_project)
    nudged = svc.submit(
        DocumentCommand(
            type="UpdatePendingEdit",
            payload={"id": "d1", "start": 2.1, "end": 3.9, "snap": False},
            client_id="c1",
            role="viewer",
            client_seq=1,
        )
    )
    assert nudged["ok"]
    assert nudged["command"]["payload"]["result"]["edit"]["start"] == 2.1

    approved = svc.submit(
        DocumentCommand(
            type="ApproveEdits",
            payload={"ids": ["d1"]},
            client_id="c1",
            role="viewer",
            client_seq=2,
        )
    )
    assert approved["ok"]
    ws2 = ProjectWorkspace.open(minimal_project)
    assert len(ws2.project.editorial.edit_log) == 1
    rid = ws2.project.editorial.edit_log[0].id

    restored = svc.submit(
        DocumentCommand(
            type="RestoreAppliedEdit",
            payload={"id": rid},
            client_id="c1",
            role="viewer",
            client_seq=3,
        )
    )
    assert restored["ok"]
    ws3 = ProjectWorkspace.open(minimal_project)
    assert ws3.project.editorial.edit_log == []
    assert HistoryService(ws3).status()["can_undo"]


def test_document_set_clip_fade_join_and_recommendations(minimal_project):
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
            source_end=5.0,
            timeline_start=0.0,
            fade_out_ms=0,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=5.0,
            source_end=10.0,
            timeline_start=5.0,
            fade_in_ms=0,
        ),
    ]
    ws.save()

    svc = DocumentSyncService.open(minimal_project)
    faded = svc.submit(
        DocumentCommand(
            type="SetClipFade",
            payload={"clip_id": "c2", "fade_in_ms": 40, "fade_out_ms": 8},
            client_id="c1",
            role="viewer",
            client_seq=1,
        )
    )
    assert faded["ok"]
    fade_snap = faded["snapshot"]
    assert "project" not in fade_snap
    assert fade_snap["patch"]["clips"]["tracks"]["host"][1]["fade_in_ms"] == 40
    assert "render_status" in fade_snap["patch"]
    assert "tracks" in fade_snap["patch"]
    ws2 = ProjectWorkspace.open(minimal_project)
    c2 = next(c for c in ws2.project.clips if c.id == "c2")
    assert c2.fade_in_ms == 40  # dialogue cap (render.join_fade_max_ms)
    assert c2.fade_out_ms == 8

    joined = svc.submit(
        DocumentCommand(
            type="SetJoinMode",
            payload={"clip_id": "c2", "join_in_mode": "crossfade"},
            client_id="c1",
            role="viewer",
            client_seq=2,
        )
    )
    assert joined["ok"]
    join_snap = joined["snapshot"]
    assert "project" not in join_snap
    assert join_snap["patch"]["clips"]["tracks"]["host"][1]["join_in_mode"] == "crossfade"
    assert "render_status" in join_snap["patch"]
    ws3 = ProjectWorkspace.open(minimal_project)
    assert next(c for c in ws3.project.clips if c.id == "c2").join_in_mode.value == ("crossfade")

    applied = svc.submit(
        DocumentCommand(
            type="ApplyFadeRecommendations",
            payload={"track_id": "host"},
            client_id="c1",
            role="viewer",
            client_seq=3,
        )
    )
    assert applied["ok"]
    rec_snap = applied["snapshot"]
    assert "project" not in rec_snap
    assert "clips" in rec_snap["patch"]
    assert "applied_fade_updates" in applied["command"]["payload"]["result"]
    assert HistoryService(ProjectWorkspace.open(minimal_project)).status()["can_undo"]


def test_document_set_effect_bypass(minimal_project):
    from podcast_mcp.models import ProcessingChain, ProcessingEffect

    ws = ProjectWorkspace.open(minimal_project)
    ws.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    ws.project.mix.processing_chains = [
        ProcessingChain(
            track_id="host",
            effects=[
                ProcessingEffect(effect="highpass", params={"frequency": 80}),
                ProcessingEffect(effect="agate", params={"threshold_db": -30}),
            ],
        )
    ]
    ws.save()

    svc = DocumentSyncService.open(minimal_project)
    out = svc.submit(
        DocumentCommand(
            type="SetEffectBypass",
            payload={"track_id": "host", "effect_index": 1, "bypass": True},
            client_id="c1",
            role="viewer",
            client_seq=1,
        )
    )
    assert out["ok"]
    fx_snap = out["snapshot"]
    assert "project" not in fx_snap
    assert fx_snap["patch"]["effects_by_track"]["host"][1]["bypass"] is True
    assert "render_status" in fx_snap["patch"]
    assert "tracks" in fx_snap["patch"]
    ws2 = ProjectWorkspace.open(minimal_project)
    effects = ws2.project.processing_chains[0].effects
    assert len(effects) == 2
    assert effects[0].bypass is False
    assert effects[1].bypass is True
    assert HistoryService(ws2).status()["can_undo"]


def _seed_host_words(project_path, texts):
    """Seed a ``host`` track with a transcript of ``texts``, words 0.5s apart (#650)."""
    from podcast_mcp.models import Transcript, TranscriptWord

    ws = ProjectWorkspace.open(project_path)
    ws.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    ws.project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text=text, start=i * 0.5, end=i * 0.5 + 0.4, confidence=0.9)
                for i, text in enumerate(texts)
            ],
        )
    ]
    ws.save()
    return ws


def test_document_correct_transcript_word_rejects_stale_expected_text(minimal_project):
    _seed_host_words(minimal_project, ["teh", "quick", "fox"])
    svc = DocumentSyncService.open(minimal_project)
    seq_before = svc.store.get_snapshot()
    history_before = HistoryService(ProjectWorkspace.open(minimal_project)).list_entries()

    with pytest.raises(DocumentConflictError, match="changed since you read it"):
        svc.submit(
            DocumentCommand(
                type="CorrectTranscriptWord",
                payload={
                    "track_id": "host",
                    "word_index": 0,
                    "text": "the",
                    "expected_text": "the",
                },
                client_id="c1",
                role="viewer",
                client_seq=1,
            )
        )

    ws_after = ProjectWorkspace.open(minimal_project)
    assert ws_after.project.transcripts[0].words[0].text == "teh"
    assert ws_after.project.transcripts[0].words[0].confidence == 0.9
    assert svc.store.get_snapshot() == seq_before
    assert HistoryService(ws_after).list_entries() == history_before

    applied = svc.submit(
        DocumentCommand(
            type="CorrectTranscriptWord",
            payload={
                "track_id": "host",
                "word_index": 0,
                "text": "the",
                "expected_text": "teh",
            },
            client_id="c1",
            role="viewer",
            client_seq=2,
        )
    )
    assert applied["ok"]
    assert ProjectWorkspace.open(minimal_project).project.transcripts[0].words[0].text == "the"


def test_document_correct_transcript_phrase_rejects_stale_expected_text(minimal_project):
    _seed_host_words(minimal_project, ["the", "quick", "fox"])
    svc = DocumentSyncService.open(minimal_project)
    seq_before = svc.store.get_snapshot()
    history_before = HistoryService(ProjectWorkspace.open(minimal_project)).list_entries()

    with pytest.raises(DocumentConflictError, match="changed since you read"):
        svc.submit(
            DocumentCommand(
                type="CorrectTranscriptPhrase",
                payload={
                    "track_id": "host",
                    "start_word_index": 1,
                    "end_word_index": 2,
                    "text": "brown dog",
                    "expected_text": "quick dog",
                },
                client_id="c1",
                role="viewer",
                client_seq=1,
            )
        )

    ws_after = ProjectWorkspace.open(minimal_project)
    texts_after = [w.text for w in ws_after.project.transcripts[0].words]
    assert texts_after == ["the", "quick", "fox"]
    assert svc.store.get_snapshot() == seq_before
    assert HistoryService(ws_after).list_entries() == history_before

    applied = svc.submit(
        DocumentCommand(
            type="CorrectTranscriptPhrase",
            payload={
                "track_id": "host",
                "start_word_index": 1,
                "end_word_index": 2,
                "text": "brown dog",
                "expected_text": "quick  fox",
            },
            client_id="c1",
            role="viewer",
            client_seq=2,
        )
    )
    assert applied["ok"]
    texts_final = [
        w.text for w in ProjectWorkspace.open(minimal_project).project.transcripts[0].words
    ]
    assert "brown" in texts_final
    assert "dog" in texts_final


def test_document_correct_transcript_without_expected_text_keeps_behavior(minimal_project):
    _seed_host_words(minimal_project, ["the", "quick", "brown", "fox"])
    svc = DocumentSyncService.open(minimal_project)

    phrase = svc.submit(
        DocumentCommand(
            type="CorrectTranscriptPhrase",
            payload={
                "track_id": "host",
                "start_word_index": 1,
                "end_word_index": 2,
                "text": "very quick",
            },
            client_id="c1",
            role="viewer",
            client_seq=1,
        )
    )
    assert phrase["ok"]

    unguarded = svc.submit(
        DocumentCommand(
            type="CorrectTranscriptWord",
            payload={"track_id": "host", "word_index": 0, "text": "The"},
            client_id="c1",
            role="viewer",
            client_seq=2,
        )
    )
    assert unguarded["ok"]
    assert ProjectWorkspace.open(minimal_project).project.transcripts[0].words[0].text == "The"

    assert (
        validate_payload(
            "CorrectTranscriptWord",
            {"track_id": "host", "word_index": 0, "text": "The"},
        )["expected_text"]
        is None
    )


def test_http_stale_word_correction_returns_409(minimal_project):
    _seed_host_words(minimal_project, ["teh", "quick", "fox"])
    client = TestClient(create_app())
    path = str(minimal_project)

    def post(expected_text):
        return client.post(
            "/api/document/command",
            params={"path": path},
            json={
                "type": "CorrectTranscriptWord",
                "payload": {
                    "track_id": "host",
                    "word_index": 0,
                    "text": "the",
                    "expected_text": expected_text,
                },
                "client_id": "v1",
                "role": "viewer",
                "client_seq": 1,
            },
        )

    response = post("the")
    assert response.status_code == 409
    assert response.json()["detail"]["conflict"] is True


def test_http_correction_past_shrunk_transcript_returns_409(minimal_project):
    _seed_host_words(minimal_project, ["teh", "quick"])
    client = TestClient(create_app())
    response = client.post(
        "/api/document/command",
        params={"path": str(minimal_project)},
        json={
            "type": "CorrectTranscriptWord",
            "payload": {"track_id": "host", "word_index": 2, "text": "fox", "expected_text": "fox"},
            "client_id": "v1",
            "role": "viewer",
            "client_seq": 1,
        },
    )
    assert response.status_code == 409
    assert response.json()["detail"]["conflict"] is True


def test_concurrent_guarded_corrections_apply_exactly_one(minimal_project):
    """Two writers race one guarded correction; check and mutate share one lock (#650)."""
    import threading

    from podcast_mcp.edits.transcript_correct import TranscriptTextChangedError
    from podcast_mcp.services.edit import EditService

    _seed_host_words(minimal_project, ["teh", "quick", "fox"])
    barrier = threading.Barrier(2)

    def correct(text: str) -> str:
        ws = ProjectWorkspace.open(minimal_project)
        barrier.wait(timeout=10)
        try:
            EditService(ws).correct_word("host", 0, text, expected_text="teh")
        except TranscriptTextChangedError:
            return "conflict"
        return text

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(correct, ["the", "tea"]))

    assert outcomes.count("conflict") == 1
    winner = next(o for o in outcomes if o != "conflict")
    saved = ProjectWorkspace.open(minimal_project).project.transcripts[0].words[0].text
    assert saved == winner


@pytest.mark.parametrize("kind", ["set_word_suppressed", "set_words_ignored"])
def test_concurrent_guarded_toggle_and_correction_apply_consistently(minimal_project, kind):
    """A guarded toggle racing a guarded correction on the same word loses no update (#744).

    A toggle never changes the word text, so it can't invalidate the correction's guard:
    the correction always applies and a stale toggle save must not revert its text. The
    toggle applies or conflicts depending on who wins, and the persisted flag matches.
    A check-then-act split is indistinguishable here from the toggle winning; the
    shared critical section is pinned by
    ``test_guarded_correction_check_and_edit_share_one_outer_transaction``.
    """
    import threading

    from podcast_mcp.edits.transcript_correct import TranscriptTextChangedError
    from podcast_mcp.services.edit import EditService

    _seed_host_words(minimal_project, ["teh", "quick", "fox"])
    barrier = threading.Barrier(2)

    def run_correction() -> str:
        ws = ProjectWorkspace.open(minimal_project)
        barrier.wait(timeout=10)
        try:
            EditService(ws).correct_word("host", 0, "the", expected_text="teh")
        except TranscriptTextChangedError:
            return "conflict"
        return "applied"

    def run_toggle() -> str:
        ws = ProjectWorkspace.open(minimal_project)
        barrier.wait(timeout=10)
        svc = EditService(ws)
        try:
            if kind == "set_word_suppressed":
                svc.set_word_suppressed("host", 0, True, expected_text="teh")
            else:
                svc.set_words_ignored("host", 0, 0, True, expected_text="teh")
        except TranscriptTextChangedError:
            return "conflict"
        return "applied"

    with ThreadPoolExecutor(max_workers=2) as pool:
        correction_future = pool.submit(run_correction)
        toggle_future = pool.submit(run_toggle)
        correction_outcome = correction_future.result(timeout=10)
        toggle_outcome = toggle_future.result(timeout=10)

    assert correction_outcome == "applied"
    word = ProjectWorkspace.open(minimal_project).project.transcripts[0].words[0]
    assert word.text == "the"
    if kind == "set_word_suppressed":
        assert word.suppressed == (toggle_outcome == "applied")
    else:
        assert word.ignored == (toggle_outcome == "applied")


@pytest.mark.parametrize(
    "kind", ["correct_word", "correct_phrase", "set_word_suppressed", "set_words_ignored"]
)
def test_guarded_correction_check_and_edit_share_one_outer_transaction(
    minimal_project, monkeypatch, kind
):
    """The stale-text check and the mutation run inside one outer transaction, for every
    guarded transcript edit (#650, #742, #744)."""
    import podcast_mcp.services.edit as edit_mod
    from podcast_mcp.services.edit import EditService

    _seed_host_words(minimal_project, ["teh", "quikc", "fox"])
    ws = ProjectWorkspace.open(minimal_project)
    events: list[tuple[str, int]] = []

    orig_adopt = ws._adopt_saved_if_changed_locked

    def spy_adopt() -> None:
        events.append(("outer", ws._transaction_depth))
        return orig_adopt()

    monkeypatch.setattr(ws, "_adopt_saved_if_changed_locked", spy_adopt)

    orig_require = edit_mod.require_word_text

    def spy_require(*args, **kwargs):
        events.append(("check", ws._transaction_depth))
        return orig_require(*args, **kwargs)

    monkeypatch.setattr(edit_mod, "require_word_text", spy_require)

    for name in ("correct_word", "correct_phrase", "set_word_suppressed", "set_words_ignored"):
        orig_edit = getattr(edit_mod, name)

        def spy_edit(*args, _orig_edit=orig_edit, **kwargs):
            events.append(("edit", ws._transaction_depth))
            return _orig_edit(*args, **kwargs)

        monkeypatch.setattr(edit_mod, name, spy_edit)

    svc = EditService(ws)
    if kind == "correct_word":
        svc.correct_word("host", 0, "the", expected_text="teh")
    elif kind == "correct_phrase":
        svc.correct_phrase("host", 0, 1, "the quick", expected_text="teh quikc")
    elif kind == "set_word_suppressed":
        svc.set_word_suppressed("host", 0, True, expected_text="teh")
    else:
        svc.set_words_ignored("host", 0, 1, True, expected_text="teh quikc")

    assert events == [("outer", 0), ("check", 1), ("edit", 2)]
    words = ProjectWorkspace.open(minimal_project).project.transcripts[0].words
    if kind in ("correct_word", "correct_phrase"):
        assert words[0].text == "the"
    elif kind == "set_word_suppressed":
        assert words[0].suppressed is True
    else:
        assert words[0].ignored is True
        assert words[1].ignored is True


def test_apply_maps_stale_target_errors_to_conflict():
    from podcast_mcp.edits.transcript_correct import TranscriptTextChangedError
    from podcast_mcp.services.document_sync.service import STALE_TARGET_ERRORS

    assert TranscriptTextChangedError in STALE_TARGET_ERRORS


def test_document_set_word_suppressed_rejects_stale_expected_text(minimal_project):
    _seed_host_words(minimal_project, ["teh", "quick", "fox"])
    svc = DocumentSyncService.open(minimal_project)
    seq_before = svc.store.get_snapshot()
    history_before = HistoryService(ProjectWorkspace.open(minimal_project)).list_entries()

    with pytest.raises(DocumentConflictError, match="changed since you read it"):
        svc.submit(
            DocumentCommand(
                type="SetTranscriptWordSuppressed",
                payload={
                    "track_id": "host",
                    "word_index": 0,
                    "suppressed": True,
                    "expected_text": "the",
                },
                client_id="c1",
                role="viewer",
                client_seq=1,
            )
        )

    ws_after = ProjectWorkspace.open(minimal_project)
    assert ws_after.project.transcripts[0].words[0].suppressed is False
    assert svc.store.get_snapshot() == seq_before
    assert HistoryService(ws_after).list_entries() == history_before

    applied = svc.submit(
        DocumentCommand(
            type="SetTranscriptWordSuppressed",
            payload={
                "track_id": "host",
                "word_index": 0,
                "suppressed": True,
                "expected_text": "teh",
            },
            client_id="c1",
            role="viewer",
            client_seq=2,
        )
    )
    assert applied["ok"]
    assert ProjectWorkspace.open(minimal_project).project.transcripts[0].words[0].suppressed is True


def test_document_set_words_ignored_rejects_stale_expected_text(minimal_project):
    _seed_host_words(minimal_project, ["the", "quick", "fox"])
    svc = DocumentSyncService.open(minimal_project)
    seq_before = svc.store.get_snapshot()
    history_before = HistoryService(ProjectWorkspace.open(minimal_project)).list_entries()

    with pytest.raises(DocumentConflictError, match="changed since you read"):
        svc.submit(
            DocumentCommand(
                type="SetTranscriptWordsIgnored",
                payload={
                    "track_id": "host",
                    "start_word_index": 1,
                    "end_word_index": 2,
                    "ignored": True,
                    "expected_text": "quick dog",
                },
                client_id="c1",
                role="viewer",
                client_seq=1,
            )
        )

    ws_after = ProjectWorkspace.open(minimal_project)
    assert not any(w.ignored for w in ws_after.project.transcripts[0].words)
    assert svc.store.get_snapshot() == seq_before
    assert HistoryService(ws_after).list_entries() == history_before

    applied = svc.submit(
        DocumentCommand(
            type="SetTranscriptWordsIgnored",
            payload={
                "track_id": "host",
                "start_word_index": 1,
                "end_word_index": 2,
                "ignored": True,
                "expected_text": "quick fox",
            },
            client_id="c1",
            role="viewer",
            client_seq=2,
        )
    )
    assert applied["ok"]
    words_after = ProjectWorkspace.open(minimal_project).project.transcripts[0].words
    assert words_after[1].ignored is True
    assert words_after[2].ignored is True


def test_document_suppress_and_ignore_without_expected_text_keep_behavior(minimal_project):
    _seed_host_words(minimal_project, ["the", "quick", "fox"])
    svc = DocumentSyncService.open(minimal_project)

    suppressed = svc.submit(
        DocumentCommand(
            type="SetTranscriptWordSuppressed",
            payload={"track_id": "host", "word_index": 0, "suppressed": True},
            client_id="c1",
            role="viewer",
            client_seq=1,
        )
    )
    assert suppressed["ok"]
    assert ProjectWorkspace.open(minimal_project).project.transcripts[0].words[0].suppressed is True

    ignored = svc.submit(
        DocumentCommand(
            type="SetTranscriptWordsIgnored",
            payload={
                "track_id": "host",
                "start_word_index": 1,
                "end_word_index": 1,
                "ignored": True,
            },
            client_id="c1",
            role="viewer",
            client_seq=2,
        )
    )
    assert ignored["ok"]
    assert ProjectWorkspace.open(minimal_project).project.transcripts[0].words[1].ignored is True

    assert (
        validate_payload(
            "SetTranscriptWordSuppressed",
            {"track_id": "host", "word_index": 0, "suppressed": True},
        )["expected_text"]
        is None
    )
    assert (
        validate_payload(
            "SetTranscriptWordsIgnored",
            {"track_id": "host", "start_word_index": 1, "end_word_index": 1, "ignored": True},
        )["expected_text"]
        is None
    )


def test_http_stale_word_suppressed_returns_409(minimal_project):
    _seed_host_words(minimal_project, ["teh", "quick", "fox"])
    client = TestClient(create_app())
    response = client.post(
        "/api/document/command",
        params={"path": str(minimal_project)},
        json={
            "type": "SetTranscriptWordSuppressed",
            "payload": {
                "track_id": "host",
                "word_index": 0,
                "suppressed": True,
                "expected_text": "the",
            },
            "client_id": "v1",
            "role": "viewer",
            "client_seq": 1,
        },
    )
    assert response.status_code == 409
    assert response.json()["detail"]["conflict"] is True
    assert (
        ProjectWorkspace.open(minimal_project).project.transcripts[0].words[0].suppressed is False
    )


def test_document_correct_and_suppress_transcript(minimal_project):
    from podcast_mcp.models import Transcript, TranscriptWord

    ws = ProjectWorkspace.open(minimal_project)
    ws.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    ws.project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="teh", start=0.0, end=0.4, confidence=0.3),
                TranscriptWord(text="quick", start=0.5, end=0.9, confidence=0.9),
                TranscriptWord(text="fox", start=1.0, end=1.4, confidence=0.9),
            ],
        )
    ]
    ws.save()

    svc = DocumentSyncService.open(minimal_project)
    corrected = svc.submit(
        DocumentCommand(
            type="CorrectTranscriptWord",
            payload={"track_id": "host", "word_index": 0, "text": "the"},
            client_id="c1",
            role="viewer",
            client_seq=1,
        )
    )
    assert corrected["ok"]
    corr_snap = corrected["snapshot"]
    assert "project" not in corr_snap
    assert corr_snap["patch"]["meta"]["hydration"]["transcript_words"] is True
    ws2 = ProjectWorkspace.open(minimal_project)
    w0 = ws2.project.transcripts[0].words[0]
    assert w0.text == "the"
    assert w0.confidence == 1.0
    assert HistoryService(ws2).status()["can_undo"]

    phrase = svc.submit(
        DocumentCommand(
            type="CorrectTranscriptPhrase",
            payload={
                "track_id": "host",
                "start_word_index": 1,
                "end_word_index": 2,
                "text": "brown dog",
            },
            client_id="c1",
            role="viewer",
            client_seq=2,
        )
    )
    assert phrase["ok"]
    ws3 = ProjectWorkspace.open(minimal_project)
    texts = [w.text for w in ws3.project.transcripts[0].words]
    assert texts[0] == "the"
    assert "brown" in texts
    assert "dog" in texts

    suppressed = svc.submit(
        DocumentCommand(
            type="SetTranscriptWordSuppressed",
            payload={"track_id": "host", "word_index": 0, "suppressed": True},
            client_id="c1",
            role="viewer",
            client_seq=3,
        )
    )
    assert suppressed["ok"]
    ws4 = ProjectWorkspace.open(minimal_project)
    assert ws4.project.transcripts[0].words[0].suppressed is True
    assert ws4.project.combined_transcript is not None

    unsuppressed = svc.submit(
        DocumentCommand(
            type="SetTranscriptWordSuppressed",
            payload={"track_id": "host", "word_index": 0, "suppressed": False},
            client_id="c1",
            role="viewer",
            client_seq=4,
        )
    )
    assert unsuppressed["ok"]
    ws5 = ProjectWorkspace.open(minimal_project)
    assert ws5.project.transcripts[0].words[0].suppressed is False
    assert HistoryService(ws5).status()["can_undo"]


def test_document_suppress_edge_word_stays_in_detail_patch_and_unsuppresses(minimal_project):
    """A suppressed utterance-edge word keeps its chip in the DETAIL transcript patch,
    and unsuppressing it brings the word back into the combined utterance text (#752)."""
    _seed_host_words(minimal_project, ["welcome", "to", "the", "show"])
    svc = DocumentSyncService.open(minimal_project)

    suppressed = svc.submit(
        DocumentCommand(
            type="SetTranscriptWordSuppressed",
            payload={
                "track_id": "host",
                "word_index": 0,
                "suppressed": True,
                "expected_text": "welcome",
            },
            client_id="c1",
            role="viewer",
            client_seq=1,
        )
    )
    assert suppressed["ok"]
    patch = suppressed["snapshot"]["patch"]
    utterance = patch["transcript"]["utterances"][0]
    assert utterance["text"] == "to the show"
    words = utterance["words"]
    assert words[0]["text"] == "welcome"
    assert words[0]["suppressed"] is True
    assert words[0]["word_index"] == 0
    assert utterance["edge_suppressed_word_indices"] == [0]

    unsuppressed = svc.submit(
        DocumentCommand(
            type="SetTranscriptWordSuppressed",
            payload={
                "track_id": "host",
                "word_index": 0,
                "suppressed": False,
                "expected_text": "welcome",
            },
            client_id="c1",
            role="viewer",
            client_seq=2,
        )
    )
    assert unsuppressed["ok"]
    patch2 = unsuppressed["snapshot"]["patch"]
    utterance2 = patch2["transcript"]["utterances"][0]
    assert utterance2["text"] == "welcome to the show"
    assert utterance2["words"][0]["suppressed"] is False
    assert "edge_suppressed_word_indices" not in utterance2


def test_document_suppress_every_word_keeps_suppressed_only_row_and_unsuppresses(minimal_project):
    """Suppressing every word on a track leaves a view-only suppressed_only row, and
    unsuppressing one word turns it back into a real row with an edge chip (#758)."""
    _seed_host_words(minimal_project, ["um", "uh"])
    svc = DocumentSyncService.open(minimal_project)

    svc.submit(
        DocumentCommand(
            type="SetTranscriptWordSuppressed",
            payload={
                "track_id": "host",
                "word_index": 0,
                "suppressed": True,
                "expected_text": "um",
            },
            client_id="c1",
            role="viewer",
            client_seq=1,
        )
    )
    suppressed = svc.submit(
        DocumentCommand(
            type="SetTranscriptWordSuppressed",
            payload={
                "track_id": "host",
                "word_index": 1,
                "suppressed": True,
                "expected_text": "uh",
            },
            client_id="c1",
            role="viewer",
            client_seq=2,
        )
    )
    assert suppressed["ok"]
    patch = suppressed["snapshot"]["patch"]
    utterances = patch["transcript"]["utterances"]
    assert len(utterances) == 1
    utterance = utterances[0]
    assert utterance["suppressed_only"] is True
    assert utterance["text"] == "um uh"
    assert [w["word_index"] for w in utterance["words"]] == [0, 1]
    assert all(w["suppressed"] for w in utterance["words"])

    unsuppressed = svc.submit(
        DocumentCommand(
            type="SetTranscriptWordSuppressed",
            payload={
                "track_id": "host",
                "word_index": 0,
                "suppressed": False,
                "expected_text": "um",
            },
            client_id="c1",
            role="viewer",
            client_seq=3,
        )
    )
    assert unsuppressed["ok"]
    patch2 = unsuppressed["snapshot"]["patch"]
    utterance2 = patch2["transcript"]["utterances"][0]
    assert utterance2["text"] == "um"
    assert "suppressed_only" not in utterance2
    assert utterance2["edge_suppressed_word_indices"] == [1]


def test_document_set_transcript_words_ignored(minimal_project):
    from podcast_mcp.models import Transcript, TranscriptWord
    from podcast_mcp.services.document_sync.capabilities import document_command_types_for_caps

    ws = ProjectWorkspace.open(minimal_project)
    ws.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    ws.project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="so", start=0.0, end=0.4, confidence=0.9),
                TranscriptWord(text="um", start=0.5, end=0.9, confidence=0.9),
            ],
        )
    ]
    ws.save()

    svc = DocumentSyncService.open(minimal_project)
    ignored = svc.submit(
        DocumentCommand(
            type="SetTranscriptWordsIgnored",
            payload={
                "track_id": "host",
                "start_word_index": 0,
                "end_word_index": 1,
                "ignored": True,
            },
            client_id="c1",
            role="viewer",
            client_seq=1,
        )
    )
    assert ignored["ok"]
    patch = ignored["snapshot"]["patch"]
    words = patch["transcript"]["utterances"][0]["words"]
    assert all(w["ignored"] is True for w in words)
    assert "tracks" in patch
    assert "render_status" in patch

    ws2 = ProjectWorkspace.open(minimal_project)
    assert all(w.ignored for w in ws2.project.transcripts[0].words)
    assert HistoryService(ws2).status()["can_undo"]

    restored = svc.submit(
        DocumentCommand(
            type="SetTranscriptWordsIgnored",
            payload={
                "track_id": "host",
                "start_word_index": 0,
                "end_word_index": 1,
                "ignored": False,
            },
            client_id="c1",
            role="viewer",
            client_seq=2,
        )
    )
    assert restored["ok"]
    ws3 = ProjectWorkspace.open(minimal_project)
    assert not any(w.ignored for w in ws3.project.transcripts[0].words)

    assert "SetTranscriptWordsIgnored" not in document_command_types_for_caps(["edit"])


def test_document_markers_envelope_and_suggest(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    ws.save()

    svc = DocumentSyncService.open(minimal_project)
    ch = svc.submit(
        DocumentCommand(
            type="AddChapter",
            payload={"time": 2.0, "title": "Intro"},
            client_id="c1",
            role="viewer",
            client_seq=1,
        )
    )
    assert ch["ok"]
    moved = svc.submit(
        DocumentCommand(
            type="UpdateChapter",
            payload={
                "old_time": 2.0,
                "old_title": "Intro",
                "time": 3.5,
                "title": "Intro",
            },
            client_id="c1",
            role="viewer",
            client_seq=2,
        )
    )
    assert moved["ok"]
    ws2 = ProjectWorkspace.open(minimal_project)
    assert ws2.project.chapters[0].time == pytest.approx(3.5)

    env = svc.submit(
        DocumentCommand(
            type="SetEnvelope",
            payload={
                "track_id": "host",
                "points": [
                    {"id": "intro", "time": 0.0, "value": 1.0},
                    {"id": "outro", "time": 5.0, "value": 0.5},
                ],
                "expected_points": [],
            },
            client_id="c1",
            role="viewer",
            client_seq=3,
        )
    )
    assert env["ok"]
    env_snap = env["snapshot"]
    assert "project" not in env_snap
    assert len(env_snap["patch"]["envelopes"]) == 1
    assert "render_status" in env_snap["patch"]
    ws3 = ProjectWorkspace.open(minimal_project)
    assert len(ws3.project.automation_envelopes[0].points) == 2
    assert [point.id for point in ws3.project.automation_envelopes[0].points] == [
        "intro",
        "outro",
    ]

    social = svc.submit(
        DocumentCommand(
            type="AddSocialClip",
            payload={
                "track_id": "host",
                "start": 1.0,
                "end": 4.0,
                "title": "Hook",
            },
            client_id="c1",
            role="viewer",
            client_seq=4,
        )
    )
    assert social["ok"]
    clip_id = social["command"]["payload"]["result"]["id"]
    updated = svc.submit(
        DocumentCommand(
            type="UpdateSocialClip",
            payload={"id": clip_id, "start": 1.5, "end": 4.5},
            client_id="c1",
            role="viewer",
            client_seq=5,
        )
    )
    assert updated["ok"]
    deleted = svc.submit(
        DocumentCommand(
            type="DeleteSocialClip",
            payload={"id": clip_id},
            client_id="c1",
            role="viewer",
            client_seq=6,
        )
    )
    assert deleted["ok"]

    suggested = svc.submit(
        DocumentCommand(
            type="SuggestPendingEdit",
            payload={
                "track_id": "host",
                "start": 0.5,
                "end": 1.0,
                "reason": "guest:suggest",
            },
            client_id="c1",
            role="viewer",
            client_seq=7,
        )
    )
    assert suggested["ok"]
    ws4 = ProjectWorkspace.open(minimal_project)
    pending = [d for d in ws4.project.edit_decisions if not d.applied]
    assert len(pending) >= 1
    assert pending[-1].review_required is True
    assert HistoryService(ws4).status()["can_undo"]

    svc.submit(
        DocumentCommand(
            type="DeleteChapter",
            payload={"time": 3.5, "title": "Intro"},
            client_id="c1",
            role="viewer",
            client_seq=8,
        )
    )
    ws5 = ProjectWorkspace.open(minimal_project)
    assert ws5.project.chapters == []


def test_document_set_envelope_accepts_new_points_with_explicit_baseline(minimal_project):
    payload = {
        "track_id": "host",
        "points": [{"time": 0.0, "value": 1.0}, {"time": 5.0, "value": 0.5}],
        "expected_points": [],
    }
    host_payload = validate_payload("SetEnvelope", payload)
    assert all(point["id"] for point in host_payload["points"])
    parsed = parse_document_command(
        {
            "type": "SetEnvelope",
            "payload": payload,
            "client_id": "viewer",
            "role": "viewer",
            "client_seq": 1,
        }
    )
    assert all(point["id"] for point in parsed.payload["points"])

    result = DocumentSyncService.open(minimal_project).submit(
        DocumentCommand(
            type="SetEnvelope",
            payload=payload,
            client_id="direct",
            role="viewer",
            client_seq=1,
        )
    )
    logged_ids = [point["id"] for point in result["command"]["payload"]["points"]]
    assert len(set(logged_ids)) == 2
    stored = ProjectWorkspace.open(minimal_project).project.automation_envelopes[0]
    assert [point.id for point in stored.points] == logged_ids

    with pytest.raises(ValueError, match="expected_points"):
        validate_payload("SetEnvelope", {"track_id": "host", "points": []})
    with pytest.raises(ValueError, match="id"):
        validate_payload(
            "SetEnvelope",
            {
                "track_id": "host",
                "points": [],
                "expected_points": [{"time": 0.0, "value": 1.0}],
            },
        )


def test_document_set_envelope_rejects_stale_peer_without_mutation(minimal_project):
    first = DocumentSyncService.open(minimal_project)
    second = DocumentSyncService.open(minimal_project)
    baseline: list[dict[str, object]] = []
    first.submit(
        DocumentCommand(
            type="SetEnvelope",
            payload={
                "track_id": "host",
                "points": [
                    {"id": "a", "time": 0.0, "value": 1.0},
                    {"id": "b", "time": 5.0, "value": 0.5},
                ],
                "expected_points": baseline,
            },
            client_id="first",
            role="viewer",
            client_seq=1,
        )
    )
    expected = [
        {"id": "a", "time": 0.0, "value": 1.0},
        {"id": "b", "time": 5.0, "value": 0.5},
    ]
    drag = DocumentCommand(
        type="SetEnvelope",
        payload={
            "track_id": "host",
            "points": [
                {"id": "a", "time": 1.0, "value": 1.0},
                {"id": "b", "time": 5.0, "value": 0.5},
            ],
            "expected_points": expected,
        },
        client_id="drag",
        role="viewer",
        client_seq=1,
    )
    second.submit(drag)
    seq_after_drag = int(second.store.get_snapshot()["server_seq"])
    history_after_drag = HistoryService(ProjectWorkspace.open(minimal_project)).list_entries()
    with pytest.raises(DocumentConflictError, match="changed since this edit started"):
        first.submit(
            DocumentCommand(
                type="SetEnvelope",
                payload={
                    "track_id": "host",
                    "points": [
                        {"id": "a", "time": 0.0, "value": 1.0},
                        {"id": "b", "time": 5.0, "value": 0.75},
                    ],
                    "expected_points": expected,
                },
                client_id="second",
                role="viewer",
                client_seq=1,
            )
        )
    assert int(first.store.get_snapshot()["server_seq"]) == seq_after_drag
    assert (
        HistoryService(ProjectWorkspace.open(minimal_project)).list_entries() == history_after_drag
    )
    replay = second.submit(drag)
    assert replay["idempotent"] is True
    second.submit(
        DocumentCommand(
            type="SetEnvelope",
            payload={
                "track_id": "guest",
                "points": [{"id": "g", "time": 0.0, "value": 0.25}],
                "expected_points": [],
            },
            client_id="unrelated",
            role="viewer",
            client_seq=1,
        )
    )
    stored = ProjectWorkspace.open(minimal_project).project.automation_envelopes
    host = next(envelope for envelope in stored if envelope.track_id == "host")
    assert [(point.id, point.time, point.value) for point in host.points] == [
        ("a", 1.0, 1.0),
        ("b", 5.0, 0.5),
    ]


def test_authorize_document_command_caps():
    from podcast_mcp.services.document_sync.capabilities import (
        authorize_document_command,
    )

    authorize_document_command(None, "SetEnvelope")
    authorize_document_command(["edit"], "ApproveEdits")
    authorize_document_command(["edit"], "SetEffectBypass")
    authorize_document_command(["suggest"], "SuggestPendingEdit")
    authorize_document_command(["edit"], "SplitAtTime")
    authorize_document_command(["suggest"], "SplitAtTime")
    authorize_document_command(["edit"], "PasteSegment")
    authorize_document_command(["edit"], "RippleDeleteRange")
    authorize_document_command(["edit"], "AddTrack")
    authorize_document_command(["edit"], "SetTrackMedia")
    authorize_document_command(["edit"], "SetTrackMeta")
    authorize_document_command(["edit"], "RemoveTrack")
    authorize_document_command(["edit"], "ReorderTrack")
    authorize_document_command(["edit"], "MoveClips")
    with pytest.raises(PermissionError):
        authorize_document_command(["suggest"], "AddTrack")
    with pytest.raises(PermissionError):
        authorize_document_command(["suggest"], "ReorderTrack")
    with pytest.raises(PermissionError):
        authorize_document_command(["suggest"], "MoveClips")
    with pytest.raises(PermissionError):
        authorize_document_command(["suggest"], "PasteSegment")
    with pytest.raises(PermissionError):
        authorize_document_command(["suggest"], "ApproveEdits")
    with pytest.raises(PermissionError):
        authorize_document_command(["suggest"], "SetEffectBypass")
    with pytest.raises(PermissionError):
        authorize_document_command(["view"], "UpdatePendingEdit")
    with pytest.raises(PermissionError):
        authorize_document_command(["view"], "SplitAtTime")


def test_apply_command_unknown_type(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    with pytest.raises(ValueError, match="unknown document command"):
        apply_command(ws, "NotARealCommand", {})


def test_authorize_guest_role_flag():
    denied = authorize_client(client_id="g1", role="guest", allow_guest=False)
    assert not denied.allowed
    allowed = authorize_client(client_id="g1", role="guest", allow_guest=True)
    assert allowed.allowed


def test_document_snapshot_includes_project(minimal_project):
    from podcast_mcp.services.document_sync import DocumentSyncService

    svc = DocumentSyncService.open(minimal_project)
    snap = svc.document_snapshot()
    assert "project" in snap
    assert "comments" in snap
    assert "history" in snap
    assert snap["project"]["project_path"] or snap["project"].get("meta")


def test_document_snapshot_reports_project_file_signature(minimal_project):
    import os

    from podcast_mcp.services.document_sync import DocumentSyncService

    svc = DocumentSyncService.open(minimal_project)
    st = os.stat(minimal_project)
    expected = {"mtime_ns": st.st_mtime_ns, "size": st.st_size}

    snap = svc.document_snapshot()
    assert snap["file"] == expected

    comments_snap = svc.document_snapshot(projection="comments")
    assert comments_snap["file"] == expected


def test_document_snapshot_file_matches_project_meta(minimal_project):
    """The client compares snapshot.file to /api/project/meta field for field (#657)."""
    from podcast_mcp.gui.jobs import project_meta

    svc = DocumentSyncService.open(minimal_project)
    result = svc.submit(
        DocumentCommand(
            type="AddComment",
            payload={"body": "x", "author": "viewer", "timeline_start": 1.0},
            client_id="c1",
            role="viewer",
            client_seq=1,
        )
    )
    meta = project_meta(Path(minimal_project))
    wire = {"mtime_ns": meta["mtime_ns"], "size": meta["size"]}

    assert result["snapshot"]["file"] == wire
    assert svc.document_snapshot()["file"] == wire


def test_submit_applied_chains_file_before_across_services(minimal_project):
    import os

    svc1 = DocumentSyncService.open(minimal_project)
    svc2 = DocumentSyncService.open(minimal_project)

    def add(seq: int, body: str) -> DocumentCommand:
        return DocumentCommand(
            type="AddComment",
            payload={"body": body, "author": "viewer", "timeline_start": 1.0},
            client_id=f"c{seq}",
            role="viewer",
            client_seq=seq,
        )

    r1 = svc1.submit(add(1, "first"))
    r2 = svc2.submit(add(2, "second"))

    assert r1["snapshot"]["file_before"] != r1["snapshot"]["file"]
    assert r2["snapshot"]["file_before"] == r1["snapshot"]["file"]
    st = os.stat(minimal_project)
    assert r2["snapshot"]["file"] == {"mtime_ns": st.st_mtime_ns, "size": st.st_size}


def test_submit_file_before_reflects_an_out_of_band_write(minimal_project):
    import os

    svc = DocumentSyncService.open(minimal_project)

    def add(seq: int, body: str) -> DocumentCommand:
        return DocumentCommand(
            type="AddComment",
            payload={"body": body, "author": "viewer", "timeline_start": 1.0},
            client_id=f"c{seq}",
            role="viewer",
            client_seq=seq,
        )

    r1 = svc.submit(add(1, "first"))
    st = os.stat(minimal_project)
    os.utime(minimal_project, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))

    r2 = svc.submit(add(2, "second"))
    assert r2["snapshot"]["file_before"]["mtime_ns"] == st.st_mtime_ns + 5_000_000_000
    assert r2["snapshot"]["file_before"] != r1["snapshot"]["file"]


def test_submit_and_external_mutate_share_the_journal_write_lock(minimal_project, monkeypatch):
    entered: list[str] = []
    real = DocumentSyncService._journal_write_lock

    @contextmanager
    def spy(self):
        with real(self) as store:
            entered.append("in")
            yield store

    monkeypatch.setattr(DocumentSyncService, "_journal_write_lock", spy)
    svc = DocumentSyncService.open(minimal_project)
    svc.submit(
        DocumentCommand(
            type="AddComment",
            payload={"body": "n", "author": "a", "timeline_start": 1.0},
            client_id="c-lock",
            role="viewer",
            client_seq=1,
        )
    )
    svc.publish_document_changed()
    assert entered == ["in", "in"]


def test_idempotent_retry_applied_carries_file_before(minimal_project):
    svc = DocumentSyncService.open(minimal_project)
    cmd = DocumentCommand(
        type="AddComment",
        payload={"body": "once", "author": "viewer", "timeline_start": 1.0},
        client_id="c1",
        role="viewer",
        client_seq=1,
    )
    first = svc.submit(cmd)
    again = svc.submit(cmd)

    assert again["idempotent"] is True
    assert again["snapshot"]["file_before"] == first["snapshot"]["file"]
    assert again["snapshot"]["file"] == first["snapshot"]["file"]


def test_document_snapshot_omits_file_when_revision_unknown(minimal_project, monkeypatch):
    from podcast_mcp.services import ProjectWorkspace
    from podcast_mcp.services.document_sync import DocumentSyncService

    monkeypatch.setattr(ProjectWorkspace, "loaded_file_revision", property(lambda self: None))
    svc = DocumentSyncService.open(minimal_project)

    snap = svc.document_snapshot()
    assert "file" not in snap

    result = svc.submit(
        DocumentCommand(
            type="AddComment",
            payload={"body": "x", "author": "viewer", "timeline_start": 1.0},
            client_id="c1",
            role="viewer",
            client_seq=1,
        )
    )
    assert "file_before" not in result["snapshot"]


def test_hub_fanout_document_applied(minimal_project):
    import asyncio

    from podcast_mcp.models import (
        Clip,
        EditDecision,
        EditDecisionType,
        MediaAsset,
        Track,
        TrackRole,
        load_project,
    )
    from podcast_mcp.services.document_sync import DocumentSyncService
    from podcast_mcp.services.document_sync.commands import DocumentCommand
    from podcast_mcp.services.document_sync.service import document_hub_key
    from podcast_mcp.services.session_sync.hub import get_hub

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
    ws.project.edit_decisions = [
        EditDecision(
            id="d-fanout",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1.0,
            end=2.0,
            reason="noise",
            applied=False,
        )
    ]
    ws.save()

    proj = load_project(minimal_project)
    key = document_hub_key(proj)
    loop = asyncio.new_event_loop()
    q1 = get_hub().subscribe(key, loop)
    q2 = get_hub().subscribe(key, loop)
    try:
        svc = DocumentSyncService.open(minimal_project)
        svc.submit(
            DocumentCommand(
                type="ApproveEdits",
                payload={"ids": ["d-fanout"]},
                client_id="fanout-a",
                role="viewer",
                client_seq=1,
            )
        )
        loop.call_soon(lambda: None)
        loop.run_until_complete(asyncio.sleep(0))
        e1 = q1.get_nowait()
        e2 = q2.get_nowait()
        assert e1["type"] == "Applied"
        assert e2["type"] == "Applied"
        assert "project" in e1["snapshot"]
        pending = e1["snapshot"]["project"].get("pending_edits") or []
        assert all(p.get("id") != "d-fanout" for p in pending)
    finally:
        get_hub().unsubscribe(key, q1)
        get_hub().unsubscribe(key, q2)
        loop.close()


def test_notify_document_changed_after_mcp_cut(minimal_project):
    import asyncio

    from podcast_mcp.mcp.tools.edits import cut_time_range_tool
    from podcast_mcp.models import (
        Clip,
        MediaAsset,
        Track,
        TrackRole,
        load_project,
    )
    from podcast_mcp.services.document_sync.service import document_hub_key, document_server_seq
    from podcast_mcp.services.session_sync.hub import get_hub

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
    before = document_server_seq(minimal_project)

    proj = load_project(minimal_project)
    key = document_hub_key(proj)
    loop = asyncio.new_event_loop()
    queue = get_hub().subscribe(key, loop)
    try:
        cut_time_range_tool(str(minimal_project), "host", 0.5, 1.0, reason="pass6")
        loop.call_soon(lambda: None)
        loop.run_until_complete(asyncio.sleep(0))
        event = queue.get_nowait()
        assert event["type"] == "Applied"
        assert event["command"]["type"] == "ExternalMutate"
        assert event["server_seq"] == before + 1
        assert event["snapshot"]["server_seq"] == event["server_seq"]
        assert event["command"]["client_id"] == "server:external"
        assert event["command"]["role"] == "agent"
        assert event["command"]["client_seq"] < 0
        assert "project" in event["snapshot"]
        pending = event["snapshot"]["project"].get("pending_edits") or []
        assert any(p.get("reason") == "pass6" for p in pending)
        assert document_server_seq(minimal_project) == event["server_seq"]
    finally:
        get_hub().unsubscribe(key, queue)
        loop.close()


def test_document_publish_cross_process_head_sends_a_shell_head(minimal_project):
    from podcast_mcp.services.document_sync.service import document_hub_key

    proj = load_project(minimal_project)
    svc = DocumentSyncService.open(minimal_project)

    row = _foreign_document_write(proj)

    event = svc.publish_cross_process_head()
    assert event is not None
    assert event["plane"] == "document"
    assert event["command"]["type"] == "ExternalMutate"
    assert "project" in event["snapshot"]
    assert event["snapshot"]["server_seq"] == row["server_seq"]

    assert svc.publish_cross_process_head() is None

    remembered = list(get_hub()._applied_seqs[document_hub_key(proj)])
    assert len(remembered) == len(set(remembered))

    svc.submit(
        DocumentCommand(
            type="AddComment",
            payload={
                "body": "in-process",
                "author": "viewer",
                "timeline_start": 1.0,
            },
            client_id="c1",
            role="viewer",
            client_seq=1,
        )
    )
    assert svc.publish_cross_process_head() is None


def test_document_publish_cross_process_head_with_no_store(tmp_path, sample_wav):
    from podcast_mcp.models import EpisodeProject

    workspace = tmp_path / "fresh_ws"
    raw = workspace / "raw"
    raw.mkdir(parents=True)
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    project = EpisodeProject.create("fresh_episode", str(workspace))
    project.ensure_dirs()
    fresh_project_path = save_project(project)
    fresh_project = load_project(fresh_project_path)

    assert (
        DocumentSyncService.open(fresh_project.workspace_path()).publish_cross_process_head()
        is None
    )


def test_document_server_seq_at_is_public(tmp_path):
    from podcast_mcp.services.document_sync.service import document_server_seq_at

    assert document_server_seq_at(tmp_path / "no_such.db") == 0


def test_comments_http_authz_loopback_ok(minimal_project):
    # Non-strict default: DocumentSyncService path works without token
    ws = ProjectWorkspace.open(minimal_project)
    assert ws.project is not None
    from podcast_mcp.services.document_sync import DocumentSyncService

    event = DocumentSyncService.open(minimal_project).publish_document_changed()
    assert event["type"] == "Applied"
    assert event["command"]["type"] == "ExternalMutate"
    assert event["server_seq"] == 1
    assert event["snapshot"]["server_seq"] == 1
    assert event["command"]["payload"] == {"projection": "shell"}
    assert event["snapshot"]["project"]["meta"]["hydration"]["transcript_words"] is False
    assert event["snapshot"]["project"]["history"]["groups"] == []


def test_external_mutate_rows_advance_server_seq_in_order(minimal_project):
    from podcast_mcp.services.document_sync.service import notify_comments_changed
    from podcast_mcp.services.document_sync.service import (
        notify_document_changed as notify_shell_changed,
    )

    svc = DocumentSyncService.open(minimal_project)
    first = svc.submit(_comment("first"))
    assert first["server_seq"] == 1

    notify_comments_changed(minimal_project)
    notify_shell_changed(minimal_project)

    svc2 = DocumentSyncService.open(minimal_project)
    last = svc2.submit(_comment("second", client_id="c2"))
    assert last["server_seq"] == 4

    journal = _journal(svc2)
    assert [row["type"] for row in journal] == [
        "AddComment",
        "ExternalMutate",
        "ExternalMutate",
        "AddComment",
    ]
    assert [row["server_seq"] for row in journal] == [1, 2, 3, 4]
    assert [row["client_seq"] for row in journal[1:3]] == [-1, -2]
    assert [row["payload"]["projection"] for row in journal[1:3]] == ["comments", "shell"]
    assert [row["role"] for row in journal[1:3]] == ["viewer", "agent"]


def test_external_mutate_comments_event_carries_comments_at_the_new_seq(minimal_project):
    import asyncio

    from podcast_mcp.services.comment import CommentService
    from podcast_mcp.services.document_sync.service import (
        document_hub_key,
        notify_comments_changed,
    )

    ws = ProjectWorkspace.open(minimal_project)
    key = document_hub_key(ws.project)
    loop = asyncio.new_event_loop()
    queue = get_hub().subscribe(key, loop)
    try:
        CommentService(ws).add(body="hi", author="viewer", timeline_start=1.0)
        notify_comments_changed(minimal_project)
        loop.call_soon(lambda: None)
        loop.run_until_complete(asyncio.sleep(0))
        event = queue.get_nowait()
        assert event["server_seq"] == 1
        assert len(event["snapshot"]["comments"]) == 1
        assert "project" not in event["snapshot"]
    finally:
        get_hub().unsubscribe(key, queue)
        loop.close()


def test_external_mutate_journals_a_crash_saved_command_first(minimal_project):
    svc = DocumentSyncService.open(minimal_project)
    store = svc.store
    real = store._conn
    a = _comment("from-a", seq=1, client_id="a")
    store._conn = FailingConnection(real, "INSERT INTO commands")  # type: ignore[assignment]
    try:
        with pytest.raises(sqlite3.OperationalError):
            svc.submit(a)
    finally:
        store._conn = real
    assert _journal(svc) == []

    svc2 = DocumentSyncService.open(minimal_project)
    event = svc2.publish_document_changed()
    assert event["server_seq"] == 2

    journal = _journal(svc2)
    assert [row["command_id"] for row in journal] == [a.command_id, event["command"]["command_id"]]
    assert journal[0]["payload"]["result"] is None
    assert journal[1]["type"] == "ExternalMutate"

    retry = DocumentSyncService.open(minimal_project)
    again = retry.submit(a)
    assert again["idempotent"] is True
    assert len(_journal(retry)) == 2


def test_notify_swallows_a_busy_journal_and_a_lock_timeout(minimal_project, caplog):
    from filelock import Timeout

    from podcast_mcp.services.document_sync.service import (
        DocumentSyncService as _Svc,
    )
    from podcast_mcp.services.document_sync.service import (
        notify_comments_changed,
        notify_document_changed,
    )

    svc = _Svc.open(minimal_project)
    store = svc.store
    real = store._conn
    store._conn = FailingConnection(real, "BEGIN IMMEDIATE")  # type: ignore[assignment]
    try:
        with caplog.at_level(logging.WARNING):
            notify_document_changed(minimal_project)
        assert "Could not journal ExternalMutate" in caplog.text
    finally:
        store._conn = real
    assert _journal(svc) == []

    with patch.object(_Svc, "publish_document_changed", side_effect=Timeout("lock")):
        notify_comments_changed(minimal_project)


@pytest.mark.parametrize("exc", [ValueError("bad project"), RuntimeError("journal invariant")])
def test_notify_swallows_any_journal_failure(minimal_project, caplog, exc):
    from podcast_mcp.services.document_sync.service import (
        notify_comments_changed,
        notify_document_changed,
    )

    with patch.object(DocumentSyncService, "publish_document_changed", side_effect=exc):
        with caplog.at_level(logging.WARNING):
            notify_document_changed(minimal_project)
            notify_comments_changed(minimal_project, role="guest")
    assert caplog.text.count("Could not journal ExternalMutate") == 2


def test_document_add_track_and_set_media(minimal_project, sample_wav):
    from pathlib import Path
    from shutil import copyfile

    ws = ProjectWorkspace.open(minimal_project)
    raw = Path(ws.project.workspace_dir) / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "import.wav"
    copyfile(sample_wav, dest)

    out = apply_command(ws, "AddTrack", {"track_id": "host", "label": "Host"})
    assert out["track_id"] == "host"
    assert ws.project.track_by_id("host") is not None
    assert ws.project.track_by_id("host").media is None

    media = apply_command(ws, "SetTrackMedia", {"track_id": "host", "rel_path": "raw/import.wav"})
    assert media["duration_sec"] and media["duration_sec"] > 0
    clips = [c for c in ws.project.clips if c.track_id == "host"]
    assert len(clips) == 1

    meta = apply_command(ws, "SetTrackMeta", {"track_id": "host", "speaker": "Alice"})
    assert meta["speaker"] == "Alice"

    removed = apply_command(ws, "RemoveTrack", {"track_id": "host"})
    assert removed["removed"] is True
    assert ws.project.track_by_id("host") is None


def test_document_set_track_meta_snapshot_includes_history_groups(minimal_project):
    svc = DocumentSyncService.open(minimal_project)
    added = svc.submit(
        DocumentCommand(
            type="AddTrack",
            payload={"track_id": "host", "label": "Host"},
            client_id="c1",
            role="viewer",
            client_seq=1,
        )
    )
    assert added["ok"]
    result = svc.submit(
        DocumentCommand(
            type="SetTrackMeta",
            payload={"track_id": "host", "label": "Renamed"},
            client_id="c1",
            role="viewer",
            client_seq=2,
        )
    )
    assert result["ok"]
    assert "project" not in result["snapshot"]
    assert "tracks" in result["snapshot"]["patch"]
    hist = result["snapshot"]["history"]
    assert hist["can_undo"] is True
    assert "entries" not in hist
    assert any(
        isinstance(g, dict)
        and "set track meta" in str(g.get("title") or g.get("label") or "").lower()
        for g in hist["groups"]
    )


def test_document_reorder_track(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    apply_command(ws, "AddTrack", {"track_id": "t1", "label": "One"})
    apply_command(ws, "AddTrack", {"track_id": "t2", "label": "Two"})
    apply_command(ws, "AddTrack", {"track_id": "t3", "label": "Three"})
    out = apply_command(ws, "ReorderTrack", {"track_id": "t3", "index": 0})
    assert out["track_ids"][0] == "t3"
    assert [t.id for t in ws.project.tracks][:3] == ["t3", "t1", "t2"]


def test_document_add_track_slugs_label_and_uniques(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    untitled = apply_command(ws, "AddTrack", {})
    assert untitled["track_id"] == "track"
    first = apply_command(ws, "AddTrack", {"label": "Host Mic!"})
    assert first["track_id"] == "host_mic"
    second = apply_command(ws, "AddTrack", {"label": "Host Mic!"})
    assert second["track_id"] == "host_mic_2"
    third = apply_command(ws, "AddTrack", {"label": "Host Mic!"})
    assert third["track_id"] == "host_mic_3"
    blank = apply_command(ws, "AddTrack", {"label": "!!!"})
    assert blank["track_id"] == "track_2"


def test_document_add_track_slugs_explicit_path_id(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    out = apply_command(ws, "AddTrack", {"track_id": "../Evil Host!", "label": "Host"})
    assert out["track_id"] == "evil_host"
    assert ws.project.track_by_id("evil_host") is not None
    assert ws.project.track_by_id("../Evil Host!") is None


def test_document_set_track_media_rejects_path_escape(minimal_project, sample_wav):
    ws = ProjectWorkspace.open(minimal_project)
    apply_command(ws, "AddTrack", {"track_id": "host", "label": "Host"})
    with pytest.raises(ValueError, match="raw/"):
        apply_command(
            ws,
            "SetTrackMedia",
            {"track_id": "host", "rel_path": str(sample_wav)},
        )
    with pytest.raises(ValueError, match="raw/"):
        apply_command(
            ws,
            "SetTrackMedia",
            {"track_id": "host", "rel_path": "raw/../episode.project.json"},
        )


def test_submit_snapshot_dump_falls_back_to_shell(minimal_project, monkeypatch, caplog):
    svc = DocumentSyncService.open(minimal_project)
    n = {"i": 0}
    orig = DocumentSyncService.document_snapshot

    def flaky(self, *, projection="shell"):
        n["i"] += 1
        if n["i"] == 1:
            raise RuntimeError("slice dump failed")
        return orig(self, projection=projection)

    monkeypatch.setattr(DocumentSyncService, "document_snapshot", flaky)
    with caplog.at_level(logging.WARNING):
        result = svc.submit(
            DocumentCommand(
                type="AddComment",
                payload={"body": "note", "author": "a", "timeline_start": 1.0},
                client_id="c-dump",
                role="viewer",
                client_seq=1,
            )
        )
    assert result["ok"]
    assert "project" in result["snapshot"]
    assert result["snapshot"]["comments"][0]["body"] == "note"
    assert "falling back to shell" in caplog.text


def test_submit_snapshot_dump_tags_resync_when_shell_fails(minimal_project, monkeypatch, caplog):
    svc = DocumentSyncService.open(minimal_project)

    def boom(self, *, projection="shell"):
        raise RuntimeError("dump failed")

    monkeypatch.setattr(DocumentSyncService, "document_snapshot", boom)
    with caplog.at_level(logging.WARNING):
        result = svc.submit(
            DocumentCommand(
                type="AddComment",
                payload={"body": "note", "author": "a", "timeline_start": 1.0},
                client_id="c-resync",
                role="viewer",
                client_seq=1,
            )
        )
    assert result["ok"]
    assert result["snapshot"]["resync"] is True
    assert int(result["snapshot"]["server_seq"]) >= 1
    assert result["command"]["payload"]["body"] == "note"
    assert "sending resync" in caplog.text


def _set_envelope_command(expected, *, points=None, client_id="viewer"):
    return DocumentCommand(
        type="SetEnvelope",
        payload={
            "track_id": "host",
            "points": points or [{"id": "new", "time": 0.0, "value": 1.0}],
            "expected_points": expected,
        },
        client_id=client_id,
        role="viewer",
        client_seq=1,
    )


def test_document_set_envelope_baseline_ignores_pan_listed_first(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.automation_envelopes = [
        AutomationEnvelope(
            track_id="host",
            parameter="pan",
            points=[AutomationPoint(id="pan", time=0.0, value=-1.0)],
        ),
        AutomationEnvelope(
            track_id="host", points=[AutomationPoint(id="vol", time=0.0, value=0.5)]
        ),
    ]
    ws.save()
    DocumentSyncService.open(minimal_project).submit(
        _set_envelope_command([{"id": "vol", "time": 0.0, "value": 0.5}])
    )
    stored = ProjectWorkspace.open(minimal_project).project.automation_envelopes
    assert [(e.parameter, [p.id for p in e.points]) for e in stored] == [
        ("pan", ["pan"]),
        ("volume", ["new"]),
    ]


def test_document_set_envelope_rejects_baseline_for_missing_envelope(minimal_project):
    svc = DocumentSyncService.open(minimal_project)
    with pytest.raises(DocumentConflictError, match="not applied"):
        svc.submit(_set_envelope_command([{"id": "ghost", "time": 0.0, "value": 1.0}]))
    assert ProjectWorkspace.open(minimal_project).project.automation_envelopes == []
    assert svc.store.get_snapshot() is None


def test_document_set_envelope_rejects_duplicate_baseline_ids():
    with pytest.raises(ValueError, match="expected_points IDs must be unique"):
        validate_payload(
            "SetEnvelope",
            {
                "track_id": "host",
                "points": [],
                "expected_points": [
                    {"id": "same", "time": 0.0, "value": 1.0},
                    {"id": "same", "time": 1.0, "value": 1.0},
                ],
            },
        )


def test_document_set_envelope_caps_point_lists():
    from podcast_mcp.services.document_sync.payloads import ENVELOPE_POINTS_MAX

    too_many = [
        {"id": f"p{i}", "time": float(i), "value": 1.0} for i in range(ENVELOPE_POINTS_MAX + 1)
    ]
    for key in ("points", "expected_points"):
        payload = {"track_id": "host", "points": [], "expected_points": [], key: too_many}
        with pytest.raises(ValueError, match="at most"):
            validate_payload("SetEnvelope", payload)


def _comment(body, *, seq=1, client_id="c1", command_id=None):
    kwargs = {"command_id": command_id} if command_id else {}
    return DocumentCommand(
        type="AddComment",
        payload={"body": body, "author": "viewer", "timeline_start": 2.5},
        client_id=client_id,
        role="viewer",
        client_seq=seq,
        **kwargs,
    )


def _journal(svc):
    return svc.store.commands_after(0)


def test_legacy_retry_with_a_new_command_id_is_idempotent(minimal_project):
    svc = DocumentSyncService.open(minimal_project)
    assert svc.submit(_comment("same"))["ok"]
    again = svc.submit(_comment("same"))  # new command_id, same client_seq and payload
    assert again["idempotent"] is True
    assert len(again["snapshot"]["comments"]) == 1
    assert len(_journal(svc)) == 1


def test_same_sequence_with_a_different_edit_is_a_conflict(minimal_project):
    svc = DocumentSyncService.open(minimal_project)
    svc.submit(_comment("first"))
    with pytest.raises(DocumentSequenceConflictError):
        svc.submit(_comment("second"))
    assert len(svc.ws.reload().comments) == 1
    assert len(_journal(svc)) == 1


def test_reused_command_id_with_a_different_edit_is_a_conflict(minimal_project):
    svc = DocumentSyncService.open(minimal_project)
    svc.submit(_comment("first", seq=1, command_id="fixed"))
    with pytest.raises(DocumentSequenceConflictError):
        svc.submit(_comment("second", seq=2, command_id="fixed"))
    assert len(_journal(svc)) == 1


def test_concurrent_same_sequence_submits_apply_once(minimal_project):
    """A replay racing its still-running original (client timeout, another tab) applies once."""
    first_svc = DocumentSyncService.open(minimal_project)
    second_svc = DocumentSyncService.open(minimal_project)
    entered = Event()
    original_apply = first_svc._apply

    def slow_apply(*args, **kwargs):
        entered.set()
        time.sleep(0.2)
        return original_apply(*args, **kwargs)

    with (
        patch.object(first_svc, "_apply", side_effect=slow_apply),
        ThreadPoolExecutor(max_workers=2) as pool,
    ):
        first = pool.submit(first_svc.submit, _comment("same", command_id="fixed"))
        assert entered.wait(timeout=5.0)
        second = pool.submit(second_svc.submit, _comment("same", command_id="fixed"))
        results = [first.result(timeout=30), second.result(timeout=30)]

    assert [r.get("idempotent") is True for r in results] == [False, True]
    assert len(first_svc.ws.reload().comments) == 1
    assert len(_journal(first_svc)) == 1


def test_server_assigned_sequences_never_collide(minimal_project):
    svc = DocumentSyncService.open(minimal_project)
    first = _comment("one", seq=None)
    second = _comment("two", seq=None)
    a = svc.submit(first)
    b = svc.submit(second)
    assert a["command"]["client_seq"] == -1
    assert b["command"]["client_seq"] == -2
    assert svc.submit(first)["idempotent"] is True
    assert len(_journal(svc)) == 2


def test_http_reused_sequence_returns_409(minimal_project):
    client = TestClient(create_app())
    path = str(minimal_project)

    def post(body):
        return client.post(
            "/api/document/command",
            params={"path": path},
            json={
                "type": "AddComment",
                "payload": {"body": body, "author": "v", "timeline_start": 1.0},
                "client_id": "v1",
                "role": "viewer",
                "client_seq": 1,
            },
        )

    assert post("first").status_code == 200
    second = post("second")
    assert second.status_code == 409
    assert second.json()["detail"]["conflict"] is True


def test_explicit_client_seq_must_be_positive():
    with pytest.raises(ValidationError):
        parse_document_command(
            {
                "type": "AddComment",
                "payload": {"body": "x", "author": "a", "timeline_start": 1.0},
                "client_id": "c",
                "client_seq": 0,
            }
        )


def test_submit_refuses_a_journal_row_claimed_outside_the_transaction(minimal_project):
    svc = DocumentSyncService.open(minimal_project)
    svc.submit(_comment("first"))
    with (
        patch(
            "podcast_mcp.services.document_sync.service.existing_document_command",
            return_value=None,
        ),
        pytest.raises(RuntimeError),
    ):
        svc.submit(_comment("first"))


def test_busy_journal_fails_the_command_before_the_project_changes(minimal_project):
    svc = DocumentSyncService.open(minimal_project)
    store = svc.store
    real = store._conn
    store._conn = FailingConnection(real, "BEGIN IMMEDIATE")  # type: ignore[assignment]
    try:
        with pytest.raises(sqlite3.OperationalError):
            svc.submit(_comment("first"))
    finally:
        store._conn = real
    assert load_project(minimal_project).comments == []
    assert _journal(svc) == []
    assert svc.submit(_comment("first"))["ok"]
    assert [c.body for c in load_project(minimal_project).comments] == ["first"]
    assert len(_journal(svc)) == 1


def test_journal_insert_failure_after_apply_is_journaled_by_the_retry(minimal_project):
    """An I/O failure after the apply saves the command; the next submit journals it (#575)."""
    svc = DocumentSyncService.open(minimal_project)
    store = svc.store
    real = store._conn
    cmd = _comment("first")
    store._conn = FailingConnection(real, "INSERT INTO commands")  # type: ignore[assignment]
    try:
        with pytest.raises(sqlite3.OperationalError):
            svc.submit(cmd)
    finally:
        store._conn = real
    assert [c.body for c in load_project(minimal_project).comments] == ["first"]
    assert _journal(svc) == []
    assert not real.in_transaction
    saved = load_project(minimal_project).document_sync.last_command
    assert saved is not None
    assert saved.command_id == cmd.command_id

    retry = DocumentSyncService.open(minimal_project)
    result = retry.submit(cmd)
    assert result["idempotent"] is True
    assert [c.body for c in load_project(minimal_project).comments] == ["first"]
    journal = _journal(retry)
    assert len(journal) == 1
    assert journal[0]["payload"]["result"] is None


def test_the_next_command_journals_an_edit_saved_without_its_row_first(minimal_project):
    svc = DocumentSyncService.open(minimal_project)
    store = svc.store
    real = store._conn
    a = _comment("from-a", seq=1, client_id="a")
    store._conn = FailingConnection(real, "INSERT INTO commands")  # type: ignore[assignment]
    try:
        with pytest.raises(sqlite3.OperationalError):
            svc.submit(a)
    finally:
        store._conn = real
    assert _journal(svc) == []

    svc2 = DocumentSyncService.open(minimal_project)
    b = _comment("from-b", seq=1, client_id="b")
    result = svc2.submit(b)
    assert result["ok"]
    assert result.get("idempotent") is not True

    journal = _journal(svc2)
    assert len(journal) == 2
    assert journal[0]["command_id"] == a.command_id
    assert journal[0]["payload"]["result"] is None
    assert journal[1]["command_id"] == b.command_id

    retry = DocumentSyncService.open(minimal_project)
    again = retry.submit(a)
    assert again["idempotent"] is True
    assert len(_journal(retry)) == 2
    assert [c.body for c in load_project(minimal_project).comments] == ["from-a", "from-b"]


def test_a_failure_after_a_recovery_keeps_the_recovered_row(minimal_project):
    """A's recovered row commits before B's apply, so B failing before COMMIT cannot drop it."""
    svc = DocumentSyncService.open(minimal_project)
    store = svc.store
    real = store._conn
    a = _comment("from-a", seq=1, client_id="a")
    store._conn = FailingConnection(real, "INSERT INTO commands")  # type: ignore[assignment]
    try:
        with pytest.raises(sqlite3.OperationalError):
            svc.submit(a)
    finally:
        store._conn = real
    assert _journal(svc) == []

    class _FailingHub:
        def publish(self, _key, _event):
            raise OSError("injected failure before the journal COMMIT")

    b = _comment("from-b", seq=1, client_id="b")
    svc2 = DocumentSyncService.open(minimal_project)
    with patch("podcast_mcp.services.document_sync.service.get_hub", return_value=_FailingHub()):
        with pytest.raises(OSError):
            svc2.submit(b)
    assert [row["command_id"] for row in _journal(svc2)] == [a.command_id]
    saved = load_project(minimal_project).document_sync.last_command
    assert saved is not None
    assert saved.command_id == b.command_id
    assert saved.base_server_seq == 1

    retry = DocumentSyncService.open(minimal_project)
    assert retry.submit(a)["idempotent"] is True
    assert retry.submit(b)["idempotent"] is True
    journal = _journal(retry)
    assert [row["command_id"] for row in journal] == [a.command_id, b.command_id]
    assert [row["payload"]["result"] for row in journal] == [None, None]
    assert [c.body for c in load_project(minimal_project).comments] == ["from-a", "from-b"]


def test_a_failed_apply_does_not_leave_its_record_for_a_later_save(minimal_project):
    svc = DocumentSyncService.open(minimal_project)
    first = svc.submit(_comment("first"))
    assert first["ok"]
    cid = first["snapshot"]["comments"][0]["id"]

    with pytest.raises(DocumentConflictError):
        svc.submit(
            DocumentCommand(
                type="UpdateComment",
                payload={"comment_id": "does-not-exist", "body": "nope"},
                client_id="c1",
                role="viewer",
                client_seq=2,
            )
        )
    svc.ws.save()

    saved = load_project(minimal_project).document_sync.last_command
    assert saved is not None
    assert saved.type == "AddComment"
    assert saved.payload.get("body") == "first"

    second = svc.submit(
        DocumentCommand(
            type="UpdateComment",
            payload={"comment_id": cid, "body": "updated"},
            client_id="c1",
            role="viewer",
            client_seq=3,
        )
    )
    assert second["ok"]
    assert len(_journal(svc)) == 2


def test_a_history_move_saved_before_its_render_failed_is_not_repeated_by_a_retry(minimal_project):
    svc = _undoable_rejection(minimal_project)
    cmd = DocumentCommand(
        type="UndoHistory",
        payload={"rerender": True},
        client_id="c1",
        role="viewer",
        client_seq=3,
    )

    def failing_render(_project):
        raise OSError("ffmpeg failed")

    with patch("podcast_mcp.services.history.rerender_preview", failing_render):
        with pytest.raises(DocumentConflictError):
            svc.submit(cmd)

    status_before = HistoryService(ProjectWorkspace.open(minimal_project)).status()
    assert len(_journal(svc)) == 1

    retry = DocumentSyncService.open(minimal_project)
    result = retry.submit(cmd)
    assert result["idempotent"] is True
    status_after = HistoryService(ProjectWorkspace.open(minimal_project)).status()
    assert status_after["cursor"] == status_before["cursor"]
    assert len(_journal(retry)) == 2


def test_an_unknown_commit_outcome_rereads_a_landed_saved_command(minimal_project):
    svc = _undoable_rejection(minimal_project)
    cmd = DocumentCommand(
        type="UndoHistory",
        payload={"rerender": True},
        client_id="c1",
        role="viewer",
        client_seq=3,
    )

    def failing_render(_project):
        raise OSError("ffmpeg failed")

    with (
        patch("podcast_mcp.services.history.rerender_preview", failing_render),
        patch("podcast_mcp.services.document_sync.service.commit_landed", return_value=None),
        pytest.raises(DocumentConflictError),
    ):
        svc.submit(cmd)

    cursor_before = HistoryService(ProjectWorkspace.open(minimal_project)).status()["cursor"]
    # Same service: its workspace must still carry the saved record.
    result = svc.submit(cmd)
    assert result["idempotent"] is True
    assert (
        HistoryService(ProjectWorkspace.open(minimal_project)).status()["cursor"] == cursor_before
    )
    assert len(_journal(svc)) == 2


def test_an_unknown_commit_outcome_does_not_keep_a_failed_command(minimal_project):
    svc = DocumentSyncService.open(minimal_project)
    assert svc.submit(_comment("first"))["ok"]
    with (
        patch("podcast_mcp.services.document_sync.service.commit_landed", return_value=None),
        pytest.raises(DocumentConflictError),
    ):
        svc.submit(
            DocumentCommand(
                type="UpdateComment",
                payload={"comment_id": "does-not-exist", "body": "nope"},
                client_id="c1",
                role="viewer",
                client_seq=2,
            )
        )
    kept = svc.ws.project.document_sync.last_command
    assert kept is not None
    assert kept.payload.get("body") == "first"
    assert svc.submit(_comment("second", seq=3))["ok"]
    assert [row["payload"]["body"] for row in _journal(svc)] == ["first", "second"]


def test_an_unknown_commit_outcome_survives_a_failed_reread(minimal_project, caplog):
    svc = DocumentSyncService.open(minimal_project)
    assert svc.submit(_comment("first"))["ok"]
    # commit_landed is None when the project file cannot be stat'ed; the re-read in
    # discard_changes() then usually fails on the same stat.
    with (
        patch("podcast_mcp.services.document_sync.service.commit_landed", return_value=None),
        patch.object(ProjectWorkspace, "reload", side_effect=OSError("stat failed")),
        caplog.at_level(logging.WARNING, logger="podcast_mcp.services.document_sync.service"),
        pytest.raises(DocumentConflictError),
    ):
        svc.submit(
            DocumentCommand(
                type="UpdateComment",
                payload={"comment_id": "does-not-exist", "body": "nope"},
                client_id="c1",
                role="viewer",
                client_seq=2,
            )
        )
    assert any(
        "Could not re-read the project after a failed document command" in r.getMessage()
        for r in caplog.records
    )
    kept = svc.ws.project.document_sync.last_command
    assert kept is not None
    assert kept.payload.get("body") == "first"
    # Once stat works again, the next submit adopts the saved file and never journals
    # the failed command.
    assert svc.submit(_comment("second", seq=3))["ok"]
    assert [row["payload"]["body"] for row in _journal(svc)] == ["first", "second"]
    assert [c.body for c in svc.ws.reload().comments] == ["first", "second"]


def test_a_reset_journal_never_journals_an_old_record(minimal_project, caplog):
    svc = DocumentSyncService.open(minimal_project)
    svc.submit(_comment("a", seq=1, client_id="a"))
    b = _comment("b", seq=1, client_id="b")
    svc.submit(b)
    assert len(_journal(svc)) == 2

    svc.store.reset({"server_seq": 0})

    svc2 = DocumentSyncService.open(minimal_project)
    with caplog.at_level(logging.WARNING, logger="podcast_mcp.services.document_sync.service"):
        svc2.submit(_comment("c", seq=1, client_id="c"))
        svc2.submit(_comment("d", seq=1, client_id="d"))
    journal = _journal(svc2)
    assert [row["payload"]["body"] for row in journal] == ["c", "d"]
    skipped = [
        r.getMessage() for r in caplog.records if "Skipped saved document command" in r.getMessage()
    ]
    assert len(skipped) == 1
    assert b.command_id in skipped[0]


def test_document_server_seq_matches_the_journal(minimal_project):
    from podcast_mcp.services.document_sync.service import document_server_seq

    svc = DocumentSyncService.open(minimal_project)
    svc.submit(_comment("first"))
    assert document_server_seq(minimal_project) == 1


def test_document_db_path_for_workspace_matches_project(minimal_project):
    from podcast_mcp.services.document_sync.service import (
        document_db_path,
        document_db_path_for_workspace,
    )

    proj = load_project(minimal_project)
    assert document_db_path_for_workspace(proj.workspace_path()) == document_db_path(proj)


def test_document_server_seq_does_not_parse_the_project(minimal_project, monkeypatch):
    from podcast_mcp.services.document_sync.service import document_server_seq

    svc = DocumentSyncService.open(minimal_project)
    svc.submit(_comment("first"))

    from podcast_mcp.project_store import ProjectStore

    def _boom(self):
        raise AssertionError("document_server_seq must not parse the project")

    monkeypatch.setattr(ProjectStore, "load", _boom)

    assert document_server_seq(minimal_project) == 1
    assert document_server_seq(minimal_project.parent) == 1


def test_document_server_seq_does_not_create_document_db(minimal_project):
    from podcast_mcp.services.document_sync.service import (
        document_db_path,
        document_server_seq,
    )

    proj = load_project(minimal_project)
    db_path = document_db_path(proj)
    assert not db_path.exists()
    assert document_server_seq(minimal_project) == 0
    assert not db_path.exists()


def test_document_server_seq_reuses_the_service_store(minimal_project):
    from podcast_mcp.services.document_sync.service import _open_store, document_db_path

    svc = DocumentSyncService.open(minimal_project)
    svc.submit(_comment("first"))
    db_path = document_db_path(svc.project)
    assert _open_store(db_path) is svc.store


def test_document_server_seq_reads_the_cached_store_when_the_file_check_fails(
    minimal_project, monkeypatch
):
    from pathlib import Path

    from podcast_mcp.services.document_sync.service import document_server_seq

    svc = DocumentSyncService.open(minimal_project)
    svc.submit(_comment("first"))
    monkeypatch.setattr(Path, "is_file", lambda self: False)
    assert document_server_seq(minimal_project) == 1


def test_a_handler_that_drops_the_saved_command_is_logged(minimal_project, caplog):
    from podcast_mcp.services.document_sync.handlers import HANDLERS

    real = HANDLERS["AddComment"]

    def dropping(ws, payload):
        result = real(ws, payload)
        ws.project.document_sync.last_command = None
        return result

    svc = DocumentSyncService.open(minimal_project)
    logger = "podcast_mcp.services.document_sync.service"
    with (
        patch.dict(HANDLERS, {"AddComment": dropping}),
        caplog.at_level(logging.ERROR, logger=logger),
    ):
        assert svc.submit(_comment("x"))["ok"]
    assert any("without its document_sync.last_command" in r.getMessage() for r in caplog.records)

    caplog.clear()
    with caplog.at_level(logging.ERROR, logger=logger):
        assert svc.submit(_comment("y", seq=2))["ok"]
    assert not any(
        "without its document_sync.last_command" in r.getMessage() for r in caplog.records
    )


def test_the_saved_command_is_not_an_undo_layer(minimal_project):
    assert "document_sync" not in ProjectStateSnapshot.model_fields

    svc = DocumentSyncService.open(minimal_project)
    svc.submit(_comment("first"))
    ws = ProjectWorkspace.open(minimal_project)
    assert ws.project.document_sync.last_command is not None

    HistoryService(ws).undo()

    ws_after = ProjectWorkspace.open(minimal_project)
    assert ws_after.project.document_sync.last_command is not None


_SCHEMA = Path(__file__).resolve().parents[1] / "schemas" / "episode.project.schema.json"


def test_a_project_saved_before_575_loads_without_a_saved_command(minimal_project):
    data = json.loads(minimal_project.read_text(encoding="utf-8"))
    data.pop("document_sync", None)
    minimal_project.write_text(json.dumps(data), encoding="utf-8")

    project = load_project(minimal_project)
    assert project.document_sync.last_command is None

    project.document_sync.last_command = SavedDocumentCommand(
        command_id="cmd-1",
        client_id="c1",
        client_seq=1,
        role="viewer",
        type="AddComment",
        payload={"body": "hi"},
        base_server_seq=0,
    )
    save_project(project, minimal_project)

    saved_raw = json.loads(minimal_project.read_text(encoding="utf-8"))
    full_schema = json.loads(_SCHEMA.read_text(encoding="utf-8"))
    document_sync_schema = {"$ref": "#/$defs/DocumentSyncSection", "$defs": full_schema["$defs"]}
    jsonschema.validate(instance=saved_raw["document_sync"], schema=document_sync_schema)


def test_command_id_retry_from_another_client_is_a_conflict(minimal_project):
    svc = DocumentSyncService.open(minimal_project)
    svc.submit(_comment("mine", seq=None, client_id="a", command_id="shared-id"))
    with pytest.raises(DocumentSequenceConflictError):
        svc.submit(_comment("mine", seq=None, client_id="b", command_id="shared-id"))
    assert len(_journal(svc)) == 1


@pytest.mark.parametrize(
    "error",
    [
        Timeout("episode.project.json.lock"),
        sqlite3.OperationalError("database is locked"),
        RenderBusyError("/artifacts/render.lock"),
    ],
    ids=["project-lock", "sqlite-busy", "render-lock"],
)
def test_http_command_returns_503_when_the_project_is_busy(minimal_project, monkeypatch, error):
    def busy(self, command, **kwargs):
        raise error

    monkeypatch.setattr(DocumentSyncService, "submit", busy)
    client = TestClient(create_app())
    r = client.post(
        "/api/document/command",
        params={"path": str(minimal_project)},
        json={
            "type": "AddComment",
            "payload": {"body": "x", "author": "v", "timeline_start": 1.0},
            "client_id": "v1",
            "role": "viewer",
            "client_seq": 1,
        },
    )
    assert r.status_code == 503
    assert "try again" in r.json()["detail"].lower()
    assert r.headers["X-Sharecut-Error-Code"] == "project_busy"
    assert "/artifacts" not in r.json()["detail"]
    if isinstance(error, RenderBusyError):
        assert "another render of this project is in progress" in r.json()["detail"]


def test_http_command_does_not_hide_other_sqlite_errors(minimal_project, monkeypatch):
    def broken(self, command, **kwargs):
        raise sqlite3.OperationalError("disk I/O error")

    monkeypatch.setattr(DocumentSyncService, "submit", broken)
    client = TestClient(create_app())
    with pytest.raises(sqlite3.OperationalError):
        client.post(
            "/api/document/command",
            params={"path": str(minimal_project)},
            json={
                "type": "AddComment",
                "payload": {"body": "x", "author": "v", "timeline_start": 1.0},
                "client_id": "v1",
                "role": "viewer",
                "client_seq": 1,
            },
        )


def test_submit_publishes_applied_inside_the_project_transaction(minimal_project, monkeypatch):
    svc = DocumentSyncService.open(minimal_project)
    depths: list[int] = []
    monkeypatch.setattr(
        get_hub(), "publish", lambda _key, _event: depths.append(svc.ws._transaction_depth)
    )
    svc.submit(_comment("ordered"))
    assert depths and all(depth >= 1 for depth in depths)
