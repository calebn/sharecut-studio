"""Restore a ripple cut from its ReinsertClips inverse (#3114)."""

from __future__ import annotations

import pytest

from podcast_mcp.edits.cut_application import apply_prefix_edits
from podcast_mcp.edits.timeline_ops import insert_gap
from podcast_mcp.models import EpisodeProject, load_project
from podcast_mcp.services.document import EditService
from ripple_restore_helpers import build, cut, workspace

pytestmark = pytest.mark.refine_gate


def _runs(project: EpisodeProject) -> dict[str, list[tuple]]:
    """Each lane as source runs on the timeline, so a clip the cut split and Restore rejoined reads as one."""
    lanes: dict[str, list[list]] = {}
    for tid in sorted({c.track_id for c in project.clips}):
        runs: list[list] = []
        for clip in sorted(
            (c for c in project.clips if c.track_id == tid), key=lambda c: c.timeline_start
        ):
            pieces = clip.virtual_pieces()
            for index, (a, b, tl) in enumerate(pieces):
                first, last = index == 0, index == len(pieces) - 1
                fade_in = (clip.fade_in_ms, clip.join_in_mode.value) if first else (0, "")
                fade_out = clip.fade_out_ms if last else 0
                tail = runs[-1] if runs else None
                if (
                    tail is not None
                    and tail[0] == clip.source_id
                    and abs(tail[2] - a) < 1e-6
                    and abs(tail[4] - tl) < 1e-6
                ):
                    tail[2], tail[4], tail[6] = b, tl + (b - a), fade_out
                else:
                    runs.append([clip.source_id, a, b, tl, tl + (b - a), fade_in, fade_out])
        lanes[tid] = [
            tuple(round(x, 6) if isinstance(x, float) else x for x in run) for run in runs
        ]
    return lanes


def _state(project: EpisodeProject) -> dict:
    return {
        "lanes": _runs(project),
        "duration": round(project.timeline.duration_sec, 6),
        "transcripts": [t.model_dump(mode="json") for t in project.transcripts],
        "comments": [c.model_dump(mode="json") for c in project.review.comments],
        "chapters": [c.model_dump(mode="json") for c in project.editorial.chapters],
    }


# A room-tone pad is only accepted at the seam (cut_effects holds any other); a silence pad
# lands at the nearest join, so it is also tested left and right of the seam.
@pytest.mark.parametrize(
    ("pad_mode", "gap", "layout", "offset"),
    [
        pytest.param("room_tone", 0.25, "whole", 0.0, id="room-tone-pad"),
        pytest.param("silence", 0.25, "whole", 0.0, id="silence-pad-at-seam"),
        pytest.param("silence", 0.25, "hole-left", -0.05, id="silence-pad-left-of-seam"),
        pytest.param("silence", 0.25, "hole-right", 0.05, id="silence-pad-right-of-seam"),
        pytest.param("silence", None, "whole", 0.0, id="no-pad"),
        pytest.param("silence", None, "hole-left", 0.0, id="no-pad-with-holes"),
    ],
)
def test_cut_then_restore_returns_the_project_to_its_pre_cut_state(
    tmp_path, monkeypatch, pad_mode, gap, layout, offset
):
    project = build(tmp_path, layout=layout)
    project.edit_decisions = [cut("c", 1.0, 1.9, gap=gap)]
    ws = workspace(project, monkeypatch, tmp_path, pad_mode=pad_mode)
    before = _state(ws.project)

    assert EditService(ws).approve(["c"]) == 1
    [record] = ws.project.editorial.edit_log
    assert record.inverse is not None
    assert (record.inverse.pad is None) == (gap is None)
    if gap is not None:
        assert record.inverse.pad.kind == pad_mode
        assert record.inverse.pad.offset_from_seam == pytest.approx(offset, abs=0.011)
    assert _state(ws.project) != before

    result = EditService(ws).revert_applied([record.id])

    assert result["status"] == "restored"
    restored = load_project(ws.path)
    assert restored.editorial.edit_log == []
    assert _state(restored) == before


def _host_clips_without_ids(project: EpisodeProject) -> list[dict]:
    """The host lane clip for clip: its cut edges are clip edges, so nothing is split or rejoined."""
    return [
        c.model_dump(mode="json", exclude={"id"})
        for c in sorted(project.clips, key=lambda c: c.timeline_start)
        if c.track_id == "host"
    ]


@pytest.mark.parametrize("pad_mode", ["room_tone", "silence"])
@pytest.mark.parametrize("path", ["approve", "prefix"])
def test_restore_puts_back_the_fades_and_join_modes_the_cut_and_pad_changed(
    tmp_path, monkeypatch, pad_mode, path
):
    project = build(tmp_path, layout="edges")
    project.edit_decisions = [cut("c", 1.0, 1.9, gap=0.25)]
    ws = workspace(project, monkeypatch, tmp_path, pad_mode=pad_mode)
    before = _host_clips_without_ids(ws.project)
    before_runs = _runs(ws.project)
    if path == "approve":
        assert EditService(ws).approve(["c"]) == 1
    else:
        ws.mutate(
            "before auto",
            "after auto",
            lambda p: apply_prefix_edits(
                p, "filler", config_key="tighten", defaults=ws.effective_config()
            ),
        )
    host_after = [c for c in ws.project.clips if c.track_id == "host"]
    assert [c.fade_in_ms for c in sorted(host_after, key=lambda c: c.timeline_start)] != [0, 11]
    [record] = ws.project.editorial.edit_log

    assert EditService(ws).revert_applied([record.id])["status"] == "restored"

    assert _host_clips_without_ids(ws.project) == before
    assert _runs(ws.project) == before_runs


