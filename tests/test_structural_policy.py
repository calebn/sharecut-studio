"""Tests for structural apply-vs-propose document policy and multi-track split."""

from __future__ import annotations

import pytest

from podcast_mcp.edits.timeline_ops import split_clips_at
from podcast_mcp.models import (
    Clip,
    EditDecisionType,
    MediaAsset,
    Track,
    TrackRole,
)
from podcast_mcp.models.episode import save_project
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.capabilities import authorize_document_command
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.policy import (
    StructuralMutationMode,
    resolve_structural_mode,
)
from podcast_mcp.services.edit import EditService
from podcast_mcp.services.workspace import ProjectWorkspace


def _seed_dialogue_clips(project_path, sample_wav) -> ProjectWorkspace:
    ws = ProjectWorkspace.open(project_path)
    p = ws.project
    dest = p.raw_dir() / "host.wav"
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.is_file():
        dest.write_bytes(sample_wav.read_bytes())
    guest = p.raw_dir() / "guest.wav"
    if not guest.is_file():
        guest.write_bytes(sample_wav.read_bytes())
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            speaker="Guest",
            media=MediaAsset(path="raw/guest.wav", duration_sec=10.0),
        ),
    ]
    p.timeline.clips = [
        Clip(
            id="full_host",
            track_id="host",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        ),
        Clip(
            id="full_guest",
            track_id="guest",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        ),
    ]
    p.timeline.duration_sec = 10.0
    save_project(p)
    return ProjectWorkspace.open(project_path)


def test_resolve_structural_mode():
    assert resolve_structural_mode(None) is StructuralMutationMode.APPLY
    assert resolve_structural_mode(["edit"]) is StructuralMutationMode.APPLY
    assert resolve_structural_mode(["suggest"]) is StructuralMutationMode.PROPOSE
    assert resolve_structural_mode(["edit", "suggest"]) is StructuralMutationMode.APPLY
    with pytest.raises(PermissionError):
        resolve_structural_mode(["view"])
    with pytest.raises(PermissionError):
        resolve_structural_mode(["comment"])


def test_authorize_structural_commands():
    authorize_document_command(["edit"], "SplitAtTime")
    authorize_document_command(["suggest"], "SplitAtTime")
    authorize_document_command(["edit"], "DeleteClip")
    authorize_document_command(["suggest"], "RippleDeleteClip")
    with pytest.raises(PermissionError):
        authorize_document_command(["view"], "SplitAtTime")


def test_split_clips_at_multi_track(minimal_project, sample_wav):
    ws = _seed_dialogue_clips(minimal_project, sample_wav)
    report = split_clips_at(ws.project, 5.0, ["host", "guest"])
    assert report["operation"] == "split_clips_at"
    assert set(report["affected_tracks"]) == {"host", "guest"}
    assert any(r.operation == "split_clips_at" for r in ws.project.editorial.edit_log)
    assert len([c for c in ws.project.clips if c.track_id == "host"]) == 2


def test_split_at_time_apply_via_document(minimal_project, sample_wav):
    _seed_dialogue_clips(minimal_project, sample_wav)
    svc = DocumentSyncService.open(minimal_project)
    before = len(svc.ws.project.clips)
    cmd = DocumentCommand(
        type="SplitAtTime",
        payload={"at_time": 5.0, "track_ids": ["host"]},
        client_id="host",
        role="viewer",
        client_seq=1,
    )
    out = svc.submit(cmd, capabilities=None)
    assert out["ok"]
    assert len(svc.ws.project.clips) > before
    assert not any(e.type == EditDecisionType.SPLIT for e in svc.ws.project.edit_decisions)


