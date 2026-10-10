from __future__ import annotations

from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from pause_policy_public_helpers import room, voice, write_wav
from podcast_mcp.edits.pending_preview import apply_for_suggested, resolve_pending_preview
from podcast_mcp.edits.transcript_refine_status import mark_refine_done
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService
from podcast_mcp.util.coded_error import CodedError


def _pause(edit_id: str = "pause", start: float = 1.0, end: float = 1.3) -> EditDecision:
    return EditDecision(
        id=edit_id,
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=start,
        end=end,
        reason="pause:0.3s",
        review_required=False,
        scope="session",
        boundary_mode="exact",
    )


def _workspace(tmp_path: Path) -> ProjectWorkspace:
    project = EpisodeProject.create("pause geometry", str(tmp_path))
    project.tracks = [
        Track(
            id=track_id,
            label=track_id.title(),
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=f"raw/{track_id}.wav", duration_sec=9.0),
        )
        for track_id in ("host", "guest")
    ]
    project.clips = [
        Clip(
            id=f"{track_id}-main",
            track_id=track_id,
            source_start=0.0,
            source_end=9.0,
            timeline_start=0.0,
        )
        for track_id in ("host", "guest")
    ]
    project.timeline.duration_sec = 9.0
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="before", start=0.4, end=0.6),
                *[
                    TranscriptWord(text=f"word-{n}", start=float(n), end=float(n) + 0.2)
                    for n in range(2, 8)
                ],
            ],
        )
    ]
    for index, track in enumerate(project.tracks):
        audio = room(9, seed=1214 + index)
        voice(audio, 0.4, 0.6)
        for n in range(2, 8):
            voice(audio, float(n), float(n) + 0.2)
        write_wav(tmp_path / track.media.path, audio)
    project.edit_decisions = [_pause()]
    path = tmp_path / "episode.project.json"
    mark_refine_done(project, notes="Literal synthetic fixture. No owner audio acceptance.")
    save_project(project, path)
    return ProjectWorkspace.open(path)


def _replay_source(project: EpisodeProject, *, at: float = 9.0) -> None:
    project.clips.append(
        Clip(
            id="host-pad",
            track_id="host",
            source_start=1.0,
            source_end=1.3,
            timeline_start=at,
        )
    )
    if at == 9.0:
        project.clips[1].source_end = 9.3
        project.timeline.duration_sec = 9.3


def _assert_held(ws: ProjectWorkspace, ids: list[str]) -> None:
    before = ws.path.read_bytes()
    before_model = ws.project.model_dump(mode="json")

    with pytest.raises(CodedError) as held:
        EditService(ws).approve(ids)

    assert held.value.code == "cut_scope_changed"
    assert held.value.ids == ("pause",)
    assert ws.path.read_bytes() == before
    assert ws.project.model_dump(mode="json") == before_model
    assert [w.text for w in load_project(ws.path).transcripts[0].words] == [
        "before",
        "word-2",
        "word-3",
        "word-4",
        "word-5",
        "word-6",
        "word-7",
    ]


@pytest.mark.parametrize("at", [9.0, 1.0])
def test_a_pause_with_repeated_source_is_held_before_any_project_change(
    tmp_path: Path, at: float
) -> None:
    ws = _workspace(tmp_path)
    ws.mutate("before source replay", "after source replay", lambda p: _replay_source(p, at=at))

    _assert_held(ws, ["pause"])


def test_a_pause_crossing_a_previous_cut_is_held_even_when_timeline_pieces_abut(
    tmp_path: Path,
) -> None:
    ws = _workspace(tmp_path)
    ws.mutate(
        "before prior pause",
        "after prior pause",
        lambda p: p.edit_decisions.append(_pause("prior", 1.1, 1.2)),
    )
    ws.mutate(
        "before source cut intent",
        "after source cut intent",
        lambda p: setattr(p.edit_decisions[-1], "reason", "nl:range"),
    )
    assert EditService(ws).approve(["prior"]) == 1
    assert ws.project.timeline.duration_sec == pytest.approx(8.9)

    _assert_held(ws, ["pause"])


def test_a_held_pause_rolls_back_other_cuts_in_the_same_approval(tmp_path: Path) -> None:
    ws = _workspace(tmp_path)

    def add_replay_and_cut(project: EpisodeProject) -> None:
        _replay_source(project)
        project.edit_decisions.append(
            EditDecision(
                id="valid",
                track_id="host",
                type=EditDecisionType.REMOVE,
                start=8.0,
                end=8.1,
                reason="nl:range",
                scope="session",
                boundary_mode="exact",
            )
        )

    ws.mutate("before pending cuts", "after pending cuts", add_replay_and_cut)

    _assert_held(ws, ["valid", "pause"])


def test_a_pause_checks_current_geometry_after_it_was_proposed(tmp_path: Path) -> None:
    ws = _workspace(tmp_path)
    proposed = ws.project.edit_decisions[0].model_dump(mode="json")
    ws.mutate("before new pad", "after new pad", _replay_source)
    assert ws.project.edit_decisions[0].model_dump(mode="json") == proposed

    _assert_held(ws, ["pause"])


def test_suggested_preview_refuses_a_pause_with_repeated_source(tmp_path: Path) -> None:
    ws = _workspace(tmp_path)
    ws.mutate("before source replay", "after source replay", _replay_source)
    snapshot = ws.project.model_copy(deep=True)
    before = snapshot.model_dump(mode="json")
    window = resolve_pending_preview(snapshot, "pause")

    with pytest.raises(CodedError) as held:
        apply_for_suggested(snapshot, window)

    assert held.value.code == "cut_scope_changed"
    assert held.value.ids == ("pause",)
    assert snapshot.model_dump(mode="json") == before


