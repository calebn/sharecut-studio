"""Volume-envelope selection, baseline comparison, and parameter-scoped replace."""

from __future__ import annotations

from podcast_mcp.edits.envelopes import envelope_matches_baseline, volume_envelope_baseline
from podcast_mcp.models import AutomationEnvelope, AutomationPoint
from podcast_mcp.services import PipelineService, ProjectWorkspace


def _with_pan_before_volume(minimal_project) -> ProjectWorkspace:
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.automation_envelopes = [
        AutomationEnvelope(
            track_id="host",
            parameter="pan",
            points=[AutomationPoint(id="pan-0", time=0.0, value=-1.0)],
        ),
        AutomationEnvelope(
            track_id="host",
            parameter="gain",
            points=[AutomationPoint(id="vol-0", time=0.0, value=0.5)],
        ),
    ]
    ws.save()
    return ProjectWorkspace.open(minimal_project)


def test_volume_envelope_for_skips_other_parameters(minimal_project):
    ws = _with_pan_before_volume(minimal_project)
    envelope = ws.project.volume_envelope_for("host")
    assert envelope is not None
    assert envelope.parameter == "gain"
    assert ws.project.volume_envelope_for("guest") is None
    assert AutomationEnvelope(track_id="host", parameter="").is_volume


def test_baseline_matches_only_the_volume_envelope(minimal_project):
    ws = _with_pan_before_volume(minimal_project)
    baseline = volume_envelope_baseline(ws.project, "host")
    assert baseline == [{"id": "vol-0", "time": 0.0, "value": 0.5}]
    assert envelope_matches_baseline(ws.project, "host", baseline)
    assert not envelope_matches_baseline(
        ws.project, "host", [{"id": "pan-0", "time": 0.0, "value": -1.0}]
    )
    assert volume_envelope_baseline(ws.project, "guest") == []
    assert envelope_matches_baseline(ws.project, "guest", [])
    assert not envelope_matches_baseline(ws.project, "guest", baseline)


def test_set_envelope_replaces_only_the_volume_envelope(minimal_project):
    ws = _with_pan_before_volume(minimal_project)
    PipelineService(ws).set_envelope("host", [{"id": "vol-1", "time": 1.0, "value": 1.0}])
    envelopes = ProjectWorkspace.open(minimal_project).project.automation_envelopes
    assert [(e.parameter, [p.id for p in e.points]) for e in envelopes] == [
        ("pan", ["pan-0"]),
        ("gain", ["vol-1"]),
    ]


def test_set_envelope_appends_volume_when_only_pan_exists(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.automation_envelopes = [AutomationEnvelope(track_id="host", parameter="pan")]
    ws.save()
    PipelineService(ws).set_envelope("host", [{"id": "v", "time": 0.0, "value": 1.0}])
    envelopes = ProjectWorkspace.open(minimal_project).project.automation_envelopes
    assert [e.parameter for e in envelopes] == ["pan", "volume"]
