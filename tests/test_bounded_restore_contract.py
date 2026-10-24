from __future__ import annotations

import json
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient
from mcp.client import Client

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.edit_log import (
    LocalRestoreRequiresHistory,
    require_applied_edit_restore,
    revert_applied_edit,
)
from podcast_mcp.edits.transcript_refine_status import REFINE_GATE
from podcast_mcp.engines.session_timeline import origin_track_id_for_clip
from podcast_mcp.engines.timeline_render import resolve_clip_audio_path
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.models import (
    AppliedEditRecord,
    Clip,
    ClipMuteRegion,
    EditDecisionType,
    RoomToneFill,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.models.episode import SourceRecording
from podcast_mcp.project.store import history_index_path, history_snapshot_ids
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService, HistoryService
from source_review_helpers import _cut, _project

pytestmark = pytest.mark.refine_gate

RESTORE_MESSAGE = (
    "This edit cannot be restored individually. Use History Undo to restore the whole action. "
    "History Undo also undoes the other edits in that action. "
    "You may need to undo later actions first."
)


def _editable(project):
    return {
        "sources": [s.model_dump(mode="json") for s in project.sources],
        "timeline": project.timeline.model_dump(mode="json"),
        "editorial": project.editorial.model_dump(mode="json"),
        "transcripts": project.transcript_data.model_dump(mode="json"),
        "mix": project.mix.model_dump(mode="json"),
        "social": project.social.model_dump(mode="json"),
        "review": project.review.model_dump(mode="json"),
        "last_completed_step": project.render.last_completed_step,
        "ingest_alignment": project.meta.model_dump(mode="json")["ingest_alignment"],
    }


def _state(ws):
    index = history_index_path(ws.project)
    return {
        "disk": ws.path.read_bytes(),
        "memory": json.dumps(_editable(ws.project), sort_keys=True),
        "pending": [e.model_dump_json() for e in ws.project.edit_decisions],
        "archive": [r.model_dump_json() for r in ws.project.editorial.edit_log],
        "history_index": index.read_bytes(),
        "snapshot_ids": history_snapshot_ids(index),
    }


def _assert_unchanged(ws, before):
    assert _state(ws) == before
    assert json.dumps(_editable(load_project(ws.path)), sort_keys=True) == before["memory"]


def _parked_project(tmp_path):
    project = _project(tmp_path)
    project.tracks[0].timeline_empty = True
    project.tracks.append(
        Track(id="destination", label="Destination", role=TrackRole.DIALOGUE, timeline_empty=True)
    )
    project.sources = [SourceRecording(id="host-source", path="raw/host.wav")]
    project.clips = [
        Clip(
            id="parked",
            track_id="destination",
            source_id="host-source",
            source_start=0,
            source_end=6,
            timeline_start=0,
        )
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            source_id="host-source",
            words=[TranscriptWord(text="um", start=1.2, end=1.6)],
        )
    ]
    project.edit_decisions = [_cut("parked-cut", reason="filler:um")]
    REFINE_GATE.mark_done(
        project, notes="Known synthetic transcript fixture; no real-project acceptance"
    )
    return project


def _approved_parked(tmp_path):
    ws = ProjectWorkspace.open(save_project(_parked_project(tmp_path)))
    original = _editable(ws.project)
    assert EditService(ws).approve(["parked-cut"]) == 1
    assert [
        (c.track_id, c.source_id, c.source_start, c.source_end, c.timeline_start)
        for c in ws.project.clips
    ] == [
        ("destination", "host-source", 0, 1, 0),
        ("destination", "host-source", 2, 6, 1),
    ]
    assert [r.decision_ids for r in ws.project.editorial.edit_log] == [["parked-cut"]]
    return ws, original


def _assert_parked_recovered(ws, original, tmp_path):
    saved = load_project(ws.path)
    assert _editable(saved) == original
    assert _editable(ws.project) == original
    assert saved.timeline.duration_sec == 6
    assert [
        (c.id, c.track_id, c.source_id, c.source_start, c.source_end, c.timeline_start)
        for c in saved.clips
    ] == [("parked", "destination", "host-source", 0, 6, 0)]
    assert [origin_track_id_for_clip(saved, c) for c in saved.clips] == ["host"]
    destination = saved.track_by_id("destination")
    assert destination is not None
    assert [
        resolve_clip_audio_path(saved, destination, c).relative_to(tmp_path).as_posix()
        for c in saved.clips
    ] == ["raw/host.wav"]
    assert [e.id for e in saved.edit_decisions] == ["parked-cut"]
    assert [(w.text, w.start, w.end) for w in saved.transcripts[0].words] == [("um", 1.2, 1.6)]
    assert saved.transcripts[0].archived_words == []
    assert saved.editorial.edit_log == []


