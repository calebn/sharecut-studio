from __future__ import annotations

import os

import pytest

from pause_policy_public_helpers import configure, defaults, files, project, workspace
from podcast_mcp.edits.edit_log import archive_timeline_op
from podcast_mcp.edits.fillers import _CutRejected
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.models import SourceRecording, load_project
from podcast_mcp.services.document import EditService
from test_pause_evidence_identity_contract import _parked_music
from test_pause_recording_identity_contract import _sampled_original_deleted, _support
from test_source_remove_geometry import _cut


def _hardlink(tmp_path):
    original = tmp_path / "raw" / "host.wav"
    alias = tmp_path / "raw" / "host-hardlink.wav"
    os.link(original, alias)
    assert original.samefile(alias)
    assert original.resolve() != alias.resolve()
    return "raw/host-hardlink.wav"


@pytest.mark.parametrize("via_source", [True, False])
def test_hardlink_replay_holds_without_mutation(tmp_path, monkeypatch, via_source):
    configure(monkeypatch, defaults(acoustic=False))
    result = project(tmp_path)
    result.sources.append(SourceRecording(id="alias", path=_hardlink(tmp_path), duration_sec=6))
    _parked_music(result, "alias")
    if not via_source:
        result.track_by_id("music").media.path = "raw/host-hardlink.wav"
        result.clips[-1].source_id = None
    result.edit_decisions = [_cut()]
    ws = workspace(result)
    before_files = files(tmp_path)
    before_model = ws.project.model_dump(mode="json")
    with pytest.raises(ScopeChangedAtApproval) as held:
        EditService(ws).approve(["cut"], confirm_cut_speech=True)
    assert held.value.ids == ("cut",)
    assert held.value.held[0].reason == "source_geometry"
    assert files(tmp_path) == before_files
    assert ws.project.model_dump(mode="json") == before_model
    assert load_project(ws.path).model_dump(mode="json") == before_model


@pytest.mark.parametrize("declared_duration", [None, 0.1, 6])
def test_implicit_hardlink_replay_holds_without_mutation(tmp_path, monkeypatch, declared_duration):
    configure(monkeypatch, defaults(acoustic=False))
    result = project(tmp_path)
    result.sources.append(SourceRecording(id="alias", path=_hardlink(tmp_path), duration_sec=6))
    _parked_music(result, "alias")
    music = result.track_by_id("music")
    music.media.path = "raw/host-hardlink.wav"
    music.media.duration_sec = declared_duration
    music.timeline_empty = False
    result.clips.pop()
    result.edit_decisions = [_cut()]
    ws = workspace(result)
    before_files = files(tmp_path)
    before_model = ws.project.model_dump(mode="json")
    with pytest.raises(ScopeChangedAtApproval) as held:
        EditService(ws).approve(["cut"], confirm_cut_speech=True)
    assert held.value.ids == ("cut",)
    assert held.value.held[0].reason == "source_geometry"
    assert files(tmp_path) == before_files
    assert ws.project.model_dump(mode="json") == before_model
    assert load_project(ws.path).model_dump(mode="json") == before_model


def test_own_implicit_playback_and_parked_alias_hold(tmp_path, monkeypatch):
    configure(monkeypatch, defaults(acoustic=False))
    result = project(tmp_path)
    result.sources.append(SourceRecording(id="alias", path=_hardlink(tmp_path), duration_sec=6))
    _parked_music(result, "alias")
    result.clips.pop(0)
    result.track_by_id("host").timeline_empty = False
    result.edit_decisions = [_cut()]
    ws = workspace(result)
    before_files = files(tmp_path)
    before_model = ws.project.model_dump(mode="json")
    with pytest.raises(ScopeChangedAtApproval) as held:
        EditService(ws).approve(["cut"], confirm_cut_speech=True)
    assert held.value.held[0].reason == "source_geometry"
    assert files(tmp_path) == before_files
    assert ws.project.model_dump(mode="json") == before_model
    assert load_project(ws.path).model_dump(mode="json") == before_model


@pytest.mark.parametrize("silent_alias", [True, False])
def test_unclipped_silent_alias_or_different_media_is_consumable(
    tmp_path, monkeypatch, silent_alias
):
    configure(monkeypatch, defaults(acoustic=False))
    result = project(tmp_path)
    result.sources.append(SourceRecording(id="alias", path=_hardlink(tmp_path), duration_sec=6))
    _parked_music(result, "alias")
    result.clips.pop()
    music = result.track_by_id("music")
    if silent_alias:
        music.media.path = "raw/host-hardlink.wav"
    music.timeline_empty = silent_alias
    result.edit_decisions = [_cut()]
    ws = workspace(result)
    assert EditService(ws).approve(["cut"], confirm_cut_speech=True) == 1
    assert load_project(ws.path).timeline.duration_sec == 5


def test_single_hardlink_placement_is_consumable(tmp_path, monkeypatch):
    configure(monkeypatch, defaults(acoustic=False))
    result = project(tmp_path)
    result.sources.append(SourceRecording(id="alias", path=_hardlink(tmp_path), duration_sec=6))
    result.clips[0].source_id = "alias"
    result.edit_decisions = [_cut()]
    ws = workspace(result)
    assert EditService(ws).approve(["cut"], confirm_cut_speech=True) == 1
    saved = load_project(ws.path)
    assert saved.timeline.duration_sec == 5
    assert [(c.source_start, c.source_end, c.timeline_start, c.source_id) for c in saved.clips] == [
        (0, 1, 0, "alias"),
        (2, 6, 1, "alias"),
    ]


def test_hardlink_pad_receipt_excludes_the_actual_original_sample(tmp_path):
    result = _sampled_original_deleted(tmp_path)
    control = _support(result)
    assert not isinstance(control, _CutRejected)
    assert control.seconds == pytest.approx(0.65)
    result.sources.append(SourceRecording(id="alias", path=_hardlink(tmp_path), duration_sec=6))
    archive_timeline_op(
        result,
        operation="fill_with_room_tone",
        track_ids=["host"],
        params={
            "pad_samples": [
                {
                    "track_id": "host",
                    "source_id": "alias",
                    "source_start": 2,
                    "source_end": 2.25,
                }
            ]
        },
    )
    support = _support(result)
    assert not isinstance(support, _CutRejected)
    assert support.seconds == pytest.approx(0.4)
    assert [(float(p.source_start), float(p.source_end)) for p in support.pieces] == [
        pytest.approx((0.2, 0.3)),
        pytest.approx((4.7, 5)),
    ]