def test_split_at_time_suggest_proposes(minimal_project, sample_wav):
    _seed_dialogue_clips(minimal_project, sample_wav)
    svc = DocumentSyncService.open(minimal_project)
    before_clips = len(svc.ws.project.clips)
    cmd = DocumentCommand(
        type="SplitAtTime",
        payload={"at_time": 5.0, "track_ids": ["host"]},
        client_id="guest",
        role="guest",
        client_seq=1,
    )
    out = svc.submit(cmd, capabilities=["suggest"])
    assert out["ok"]
    assert len(svc.ws.project.clips) == before_clips
    pending = [e for e in svc.ws.project.edit_decisions if e.type == EditDecisionType.SPLIT]
    assert len(pending) == 1
    assert pending[0].start == pending[0].end == 5.0
    assert pending[0].timebase == "timeline"

    count = EditService(svc.ws).approve([pending[0].id])
    assert count == 1
    assert len(svc.ws.project.clips) > before_clips
    assert not any(e.type == EditDecisionType.SPLIT for e in svc.ws.project.edit_decisions)


def test_delete_clip_apply_and_suggest(minimal_project, sample_wav):
    _seed_dialogue_clips(minimal_project, sample_wav)
    svc = DocumentSyncService.open(minimal_project)
    EditService(svc.ws).split_at_time(4.0, ["host"])
    EditService(svc.ws).split_at_time(6.0, ["host"])
    clips = [c for c in svc.ws.project.clips if c.track_id == "host"]
    middle = next(
        c for c in clips if abs(c.timeline_start - 4.0) < 1e-6 and abs(c.timeline_end - 6.0) < 1e-6
    )
    cmd = DocumentCommand(
        type="DeleteClip",
        payload={"clip_id": middle.id},
        client_id="guest",
        role="guest",
        client_seq=10,
    )
    out = svc.submit(cmd, capabilities=["suggest"])
    assert out["ok"]
    pending = [e for e in svc.ws.project.edit_decisions if not e.applied]
    assert pending

    remaining = [c for c in svc.ws.project.clips if c.track_id == "host"]
    other = next(c for c in remaining if c.id != middle.id)
    cmd2 = DocumentCommand(
        type="DeleteClip",
        payload={"clip_id": other.id},
        client_id="host",
        role="viewer",
        client_seq=11,
    )
    out2 = svc.submit(cmd2, capabilities=None)
    assert out2["ok"]
    assert other.id not in {c.id for c in svc.ws.project.clips}


def test_ripple_delete_clip_apply(minimal_project, sample_wav):
    _seed_dialogue_clips(minimal_project, sample_wav)
    svc = DocumentSyncService.open(minimal_project)
    EditService(svc.ws).split_at_time(3.0, ["host"])
    EditService(svc.ws).split_at_time(5.0, ["host"])
    clips = [c for c in svc.ws.project.clips if c.track_id == "host"]
    middle = next(
        c for c in clips if abs(c.timeline_start - 3.0) < 1e-6 and abs(c.timeline_end - 5.0) < 1e-6
    )
    before_dur = svc.ws.project.timeline.duration_sec
    cmd = DocumentCommand(
        type="RippleDeleteClip",
        payload={"clip_ids": [middle.id]},
        client_id="host",
        role="viewer",
        client_seq=20,
    )
    out = svc.submit(cmd, capabilities=["edit"])
    assert out["ok"]
    assert svc.ws.project.timeline.duration_sec < before_dur


def test_structural_mode_from_payload_invalid():
    from podcast_mcp.services.document_sync.policy import structural_mode_from_payload

    with pytest.raises(ValueError, match="invalid _structural_mode"):
        structural_mode_from_payload({"_structural_mode": "nope"})


def test_split_at_time_no_tracks_raises(minimal_project, sample_wav):
    ws = ProjectWorkspace.open(minimal_project)
    with pytest.raises(ValueError, match="no tracks"):
        EditService(ws).split_at_time(1.0, [])


def test_delete_clips_empty_raises(minimal_project, sample_wav):
    _seed_dialogue_clips(minimal_project, sample_wav)
    ws = ProjectWorkspace.open(minimal_project)
    with pytest.raises(ValueError, match="clip_ids required"):
        EditService(ws).delete_clips([])
    with pytest.raises(KeyError, match="unknown clip"):
        EditService(ws).delete_clips(["missing_clip"])


