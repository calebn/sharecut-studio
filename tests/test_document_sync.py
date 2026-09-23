"""Document-plane sync for comment, history, and edit commands."""

from __future__ import annotations

import pytest

from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    MediaAsset,
    Track,
    TrackRole,
)
from podcast_mcp.services import ProjectWorkspace
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.handlers import apply_command
from podcast_mcp.services.document_sync.payloads import parse_document_command, validate_payload
from podcast_mcp.services.history import HistoryService
from podcast_mcp.services.session_sync.authz import authorize_client


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


def test_document_set_envelope_accepts_and_journals_legacy_points(minimal_project):
    payload = {
        "track_id": "host",
        "points": [{"time": 0.0, "value": 1.0}, {"time": 5.0, "value": 0.5}],
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
    ws.save()

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
        assert "project" in event["snapshot"]
        pending = event["snapshot"]["project"].get("pending_edits") or []
        assert any(p.get("reason") == "pass6" for p in pending)
    finally:
        get_hub().unsubscribe(key, queue)
        loop.close()


def test_comments_http_authz_loopback_ok(minimal_project):
    # Non-strict default: DocumentSyncService path works without token
    ws = ProjectWorkspace.open(minimal_project)
    assert ws.project is not None
    from podcast_mcp.services.document_sync import DocumentSyncService

    event = DocumentSyncService.open(minimal_project).publish_document_changed()
    assert event["type"] == "Applied"
    assert event["command"]["type"] == "ExternalMutate"
    assert event["snapshot"]["project"]["meta"]["hydration"]["transcript_words"] is False
    assert event["snapshot"]["project"]["history"]["groups"] == []


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


def test_submit_snapshot_dump_falls_back_to_shell(minimal_project, monkeypatch):
    svc = DocumentSyncService.open(minimal_project)
    n = {"i": 0}
    orig = DocumentSyncService.document_snapshot

    def flaky(self, *, projection="shell"):
        n["i"] += 1
        if n["i"] == 1:
            raise RuntimeError("slice dump failed")
        return orig(self, projection=projection)

    monkeypatch.setattr(DocumentSyncService, "document_snapshot", flaky)
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


def test_submit_snapshot_dump_tags_resync_when_shell_fails(minimal_project, monkeypatch):
    svc = DocumentSyncService.open(minimal_project)

    def boom(self, *, projection="shell"):
        raise RuntimeError("dump failed")

    monkeypatch.setattr(DocumentSyncService, "document_snapshot", boom)
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