def test_local_remove_restore_refuses_before_mutation_with_history_undo_guidance(tmp_path):
    ws, original = _approved_parked(tmp_path)
    before = _state(ws)
    head = HistoryService(ws).status().head_id

    with pytest.raises(ValueError) as refused:
        EditService(ws).revert_applied(ws.project.editorial.edit_log[0].id)

    assert getattr(refused.value, "code", None) == "local_restore_requires_history"
    assert str(refused.value) == RESTORE_MESSAGE
    _assert_unchanged(ws, before)
    assert HistoryService(ws).status().head_id == head
    HistoryService(ws).undo(expected_head_id=head)
    _assert_parked_recovered(ws, original, tmp_path)


def test_guarded_history_undo_recovers_original_parked_snapshot(tmp_path):
    ws, original = _approved_parked(tmp_path)
    result = HistoryService(ws).undo(expected_head_id=HistoryService(ws).status().head_id)
    assert result["can_redo"] is True
    _assert_parked_recovered(ws, original, tmp_path)


def _post(client, ws, kind, payload, seq):
    return client.post(
        f"/api/document/command?path={quote(str(ws.path))}",
        json={"type": kind, "payload": payload, "client_id": "restore-contract", "client_seq": seq},
    )


def test_document_http_restore_refusal_and_explicit_guarded_undo(tmp_path):
    ws, original = _approved_parked(tmp_path)
    before = _state(ws)
    head = HistoryService(ws).status().head_id
    with TestClient(create_app()) as client:
        refused = _post(
            client, ws, "RestoreAppliedEdit", {"id": ws.project.editorial.edit_log[0].id}, 1
        )
        assert refused.status_code == 400
        assert refused.headers["X-Sharecut-Error-Code"] == "local_restore_requires_history"
        assert refused.json() == {"detail": RESTORE_MESSAGE}
        _assert_unchanged(ws, before)
        undone = _post(client, ws, "UndoHistory", {"expected_head_id": head}, 2)
        assert undone.status_code == 200
    ws.reload()
    _assert_parked_recovered(ws, original, tmp_path)


def _mcp_refusal(result):
    assert result.is_error is True
    assert [part.text for part in result.content] == [RESTORE_MESSAGE]
    assert result.structured_content == {
        "ok": False,
        "error": RESTORE_MESSAGE,
        "error_code": "local_restore_requires_history",
    }


@pytest.mark.asyncio
async def test_owner_mcp_restore_refusal_and_explicit_guarded_undo(tmp_path):
    ws, original = _approved_parked(tmp_path)
    before = _state(ws)
    head = HistoryService(ws).status().head_id
    async with Client(mcp_server.mcp) as client:
        result = await client.call_tool(
            "revert_applied_edit_tool",
            {"project_path": str(ws.path), "record_id": ws.project.editorial.edit_log[0].id},
        )
        _mcp_refusal(result)
        _assert_unchanged(ws, before)
        undone = await client.call_tool(
            "history_undo", {"project_path": str(ws.path), "expected_head_id": head}
        )
        assert undone.is_error is False
        assert json.loads(undone.content[0].text)["can_redo"] is True
    ws.reload()
    _assert_parked_recovered(ws, original, tmp_path)


