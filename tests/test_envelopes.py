"""Volume-envelope selection, baseline comparison, and parameter-scoped replace."""

from __future__ import annotations

from podcast_mcp.edits.envelopes import envelope_matches_baseline, volume_envelope_baseline
from podcast_mcp.models import AutomationEnvelope, AutomationPoint
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.pipeline import PipelineService


def _with_pan_before_volume(envelope_project) -> ProjectWorkspace:
    ws = ProjectWorkspace.open(envelope_project)
    ws.project.automation_envelopes = [
        AutomationEnvelope(
            track_id="host",
            parameter="pan",
            points=[AutomationPoint(id="pan-0", time=0.0, value=-1.0)],
        ),
        AutomationEnvelope(
            track_id="host",
            parameter="volume",
            points=[AutomationPoint(id="vol-0", time=0.0, value=0.5)],
        ),
    ]
    ws.save()
    return ProjectWorkspace.open(envelope_project)


def test_volume_envelope_for_skips_other_parameters(envelope_project):
    ws = _with_pan_before_volume(envelope_project)
    envelope = ws.project.volume_envelope_for("host")
    assert envelope is not None
    assert envelope.parameter == "volume"
    assert ws.project.volume_envelope_for("guest") is None
    assert not AutomationEnvelope(track_id="host", parameter="").is_volume
    assert not AutomationEnvelope(track_id="host", parameter="gain").is_volume


def test_baseline_matches_only_the_volume_envelope(envelope_project):
    ws = _with_pan_before_volume(envelope_project)
    baseline = volume_envelope_baseline(ws.project, "host")
    assert baseline == [{"id": "vol-0", "time": 0.0, "value": 0.5}]
    assert envelope_matches_baseline(ws.project, "host", baseline)
    assert not envelope_matches_baseline(
        ws.project, "host", [{"id": "pan-0", "time": 0.0, "value": -1.0}]
    )
    assert volume_envelope_baseline(ws.project, "guest") == []
    assert envelope_matches_baseline(ws.project, "guest", [])
    assert not envelope_matches_baseline(ws.project, "guest", baseline)


def test_set_envelope_replaces_only_the_volume_envelope(envelope_project):
    ws = _with_pan_before_volume(envelope_project)
    PipelineService(ws).set_envelope("host", [{"id": "vol-1", "time": 1.0, "value": 1.0}])
    envelopes = ProjectWorkspace.open(envelope_project).project.automation_envelopes
    assert [(e.parameter, [p.id for p in e.points]) for e in envelopes] == [
        ("pan", ["pan-0"]),
        ("volume", ["vol-1"]),
    ]


def test_set_envelope_appends_volume_when_only_pan_exists(envelope_project):
    ws = ProjectWorkspace.open(envelope_project)
    ws.project.automation_envelopes = [AutomationEnvelope(track_id="host", parameter="pan")]
    ws.save()
    PipelineService(ws).set_envelope("host", [{"id": "v", "time": 0.0, "value": 1.0}])
    envelopes = ProjectWorkspace.open(envelope_project).project.automation_envelopes
    assert [e.parameter for e in envelopes] == ["pan", "volume"]


def test_baseline_rejects_reordered_coincident_points(envelope_project):
    ws = ProjectWorkspace.open(envelope_project)
    ws.project.automation_envelopes = [
        AutomationEnvelope(
            track_id="host",
            points=[
                AutomationPoint(id="before", time=1, value=0),
                AutomationPoint(id="after", time=1, value=1),
            ],
        )
    ]
    baseline = volume_envelope_baseline(ws.project, "host")
    assert envelope_matches_baseline(ws.project, "host", baseline)
    assert not envelope_matches_baseline(ws.project, "host", reversed(baseline))


