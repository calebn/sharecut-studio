import pytest

from podcast_mcp.models import Clip, load_project
from podcast_mcp.services.app import ProjectWorkspace


@pytest.mark.parametrize("saved", [(2, 0), (0, 2)])
def test_service_checks_both_fades_after_adopting_another_writer(minimal_project, saved):
    from podcast_mcp.edits.clip_fades import ClipFadeBaseline, ClipFadeChangedError
    from podcast_mcp.services.document import EditService

    ws = ProjectWorkspace.open(minimal_project)
    ws.project.timeline.clips = [
        Clip(
            id="fade",
            track_id="host",
            source_start=0,
            source_end=5,
            timeline_start=0,
            fade_in_ms=0,
            fade_out_ms=0,
        )
    ]
    ws.save()
    stale = EditService(ProjectWorkspace.open(minimal_project))
    EditService(ProjectWorkspace.open(minimal_project)).set_clip_fade("fade", *saved)
    before = minimal_project.read_bytes()
    with pytest.raises(ClipFadeChangedError, match="Nothing was saved"):
        stale.set_clip_fade("fade", 1, 1, expected=ClipFadeBaseline(0, 0))
    assert minimal_project.read_bytes() == before
    assert (stale.ws.project.clips[0].fade_in_ms, stale.ws.project.clips[0].fade_out_ms) == saved


def test_fade_baseline_allows_unrelated_change_and_refuses_missing_clip(minimal_project):
    from podcast_mcp.edits.clip_fades import ClipFadeBaseline, ClipFadeChangedError
    from podcast_mcp.services.document import EditService

    ws = ProjectWorkspace.open(minimal_project)
    ws.project.timeline.clips = [
        Clip(
            id="fade",
            track_id="host",
            source_start=0,
            source_end=5,
            timeline_start=0,
            fade_in_ms=0,
            fade_out_ms=0,
        )
    ]
    ws.save()
    service = EditService(ws)
    ws.mutate("before label", "after label", lambda p: setattr(p, "name", "Other edit"))
    service.set_clip_fade("fade", 0, 1, expected=ClipFadeBaseline(0, 0))
    assert load_project(minimal_project).clips[0].fade_out_ms == 1
    before = minimal_project.read_bytes()
    with pytest.raises(ClipFadeChangedError):
        service.set_clip_fade("gone", 0, 1, expected=ClipFadeBaseline(0, 0))
    assert minimal_project.read_bytes() == before


@pytest.mark.parametrize(
    "expected",
    [
        None,
        {},
        {"fade_in_ms": 0},
        {"fade_in_ms": -1, "fade_out_ms": 0},
        {"fade_in_ms": 0.5, "fade_out_ms": 0},
        {"fade_in_ms": True, "fade_out_ms": 0},
    ],
)
def test_document_fade_requires_a_complete_saved_pair(expected):
    from pydantic import ValidationError

    from podcast_mcp.services.document_sync.payloads import validate_payload

    payload = {"clip_id": "fade", "fade_in_ms": 0, "fade_out_ms": 1}
    if expected is not None:
        payload["expected"] = expected
    with pytest.raises(ValidationError):
        validate_payload("SetClipFade", payload)