@pytest.mark.asyncio
@pytest.mark.parametrize("delivery", ["service", "http", "owner-mcp"])
async def test_exact_range_restore_uses_same_coded_refusal(tmp_path, delivery):
    project = _project(tmp_path)
    REFINE_GATE.mark_done(
        project, notes="Known synthetic transcript fixture; no real-project acceptance"
    )
    ws = ProjectWorkspace.open(save_project(project))
    original = _editable(ws.project)
    service = EditService(ws)
    target = service.selected_range_target(1, 2, ["host"])
    service.edit_selected_range(
        target, "cut", propose=False, reason="nl:range", action_id="exact-action"
    )
    assert [(c.source_start, c.source_end, c.timeline_start) for c in ws.project.clips] == [
        (0, 1, 0),
        (2, 6, 2),
    ]
    assert ws.project.timeline.duration_sec == 6
    record = ws.project.editorial.edit_log[0]
    assert "exact_range" in record.params
    before = _state(ws)
    head = HistoryService(ws).status().head_id
    if delivery == "service":
        with pytest.raises(ValueError) as refused:
            service.revert_applied(record.id)
        assert getattr(refused.value, "code", None) == "local_restore_requires_history"
        assert str(refused.value) == RESTORE_MESSAGE
    elif delivery == "http":
        with TestClient(create_app()) as client:
            refused = _post(client, ws, "RestoreAppliedEdit", {"id": record.id}, 1)
        assert refused.status_code == 400
        assert refused.headers["X-Sharecut-Error-Code"] == "local_restore_requires_history"
        assert refused.json() == {"detail": RESTORE_MESSAGE}
    else:
        async with Client(mcp_server.mcp) as client:
            result = await client.call_tool(
                "revert_applied_edit_tool", {"project_path": str(ws.path), "record_id": record.id}
            )
        _mcp_refusal(result)
    _assert_unchanged(ws, before)
    HistoryService(ws).undo(expected_head_id=head)
    assert _editable(ws.project) == original
    assert _editable(load_project(ws.path)) == original


@pytest.mark.parametrize(
    "peer_shape", ["primary-none", "multiple-recordings", "gap", "overlap", "silent"]
)
def test_guarded_history_undo_restores_all_peer_occurrences(tmp_path, peer_shape):
    project = _project(tmp_path)
    project.tracks.append(
        Track(id="guest", label="Guest", role=TrackRole.DIALOGUE, timeline_empty=True)
    )
    (tmp_path / "raw" / "guest-a.wav").write_bytes((tmp_path / "raw" / "host.wav").read_bytes())
    (tmp_path / "raw" / "guest-b.wav").write_bytes((tmp_path / "raw" / "host.wav").read_bytes())
    project.sources = [
        SourceRecording(id="guest-a", path="raw/guest-a.wav"),
        SourceRecording(id="guest-b", path="raw/guest-b.wav"),
    ]
    if peer_shape == "primary-none":
        project.tracks[1].media = project.tracks[0].media.model_copy(
            update={"path": "raw/guest-a.wav"}
        )
        project.tracks[1].timeline_empty = False
        peer = [Clip(id="peer", track_id="guest", source_start=0, source_end=6, timeline_start=0)]
    elif peer_shape == "multiple-recordings":
        peer = [
            Clip(
                id="peer-a",
                track_id="guest",
                source_id="guest-a",
                source_start=0,
                source_end=1.5,
                timeline_start=0,
            ),
            Clip(
                id="peer-b",
                track_id="guest",
                source_id="guest-b",
                source_start=3,
                source_end=6,
                timeline_start=1.5,
            ),
        ]
    elif peer_shape == "gap":
        peer = [
            Clip(
                id="peer-a",
                track_id="guest",
                source_id="guest-a",
                source_start=0,
                source_end=1.3,
                timeline_start=0,
            ),
            Clip(
                id="peer-b",
                track_id="guest",
                source_id="guest-b",
                source_start=3,
                source_end=6,
                timeline_start=1.7,
            ),
        ]
    elif peer_shape == "overlap":
        peer = [
            Clip(
                id="peer-a",
                track_id="guest",
                source_id="guest-a",
                source_start=0,
                source_end=1.7,
                timeline_start=0,
            ),
            Clip(
                id="peer-b",
                track_id="guest",
                source_id="guest-b",
                source_start=3,
                source_end=6,
                timeline_start=1.3,
            ),
        ]
    else:
        peer = []
    project.clips.extend(peer)
    project.edit_decisions = [_cut("cut", reason="filler:um")]
    REFINE_GATE.mark_done(
        project, notes="Known synthetic transcript fixture; no real-project acceptance"
    )
    ws = ProjectWorkspace.open(save_project(project))
    original = _editable(ws.project)
    expected_peer = [c.model_dump(mode="json") for c in peer]
    assert EditService(ws).approve(["cut"]) == 1
    assert [(c.source_start, c.source_end) for c in ws.project.clips if c.track_id == "host"] == [
        (0, 1),
        (2, 6),
    ]
    before = _state(ws)
    with pytest.raises(ValueError) as refused:
        EditService(ws).revert_applied(ws.project.editorial.edit_log[0].id)
    assert getattr(refused.value, "code", None) == "local_restore_requires_history"
    assert str(refused.value) == RESTORE_MESSAGE
    _assert_unchanged(ws, before)
    HistoryService(ws).undo(expected_head_id=HistoryService(ws).status().head_id)
    assert _editable(ws.project) == original
    saved = load_project(ws.path)
    assert _editable(saved) == original
    assert [
        c.model_dump(mode="json") for c in saved.clips if c.track_id == "guest"
    ] == expected_peer
    assert [
        (c.id, c.source_id, c.source_start, c.source_end, c.timeline_start)
        for c in saved.clips
        if c.track_id == "host"
    ] == [("host", None, 0, 6, 0)]
    assert [
        resolve_clip_audio_path(saved, saved.track_by_id("guest"), c).name
        for c in saved.clips
        if c.track_id == "guest"
    ] == (
        ["guest-a.wav"]
        if peer_shape == "primary-none"
        else []
        if peer_shape == "silent"
        else ["guest-a.wav", "guest-b.wav"]
    )


