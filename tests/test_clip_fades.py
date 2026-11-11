import pytest

from podcast_mcp.edits.clip_fades import ClipFadeBaseline, ClipFadeEdit
from podcast_mcp.models import Clip, load_project
from podcast_mcp.services.app import ProjectWorkspace


@pytest.mark.parametrize("saved", [(2, 0), (0, 2)])
def test_service_checks_both_fades_after_adopting_another_writer(minimal_project, saved):
    from podcast_mcp.edits.clip_fades import ClipFadeBaseline, ClipFadeChangedError
    from podcast_mcp.services.document import TimelineService

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
    stale = TimelineService(ProjectWorkspace.open(minimal_project))
    TimelineService(ProjectWorkspace.open(minimal_project)).set_clip_fade("fade", *saved)
    before = minimal_project.read_bytes()
    with pytest.raises(ClipFadeChangedError, match="Nothing was saved"):
        stale.set_clip_fade("fade", 1, 1, expected=ClipFadeBaseline(0, 0))
    assert minimal_project.read_bytes() == before
    assert (stale.ws.project.clips[0].fade_in_ms, stale.ws.project.clips[0].fade_out_ms) == saved


def test_fade_baseline_allows_unrelated_change_and_refuses_missing_clip(minimal_project):
    from podcast_mcp.edits.clip_fades import ClipFadeBaseline, ClipFadeChangedError
    from podcast_mcp.services.document import TimelineService

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
    service = TimelineService(ws)
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


def _two_clips(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.timeline.clips = [
        Clip(
            id=cid,
            track_id="host",
            source_start=start,
            source_end=start + 5,
            timeline_start=start,
            fade_in_ms=10,
            fade_out_ms=out,
        )
        for cid, start, out in (("a", 0, 0), ("b", 5, 20))
    ]
    ws.save()


def _fades(minimal_project):
    return [(c.fade_in_ms, c.fade_out_ms) for c in load_project(minimal_project).clips]


def _target(cid, fade_in, fade_out, expected):
    return {
        "clip_id": cid,
        "fade_in_ms": fade_in,
        "fade_out_ms": fade_out,
        "expected": {"fade_in_ms": expected[0], "fade_out_ms": expected[1]},
    }


def test_clips_fade_sets_every_clip_clamped_in_one_history_step(minimal_project):
    from podcast_mcp.services.document import HistoryService, TimelineService

    _two_clips(minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    before = len(HistoryService(ws).list_entries().entries)
    result = TimelineService(ws).set_clips_fade(
        [
            ClipFadeEdit("a", 15, 7, ClipFadeBaseline(10, 0)),
            ClipFadeEdit("b", 15, 9000, ClipFadeBaseline(10, 20)),
        ]
    )
    assert result["operation"] == "set_clips_fade"
    assert _fades(minimal_project) == [(15, 7), (15, 4985)]
    assert len(HistoryService(ws).list_entries().entries) == before + 2


def test_clips_fade_refuses_every_clip_when_one_is_stale(minimal_project):
    from podcast_mcp.edits.clip_fades import ClipFadeChangedError
    from podcast_mcp.services.document import TimelineService

    _two_clips(minimal_project)
    before = minimal_project.read_bytes()
    with pytest.raises(ClipFadeChangedError, match="Nothing was saved"):
        TimelineService(ProjectWorkspace.open(minimal_project)).set_clips_fade(
            [
                ClipFadeEdit("a", 15, 7, ClipFadeBaseline(10, 0)),
                ClipFadeEdit("b", 15, 7, ClipFadeBaseline(10, 21)),
            ]
        )
    assert minimal_project.read_bytes() == before


def test_clips_fade_command_rejects_a_repeated_or_empty_target():
    from pydantic import ValidationError

    from podcast_mcp.services.document_sync.payloads import validate_payload

    one = _target("a", 1, 1, (0, 0))
    for fades in ([], [one, one]):
        with pytest.raises(ValidationError):
            validate_payload("SetClipsFade", {"fades": fades})


def test_clips_fade_tool_adds_the_delta_and_undoes_in_one_step(minimal_project):
    import json

    from podcast_mcp.mcp.tools.timeline import set_clips_fade_tool
    from podcast_mcp.services.document import HistoryService

    _two_clips(minimal_project)
    out = json.loads(set_clips_fade_tool(str(minimal_project), ["a", "b"], 5, -30))
    assert out["operation"] == "set_clips_fade"
    assert _fades(minimal_project) == [(15, 0), (15, 0)]
    HistoryService(ProjectWorkspace.open(minimal_project)).undo()
    assert _fades(minimal_project) == [(10, 0), (10, 20)]


def test_clips_fade_tool_refuses_an_unknown_clip(minimal_project):
    from podcast_mcp.mcp.tools.timeline import set_clips_fade_tool
    from podcast_mcp.util.coded_error import CodedValueError

    _two_clips(minimal_project)
    with pytest.raises(CodedValueError, match="unknown clip_id"):
        set_clips_fade_tool(str(minimal_project), ["a", "gone"], 5)