def _two_adjacent_cuts(tmp_path, monkeypatch):
    project = build(tmp_path)
    project.edit_decisions = [cut("a", 2.0, 2.9), cut("b", 1.0, 2.0)]
    ws = workspace(project, monkeypatch, tmp_path, pad_mode="silence")
    before = _state(ws.project)
    assert EditService(ws).approve(["a"]) == 1
    assert EditService(ws).approve(["b"]) == 1
    first, second = ws.project.editorial.edit_log
    return ws, before, first.id, second.id


def test_the_earlier_of_two_adjacent_cuts_waits_for_the_later_one(tmp_path, monkeypatch):
    ws, _before, a, b = _two_adjacent_cuts(tmp_path, monkeypatch)
    states = {r["id"]: r["restore"] for r in EditService(ws).list_applied_edits()["records"]}
    assert states[a]["state"] == "blocked"
    assert (states[a]["code"], states[a]["blocked_by"]) == ("seam_gone", [b])
    assert states[b]["state"] == "ready"
    stuck = _state(ws.project)

    result = EditService(ws).revert_applied([a])

    assert result["status"] == "conflict"
    assert [(c["code"], c["blocked_by"]) for c in result["conflicts"]] == [("seam_gone", [b])]
    assert _state(load_project(ws.path)) == stuck


def test_restoring_the_later_cut_first_unblocks_the_earlier_one(tmp_path, monkeypatch):
    ws, before, a, b = _two_adjacent_cuts(tmp_path, monkeypatch)
    assert EditService(ws).revert_applied([b])["status"] == "restored"
    states = {
        r["id"]: r["restore"]["state"] for r in EditService(ws).list_applied_edits()["records"]
    }
    assert states == {a: "ready"}
    assert EditService(ws).revert_applied([a])["status"] == "restored"
    assert _state(load_project(ws.path)) == before


def test_both_adjacent_cuts_restore_together_in_the_order_that_works(tmp_path, monkeypatch):
    ws, before, a, b = _two_adjacent_cuts(tmp_path, monkeypatch)
    result = EditService(ws).revert_applied([a, b])
    assert result["status"] == "restored"
    assert result["summary"]["ids"] == [b, a]
    assert _state(load_project(ws.path)) == before


@pytest.mark.parametrize(
    ("start", "end"), [(0.0, 1.0), (11.0, 12.0)], ids=["track-start", "track-end"]
)
def test_a_cut_at_a_track_edge_restores_from_the_clip_that_is_left(
    tmp_path, monkeypatch, start, end
):
    project = build(tmp_path)
    project.edit_decisions = [cut("edge", start, end)]
    ws = workspace(project, monkeypatch, tmp_path, pad_mode="silence")
    before = _state(ws.project)
    assert EditService(ws).approve(["edge"]) == 1
    [record] = ws.project.editorial.edit_log
    host = next(s for s in record.inverse.tracks if s.track_id == "host")
    assert (host.pre is None) == (start == 0.0)
    assert (host.post is None) == (end == 12.0)

    assert EditService(ws).revert_applied([record.id])["status"] == "restored"

    assert _state(load_project(ws.path)) == before


def test_material_opened_at_the_seam_makes_restore_a_conflict_with_no_blocker(
    tmp_path, monkeypatch
):
    project = build(tmp_path)
    project.edit_decisions = [cut("c", 1.0, 1.9)]
    ws = workspace(project, monkeypatch, tmp_path, pad_mode="silence")
    assert EditService(ws).approve(["c"]) == 1
    [record] = ws.project.editorial.edit_log
    ws.mutate(
        "before gap",
        "after gap",
        lambda p: insert_gap(p, 1.0, 0.5, defaults=ws.effective_config()),
    )

    [state] = [r["restore"] for r in EditService(ws).list_applied_edits()["records"]]

    assert (state["state"], state["code"], state["blocked_by"]) == (
        "blocked",
        "seam_not_adjacent",
        [],
    )
    assert EditService(ws).revert_applied([record.id])["status"] == "conflict"


def test_a_pad_edited_after_the_cut_blocks_restore(tmp_path, monkeypatch):
    project = build(tmp_path)
    project.edit_decisions = [cut("c", 1.0, 1.9, gap=0.25)]
    ws = workspace(project, monkeypatch, tmp_path, pad_mode="room_tone")
    assert EditService(ws).approve(["c"]) == 1
    [record] = ws.project.editorial.edit_log
    pad_id = record.inverse.pad.clip_ids[0]
    ws.mutate(
        "before delete",
        "after delete",
        lambda p: setattr(p, "clips", [c for c in p.clips if c.id != pad_id]),
    )

    [state] = [r["restore"] for r in EditService(ws).list_applied_edits()["records"]]

    assert (state["state"], state["code"]) == ("blocked", "pad_changed")