def test_later_action_requires_undo_of_actual_current_head_first(tmp_path):
    ws, original = _approved_parked(tmp_path)
    cut_head = HistoryService(ws).status().head_id
    cut_before_id = HistoryService(ws).list_entries().groups[-1].before_id
    EditService(ws).cut_time_range("host", 4, 5, reason="nl:range", use_inaudible_opt=False)
    current = _state(ws)
    current_head = HistoryService(ws).status().head_id
    assert current_head != cut_head
    with pytest.raises(ValueError) as refused:
        EditService(ws).revert_applied(ws.project.editorial.edit_log[0].id)
    assert getattr(refused.value, "code", None) == "local_restore_requires_history"
    assert str(refused.value) == RESTORE_MESSAGE
    _assert_unchanged(ws, current)
    with pytest.raises(ValueError) as stale:
        HistoryService(ws).undo(expected_head_id=cut_head)
    assert getattr(stale.value, "code", None) == "history_stale"
    _assert_unchanged(ws, current)
    HistoryService(ws).undo(expected_head_id=current_head)
    assert ws.project.edit_decisions == []
    assert [r.decision_ids for r in ws.project.editorial.edit_log] == [["parked-cut"]]
    assert [(c.source_start, c.source_end, c.timeline_start) for c in ws.project.clips] == [
        (0, 1, 0),
        (2, 6, 1),
    ]
    for _ in range(2):
        if HistoryService(ws).status().head_id == cut_before_id:
            break
        HistoryService(ws).undo(expected_head_id=HistoryService(ws).status().head_id)
    assert HistoryService(ws).status().head_id == cut_before_id
    _assert_parked_recovered(ws, original, tmp_path)


@pytest.mark.asyncio
@pytest.mark.parametrize("delivery", ["service", "http", "owner-mcp"])
async def test_mute_restore_keeps_local_positive_workflow(tmp_path, delivery):
    project = _project(tmp_path)
    mute = _cut("mute", 1, 2, reason="filler:um")
    mute.type = EditDecisionType.MUTE
    project.edit_decisions = [mute]
    REFINE_GATE.mark_done(
        project, notes="Known synthetic transcript fixture; no real-project acceptance"
    )
    ws = ProjectWorkspace.open(save_project(project))
    original_clip = project.clips[0].model_dump(mode="json")
    assert EditService(ws).approve(["mute"]) == 1
    assert len(ws.project.clips[0].mute_regions) == 1
    assert ws.project.editorial.edit_log[0].params["mute"] is True
    record_id = ws.project.editorial.edit_log[0].id
    if delivery == "service":
        result = EditService(ws).revert_applied(record_id)
        assert result["operation"] == "revert_applied_edit"
    elif delivery == "http":
        with TestClient(create_app()) as client:
            result = _post(client, ws, "RestoreAppliedEdit", {"id": record_id}, 1)
        assert result.status_code == 200
        assert result.json()["command"]["payload"]["result"]["operation"] == "revert_applied_edit"
    else:
        async with Client(mcp_server.mcp) as client:
            result = await client.call_tool(
                "revert_applied_edit_tool", {"project_path": str(ws.path), "record_id": record_id}
            )
        assert result.is_error is False
        assert json.loads(result.content[0].text)["operation"] == "revert_applied_edit"
    saved = load_project(ws.path)
    assert saved.clips[0].model_dump(mode="json") == original_clip
    assert saved.timeline.duration_sec == 6
    assert saved.editorial.edit_log == []
    assert saved.edit_decisions == []


