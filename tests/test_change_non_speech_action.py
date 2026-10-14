"""Change one applied non-speech action after bulk apply (#1434 5b)."""

from __future__ import annotations

import json
from pathlib import Path

from podcast_mcp.edits.change_non_speech_action import change_non_speech_action
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
    save_project,
)


def _decision(did: str, reason: str, start: float, end: float) -> EditDecision:
    return EditDecision(
        id=did,
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=start,
        end=end,
        reason=reason,
        review_required=True,
        applied=False,
    )


def _seed(path: str, sample_wav) -> None:
    media_path = Path(path).parent / "raw" / "host.wav"
    media_path.write_bytes(sample_wav.read_bytes())
    proj = load_project(Path(path))
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    proj.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=10.0, timeline_start=0.0)
    ]
    save_project(proj, Path(path))


def test_bulk_apply_records_outcomes_and_cut_to_leave_keeps_sibling_cut(
    tmp_path, sample_wav
) -> None:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed(path, sample_wav)
    proj = load_project(Path(path))
    proj.edit_decisions = [
        _decision("cut_a", "filler:um", 1.0, 1.3),
        _decision("cut_b", "filler:uh", 2.0, 2.3),
    ]
    save_project(proj, Path(path))

    bulk = json.loads(mcp_server.apply_suggested_non_speech_actions_tool(path))
    assert bulk["applied_cuts"] == 2
    assert bulk["outcomes"] == 2

    after_bulk = load_project(Path(path))
    duration_after_both = after_bulk.timeline.duration_sec
    outcomes = after_bulk.editorial.non_speech_outcomes
    assert len(outcomes) == 2
    assert all(o.applied_action == "cut" for o in outcomes)

    first = outcomes[0]
    change_non_speech_action(after_bulk, first.id, "leave")
    save_project(after_bulk, Path(path))

    final = load_project(Path(path))
    by_id = {o.id: o for o in final.editorial.non_speech_outcomes}
    assert by_id[first.id].applied_action == "leave"
    assert sum(1 for o in final.editorial.non_speech_outcomes if o.applied_action == "cut") == 1
    assert final.timeline.duration_sec > duration_after_both - 0.25