def test_delete_clip_handler_requires_ids(minimal_project, sample_wav):
    from podcast_mcp.services.document_sync.handlers import apply_command

    ws = _seed_dialogue_clips(minimal_project, sample_wav)
    with pytest.raises(ValueError, match="clip_id"):
        apply_command(ws, "DeleteClip", {"_structural_mode": "apply"})
    with pytest.raises(ValueError, match="clip_id"):
        apply_command(ws, "RippleDeleteClip", {"_structural_mode": "propose"})


def test_ripple_delete_clip_suggest(minimal_project, sample_wav):
    _seed_dialogue_clips(minimal_project, sample_wav)
    svc = DocumentSyncService.open(minimal_project)
    clip_id = next(c.id for c in svc.ws.project.clips if c.track_id == "host")
    before = len(svc.ws.project.clips)
    cmd = DocumentCommand(
        type="RippleDeleteClip",
        payload={"clip_id": clip_id, "reason": "guest cut"},
        client_id="guest",
        role="guest",
        client_seq=30,
    )
    out = svc.submit(cmd, capabilities=["suggest"])
    assert out["ok"]
    assert len(svc.ws.project.clips) == before
    assert any(not e.applied for e in svc.ws.project.edit_decisions)


def test_split_clip_all_dialogue_tracks(minimal_project, sample_wav):
    ws = _seed_dialogue_clips(minimal_project, sample_wav)
    out = EditService(ws).split_clip(5.0)
    assert out["operation"] == "split_clips_at"
    assert set(out["affected_tracks"]) == {"host", "guest"}


def test_update_pending_split_and_skipped_track(minimal_project, sample_wav):
    _seed_dialogue_clips(minimal_project, sample_wav)
    svc = DocumentSyncService.open(minimal_project)
    cmd = DocumentCommand(
        type="SplitAtTime",
        payload={"at_time": 5.0, "track_ids": ["host", "guest"]},
        client_id="guest",
        role="guest",
        client_seq=40,
    )
    svc.submit(cmd, capabilities=["suggest"])
    pending = next(e for e in svc.ws.project.edit_decisions if e.type == EditDecisionType.SPLIT)
    updated = EditService(svc.ws).update_pending(
        pending.id, start=4.5, end=4.5, snap=False, track_ids=["host"]
    )
    assert updated.start == updated.end == 4.5
    assert updated.track_ids == ["host"]

    # Guest track has no clip past 10 - skip that id when applying multi-split mid-clip
    report = split_clips_at(svc.ws.project, 2.0, ["host", "nope"], record_log=True)
    assert "host" in report["affected_tracks"]


def test_delete_clips_propose_ripple(minimal_project, sample_wav):
    ws = _seed_dialogue_clips(minimal_project, sample_wav)
    clip_id = next(c.id for c in ws.project.clips if c.track_id == "host")
    out = EditService(ws).delete_clips([clip_id], ripple=True, propose=True, reason="guest:ripple")
    assert out["operation"] == "propose_delete_clips"
    assert out["ripple"] is True
    assert any(e.reason == "guest:ripple" for e in ws.project.edit_decisions)


def test_append_split_requires_tracks(minimal_project, sample_wav):
    from podcast_mcp.edits.transcript_cuts import append_split_decision

    ws = _seed_dialogue_clips(minimal_project, sample_wav)
    with pytest.raises(ValueError, match="track_ids required"):
        append_split_decision(ws.project, 1.0, [])


def test_delete_clip_via_clip_ids_payload(minimal_project, sample_wav):
    _seed_dialogue_clips(minimal_project, sample_wav)
    svc = DocumentSyncService.open(minimal_project)
    EditService(svc.ws).split_at_time(5.0, ["host"])
    left = next(
        c for c in svc.ws.project.clips if c.track_id == "host" and abs(c.timeline_start) < 1e-6
    )
    cmd = DocumentCommand(
        type="DeleteClip",
        payload={"clip_ids": [left.id], "reason": "trim"},
        client_id="host",
        role="viewer",
        client_seq=50,
    )
    out = svc.submit(cmd, capabilities=["edit"])
    assert out["ok"]
    assert left.id not in {c.id for c in svc.ws.project.clips}


def test_split_clips_at_none_raises(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    with pytest.raises(ValueError, match="no tracks"):
        split_clips_at(ws.project, 1.0, [])