@pytest.mark.parametrize(
    "location,bounds",
    [
        (location, bounds)
        for bounds in [
            (float("nan"), 2),
            (1, float("nan")),
            (float("inf"), 2),
            (1, float("inf")),
            (float("-inf"), 2),
            (1, float("-inf")),
            (-1, 2),
            (1, -2),
            (1, 1),
            (2, 1),
        ]
        for location in ("top", "override")
    ]
    + [
        ("top", (1, None)),
        ("override", ("bad", 2)),
        ("override", (1, None)),
        ("override", ({}, 2)),
        ("override", (1, 10**400)),
        ("override", (True, 2)),
    ],
)
def test_restore_rejects_invalid_source_bounds(tmp_path, location, bounds):
    project = _project(tmp_path)
    record = AppliedEditRecord(
        id="invalid-bounds",
        applied_at="2026-01-01T00:00:00+00:00",
        operation="approve_edits",
        track_ids=["host"],
        source_start=1,
        source_end=2,
        params={"mute": True, "per_track_source": {"host": [1, 2]}},
    )
    if location == "top":
        record.source_start, record.source_end = bounds
    else:
        record.params["per_track_source"]["host"] = bounds
    project.editorial.edit_log = [record]
    before = project.model_dump_json()
    for restore in (require_applied_edit_restore, revert_applied_edit):
        with pytest.raises(LocalRestoreRequiresHistory) as refused:
            if restore is revert_applied_edit:
                restore(project, record.id, defaults=load_defaults())
            else:
                restore(project, record.id)
        assert refused.value.code == "local_restore_requires_history"
        assert str(refused.value) == RESTORE_MESSAGE
        assert project.model_dump_json() == before


@pytest.mark.parametrize(
    "mapping",
    [
        None,
        [],
        "bad",
        1,
        {"host": None},
        {"host": "12"},
        {"host": [1]},
        {"host": [1, 2, 3]},
        {"host": {"start": 1, "end": 2}},
        {"host": [1, 2], "unused": ["NaN", 2]},
        {"host": [1, 2], "unused": "bad"},
    ],
)
def test_restore_rejects_complete_malformed_mapping(tmp_path, mapping, monkeypatch):
    project = _project(tmp_path)
    project.editorial.edit_log = [
        AppliedEditRecord(
            id="invalid-mapping",
            applied_at="2026-01-01T00:00:00+00:00",
            operation="approve_edits",
            track_ids=["host"],
            source_start=1,
            source_end=2,
            params={"mute": True, "per_track_source": mapping},
        )
    ]
    project.clips[0].mute_regions = [ClipMuteRegion(start_s=1, end_s=2)]
    before = project.model_dump_json()

    def unexpected_subtraction(*_args):
        pytest.fail("invalid complete plan reached subtraction")

    monkeypatch.setattr("podcast_mcp.edits.edit_log.subtract_source_mute", unexpected_subtraction)
    with pytest.raises(LocalRestoreRequiresHistory) as refused:
        revert_applied_edit(project, "invalid-mapping", defaults=load_defaults())
    assert str(refused.value) == RESTORE_MESSAGE
    assert project.model_dump_json() == before


