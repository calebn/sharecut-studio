"""Error codes that name a project-data inconsistency never read as a missing request target (#1855)."""

from __future__ import annotations

import pytest

from podcast_mcp.services.document_sync.errors import names_missing_target
from podcast_mcp.util.coded_error import CodedValueError


def test_data_inconsistency_codes_are_not_a_missing_target() -> None:
    for code in ("pause_edit_missing", "clip_source_missing"):
        assert not names_missing_target(CodedValueError("x", code=code))


def test_a_clip_with_an_unlisted_source_is_a_data_inconsistency_not_a_missing_target() -> None:
    from podcast_mcp.engines.timeline_render import _source_audio_path
    from podcast_mcp.models import EpisodeProject, Track, TrackRole

    project = EpisodeProject.create("t", "/tmp/ws")
    track = Track(id="host", role=TrackRole.DIALOGUE, label="Host")
    with pytest.raises(CodedValueError) as raised:
        _source_audio_path(project, track, "ghost", owner="clip c1")
    assert raised.value.code == "clip_source_missing"
    assert not names_missing_target(raised.value)


def test_a_clip_whose_source_left_the_project_reads_as_the_same_inconsistency() -> None:
    from podcast_mcp.edits.clips_ops import source_duration_sec
    from podcast_mcp.models import Clip, EpisodeProject, Track, TrackRole

    project = EpisodeProject.create("t", "/tmp/ws")
    project.tracks.append(Track(id="host", role=TrackRole.DIALOGUE, label="Host"))
    clip = Clip(
        id="c1",
        track_id="host",
        source_id="ghost",
        source_start=0.0,
        source_end=1.0,
        timeline_start=0.0,
    )
    with pytest.raises(CodedValueError) as raised:
        source_duration_sec(project, clip)
    assert raised.value.code == "clip_source_missing"
    assert not names_missing_target(raised.value)


def test_caller_actionable_argument_errors_carry_their_own_codes(tmp_path) -> None:
    from podcast_mcp.config.defaults import load_defaults
    from podcast_mcp.edits.conversation_align import acoustic_clip_offset
    from podcast_mcp.edits.retained_bleed_alignment import plan_retained_bleed_alignment
    from podcast_mcp.edits.timeline_ops import move_clips
    from podcast_mcp.models import EpisodeProject

    project = EpisodeProject.create("t", "/tmp/ws")
    wav = tmp_path / "a.wav"
    with pytest.raises(CodedValueError) as moves:
        move_clips(project, ["not an object"], defaults=load_defaults())
    assert moves.value.code == "clip_move_invalid"
    with pytest.raises(CodedValueError) as starts:
        acoustic_clip_offset(wav, wav, starts=[1.0, 2.0], source_starts=[1.0])
    assert starts.value.code == "align_starts_mismatch"
    with pytest.raises(CodedValueError) as window:
        plan_retained_bleed_alignment(
            project, override_placement_lock=True, defaults=load_defaults()
        )
    assert window.value.code == "placement_window_required"


def test_a_missing_edit_the_command_names_still_is() -> None:
    assert names_missing_target(CodedValueError("x", code="edit_not_found"))


def test_share_identity_busy_503_keeps_its_error_code(monkeypatch: pytest.MonkeyPatch) -> None:
    pytest.importorskip("fastapi")
    from filelock import Timeout
    from starlette.applications import Starlette
    from starlette.responses import PlainTextResponse
    from starlette.routing import Route
    from starlette.testclient import TestClient

    from podcast_mcp.gui import middleware_share_identity as mod

    def busy(*_args: object, **_kwargs: object) -> None:
        raise Timeout("registry.lock")

    monkeypatch.setattr(mod, "lookup_share", busy)
    app = Starlette(routes=[Route("/api/review/{token}/x", lambda _r: PlainTextResponse("ok"))])
    app.add_middleware(mod.ShareIdentityMiddleware)
    res = TestClient(app).get("/api/review/tok/x")
    assert res.status_code == 503
    assert res.headers["X-Sharecut-Error-Code"] == "project_busy"