def test_reordered_envelope_command_conflicts_without_overwrite(envelope_project):
    import pytest

    from podcast_mcp.services.document import HistoryService
    from podcast_mcp.services.document_sync import DocumentSyncService
    from podcast_mcp.services.document_sync.commands import DocumentCommand
    from podcast_mcp.services.document_sync.errors import DocumentConflictError

    ws = ProjectWorkspace.open(envelope_project)
    ws.project.automation_envelopes = [
        AutomationEnvelope(
            track_id="host",
            points=[
                AutomationPoint(id="first", time=1, value=0),
                AutomationPoint(id="last", time=1, value=1),
            ],
        )
    ]
    ws.save()
    original = volume_envelope_baseline(ws.project, "host")
    service = DocumentSyncService.open(envelope_project)
    history = HistoryService(ProjectWorkspace.open(envelope_project)).list_entries()
    seq = service.document_snapshot()["server_seq"]
    with pytest.raises(DocumentConflictError):
        service.submit(
            DocumentCommand(
                type="SetEnvelope",
                client_id="stale",
                role="viewer",
                client_seq=1,
                payload={
                    "track_id": "host",
                    "points": [],
                    "expected_points": list(reversed(original)),
                },
            )
        )
    stored = ProjectWorkspace.open(envelope_project)
    assert volume_envelope_baseline(stored.project, "host") == original
    assert HistoryService(stored).list_entries() == history
    assert service.document_snapshot()["server_seq"] == seq


def test_envelope_point_validation_rejects_nonfinite_and_negative_time():
    import pytest
    from pydantic import ValidationError

    from podcast_mcp.services.document_sync.payloads import (
        EnvelopePoint,
        ExpectedEnvelopePoint,
        validate_payload,
    )

    for cls in (AutomationPoint, EnvelopePoint, ExpectedEnvelopePoint):
        for point in (
            {"id": "p", "time": -1, "value": 1},
            {"id": "p", "time": float("nan"), "value": 1},
            {"id": "p", "time": float("inf"), "value": 1},
            {"id": "p", "time": 0, "value": float("nan")},
            {"id": "p", "time": 0, "value": float("inf")},
        ):
            with pytest.raises(ValidationError):
                cls(**point)
        assert cls(id="signed", time=0, value=-1).value == -1
        assert cls(id="uncapped", time=0, value=2).value == 2
    for field in ("points", "expected_points"):
        with pytest.raises(ValidationError):
            validate_payload(
                "SetEnvelope",
                {
                    "track_id": "host",
                    "points": [],
                    "expected_points": [],
                    field: [{"id": "p", "time": -1, "value": 1}],
                },
            )


def test_service_cannot_attach_envelope_after_track_deletion(envelope_project):
    import pytest

    from podcast_mcp.services.document import HistoryService

    stale = ProjectWorkspace.open(envelope_project)
    deleted = ProjectWorkspace.open(envelope_project)
    deleted.project.timeline.tracks = [t for t in deleted.project.tracks if t.id != "host"]
    deleted.project.timeline.clips = [c for c in deleted.project.clips if c.track_id != "host"]
    deleted.save()
    history = HistoryService(deleted).list_entries()
    before = envelope_project.read_bytes()
    with pytest.raises(ValueError, match=r"track.*host.*no longer exists"):
        PipelineService(stale).set_envelope("host", [{"id": "orphan", "time": 0, "value": 1}])
    current = ProjectWorkspace.open(envelope_project)
    assert current.project.track_by_id("host") is None
    assert current.project.volume_envelope_for("host") is None
    assert HistoryService(current).list_entries() == history
    assert envelope_project.read_bytes() == before


def test_command_cannot_attach_envelope_after_track_deletion(envelope_project):
    import pytest

    from podcast_mcp.services.document import HistoryService
    from podcast_mcp.services.document_sync import DocumentSyncService
    from podcast_mcp.services.document_sync.commands import DocumentCommand
    from podcast_mcp.services.document_sync.errors import DocumentConflictError

    service = DocumentSyncService.open(envelope_project)
    seq = service.document_snapshot()["server_seq"]
    deleted = ProjectWorkspace.open(envelope_project)
    deleted.project.timeline.tracks = [t for t in deleted.project.tracks if t.id != "host"]
    deleted.project.timeline.clips = [c for c in deleted.project.clips if c.track_id != "host"]
    deleted.save()
    history = HistoryService(deleted).list_entries()
    before = envelope_project.read_bytes()
    with pytest.raises(DocumentConflictError, match=r"track.*host.*no longer exists"):
        service.submit(
            DocumentCommand(
                type="SetEnvelope",
                client_id="stale",
                role="viewer",
                client_seq=1,
                payload={
                    "track_id": "host",
                    "points": [{"id": "orphan", "time": 0, "value": 1}],
                    "expected_points": [],
                },
            )
        )
    current = ProjectWorkspace.open(envelope_project)
    assert current.project.track_by_id("host") is None
    assert current.project.volume_envelope_for("host") is None
    assert HistoryService(current).list_entries() == history
    assert envelope_project.read_bytes() == before
    assert service.document_snapshot()["server_seq"] == seq