@pytest.mark.parametrize(
    "params", [{}, {"per_track_source": {}}, {"per_track_source": {"host": ("1", "2")}}]
)
def test_restore_removes_only_bounded_intersection(tmp_path, params):
    project = _project(tmp_path)
    fill = RoomToneFill(start_s=5, end_s=5.5)
    region = ClipMuteRegion(start_s=0.5, end_s=2.5, fill=fill, fade_out_ms=7, fade_in_ms=9)
    outside = ClipMuteRegion(start_s=4, end_s=5, fade_out_ms=3, fade_in_ms=4)
    project.clips[0].mute_regions = [region, outside]
    geometry = (
        project.clips[0].source_start,
        project.clips[0].source_end,
        project.clips[0].timeline_start,
    )
    project.editorial.edit_log = [
        AppliedEditRecord(
            id="bounded",
            applied_at="2026-01-01T00:00:00+00:00",
            operation="approve_edits",
            track_ids=["host"],
            source_start=1,
            source_end=2,
            params={"mute": True, **params},
        )
    ]
    assert require_applied_edit_restore(project, "bounded") is project.editorial.edit_log[0]
    result = revert_applied_edit(project, "bounded", defaults=load_defaults())
    assert result["operation"] == "revert_applied_edit"
    assert project.clips[0].mute_regions == [
        region.model_copy(update={"end_s": 1}),
        region.model_copy(update={"start_s": 2}),
        outside,
    ]
    assert (
        project.clips[0].source_start,
        project.clips[0].source_end,
        project.clips[0].timeline_start,
    ) == geometry
    assert project.timeline.duration_sec == 6
    assert project.editorial.edit_log == []


def test_persisted_invalid_later_track_refuses_before_history(tmp_path, monkeypatch):
    project = _project(tmp_path)
    guest = project.tracks[0].model_copy(update={"id": "guest", "label": "Guest"})
    guest.media = guest.media.model_copy(update={"path": "raw/guest.wav"})
    project.tracks.append(guest)
    (project.workspace_path() / "raw" / "guest.wav").write_bytes(
        (project.workspace_path() / "raw" / "host.wav").read_bytes()
    )
    project.clips.append(project.clips[0].model_copy(update={"id": "guest", "track_id": "guest"}))
    mute = _cut("mute", 1, 2, reason="filler:um")
    mute.type = EditDecisionType.MUTE
    project.edit_decisions = [mute]
    project.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="um", start=1.2, end=1.6)])
    ]
    REFINE_GATE.mark_done(
        project, notes="Known synthetic transcript fixture; no real-project acceptance"
    )
    ws = ProjectWorkspace.open(save_project(project))
    assert EditService(ws).approve(["mute"]) == 1
    record = ws.project.editorial.edit_log[0]
    record.track_ids = ["host", "guest"]
    record.params["per_track_source"] = {"host": [1, 2], "guest": ["NaN", 2]}
    for clip in ws.project.clips:
        clip.mute_regions = [
            ClipMuteRegion(
                start_s=0.5,
                end_s=2.5,
                fill=RoomToneFill(start_s=5, end_s=5.5),
                fade_out_ms=7,
                fade_in_ms=9,
            ),
            ClipMuteRegion(start_s=4, end_s=5, fade_out_ms=3, fade_in_ms=4),
        ]
    ws.project.render.last_completed_step = "render_tracks"
    ws.project.render.artifacts.premix = "artifacts/premix.wav"
    ws.project.render.last_reconciliation_hash = "preserved-render-hash"
    ws.save()
    (tmp_path / "artifacts" / "premix.wav").write_bytes(b"preserved-premix")
    (tmp_path / "artifacts" / "host.renderhash").write_bytes(b"preserved-sidecar")
    ws = ProjectWorkspace.open(ws.path)
    before_memory = ws.project.model_dump_json()
    before_files = {
        p.relative_to(tmp_path): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()
    }
    assert any(str(p).startswith("history/snapshots/") for p in before_files)
    assert any(str(p).startswith("transcripts/") for p in before_files)

    def unexpected_mutation(*_args, **_kwargs):
        pytest.fail("invalid complete plan started workspace mutation/history")

    monkeypatch.setattr(ws, "mutate", unexpected_mutation)
    with pytest.raises(LocalRestoreRequiresHistory) as refused:
        EditService(ws).revert_applied(record.id)
    assert refused.value.code == "local_restore_requires_history"
    assert str(refused.value) == RESTORE_MESSAGE
    assert ws.project.model_dump_json() == before_memory
    assert load_project(ws.path).model_dump_json() == before_memory
    assert {
        p.relative_to(tmp_path): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()
    } == before_files