def test_a_pause_without_mapped_clips_is_held(tmp_path: Path) -> None:
    ws = _workspace(tmp_path)
    ws.mutate(
        "before removing placements",
        "after removing placements",
        lambda p: (
            setattr(p, "clips", [c for c in p.clips if c.track_id != "host"]),
            setattr(p.tracks[0], "timeline_empty", True),
        ),
    )

    _assert_held(ws, ["pause"])


@pytest.mark.parametrize("suggested", [False, True])
def test_a_pause_over_unselected_source_is_held(tmp_path: Path, suggested: bool) -> None:
    ws = _workspace(tmp_path)
    ws.mutate(
        "before unselected overlay",
        "after unselected overlay",
        lambda p: p.clips.append(
            Clip(
                id="unselected-overlay",
                track_id="host",
                source_start=2.0,
                source_end=2.3,
                timeline_start=1.0,
            )
        ),
    )
    if not suggested:
        _assert_held(ws, ["pause"])
        return
    snapshot = ws.project.model_copy(deep=True)
    before = snapshot.model_dump(mode="json")

    with pytest.raises(CodedError) as held:
        apply_for_suggested(snapshot, resolve_pending_preview(snapshot, "pause"))

    assert held.value.code == "cut_scope_changed"
    assert held.value.ids == ("pause",)
    assert snapshot.model_dump(mode="json") == before


@pytest.mark.parametrize("split", [False, True])
def test_a_once_covered_pause_still_shortens_every_dialogue_lane(
    tmp_path: Path, split: bool
) -> None:
    ws = _workspace(tmp_path)
    if split:

        def split_host(project: EpisodeProject) -> None:
            project.clips[0].source_end = 1.15
            project.clips.append(
                Clip(
                    id="host-continuation",
                    track_id="host",
                    source_start=1.15,
                    source_end=9.0,
                    timeline_start=1.15,
                )
            )

        ws.mutate("before continuous split", "after continuous split", split_host)

    assert EditService(ws).approve(["pause"]) == 1

    saved = load_project(ws.path)
    assert saved.timeline.duration_sec == pytest.approx(8.81)
    assert {
        track_id: max(c.timeline_end for c in saved.clips if c.track_id == track_id)
        for track_id in ("host", "guest")
    } == pytest.approx({"host": 8.81, "guest": 8.81})
    assert [w.text for w in saved.transcripts[0].words] == [
        "before",
        "word-2",
        "word-3",
        "word-4",
        "word-5",
        "word-6",
        "word-7",
    ]
    assert saved.edit_decisions == []
    assert saved.editorial.edit_log[0].decision_ids == ["pause"]
    assert saved.editorial.edit_log[0].params["replace_gap_sec"] is None
    assert saved.editorial.edit_log[0].params["pad_samples"] == []


def test_a_unique_pause_placement_on_another_lane_still_applies(tmp_path: Path) -> None:
    ws = _workspace(tmp_path)

    def park_host(project: EpisodeProject) -> None:
        project.sources.append(SourceRecording(id="host-recording", path="raw/host.wav"))
        project.clips[0].source_id = "host-recording"
        project.clips[0].track_id = "guest"
        project.tracks[0].timeline_empty = True

    ws.mutate("before parking host audio", "after parking host audio", park_host)

    assert EditService(ws).approve(["pause"]) == 1

    saved = load_project(ws.path)
    assert saved.timeline.duration_sec == pytest.approx(8.81)
    host_audio = [c for c in saved.clips if c.source_id == "host-recording"]
    assert host_audio
    assert all(c.track_id == "guest" for c in host_audio)
    assert sum(c.source_end - c.source_start for c in host_audio) == pytest.approx(8.81)
    assert [w.text for w in saved.transcripts[0].words] == [
        "before",
        *[f"word-{n}" for n in range(2, 8)],
    ]
    assert saved.edit_decisions == []
    assert saved.editorial.edit_log[0].decision_ids == ["pause"]
    assert saved.editorial.edit_log[0].params["replace_gap_sec"] is None
    assert saved.editorial.edit_log[0].params["pad_samples"] == []


@pytest.mark.parametrize("suggested", [False, True])
def test_http_geometry_hold_retains_code_and_saved_project(tmp_path: Path, suggested: bool) -> None:
    ws = _workspace(tmp_path)
    ws.mutate("before source replay", "after source replay", _replay_source)
    before = ws.path.read_bytes()
    with TestClient(create_app()) as client:
        if suggested:
            response = client.get(
                "/api/pending-preview",
                params={"path": str(ws.path), "edit_id": "pause", "mode": "suggested"},
            )
        else:
            response = client.post(
                f"/api/document/command?path={quote(str(ws.path))}",
                json={
                    "client_id": "geometry-http",
                    "client_seq": 1,
                    "command_id": "geometry-hold",
                    "type": "ApproveEdits",
                    "payload": {"ids": ["pause"]},
                    "role": "viewer",
                },
            )
    assert response.status_code == 400
    assert response.headers["X-Sharecut-Error-Code"] == "cut_scope_changed"
    assert "not applied (pause)" in response.json()["detail"]
    guarantee = (
        "Suggested preview is unavailable. The saved project is unchanged."
        if suggested
        else "None of the selected edits were applied."
    )
    assert guarantee in response.json()["detail"]
    assert ws.path.read_bytes() == before
