"""Restore a ripple cut from its ReinsertClips inverse (#3114)."""

from __future__ import annotations

import json

import pytest

from podcast_mcp.edits.cut_application import apply_prefix_edits
from podcast_mcp.edits.timeline_ops import insert_gap
from podcast_mcp.models import Clip, EpisodeProject, Track, TrackRole, load_project
from podcast_mcp.services.document import EditService
from ripple_helpers import ripple_cut
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


def test_a_cut_that_overlaps_the_earlier_seam_blocks_it_and_names_the_overlapping_cut(
    tmp_path, monkeypatch
):
    project = build(tmp_path)
    project.edit_decisions = [cut("a", 2.0, 2.9)]
    ws = workspace(project, monkeypatch, tmp_path, pad_mode="silence")
    before = _state(ws.project)
    assert EditService(ws).approve(["a"]) == 1
    ws.mutate("before range", "after range", lambda p: ripple_cut(p, 1.5, 2.5))
    a, b = (r.id for r in ws.project.editorial.edit_log)
    stuck = _state(ws.project)

    result = EditService(ws).revert_applied([a])

    assert result["status"] == "conflict"
    assert [(c["code"], c["blocked_by"]) for c in result["conflicts"]] == [("seam_gone", [b])]
    assert _state(load_project(ws.path)) == stuck
    assert EditService(ws).revert_applied([a, b])["status"] == "restored"
    assert _state(load_project(ws.path)) == before


def test_a_batch_with_one_blocked_record_restores_nothing(tmp_path, monkeypatch):
    project = build(tmp_path)
    project.edit_decisions = [cut("a", 2.0, 2.9), cut("b", 1.0, 2.0), cut("c", 8.0, 8.8)]
    ws = workspace(project, monkeypatch, tmp_path, pad_mode="silence")
    for edit_id in ("a", "b", "c"):
        assert EditService(ws).approve([edit_id]) == 1
    a, b, c = (r.id for r in ws.project.editorial.edit_log)
    stuck = _state(ws.project)

    result = EditService(ws).revert_applied([c, a])

    assert result["status"] == "conflict"
    assert [(x["record_id"], x["blocked_by"]) for x in result["conflicts"]] == [(a, [b])]
    assert _state(ws.project) == stuck
    assert _state(load_project(ws.path)) == stuck
    assert [r.id for r in ws.project.editorial.edit_log] == [a, b, c]


def test_restoring_a_record_twice_is_a_not_found_conflict_that_writes_nothing(
    tmp_path, monkeypatch
):
    project = build(tmp_path)
    project.edit_decisions = [cut("c", 1.0, 1.9)]
    ws = workspace(project, monkeypatch, tmp_path, pad_mode="silence")
    assert EditService(ws).approve(["c"]) == 1
    [record] = ws.project.editorial.edit_log
    assert EditService(ws).revert_applied([record.id])["status"] == "restored"
    restored = _state(load_project(ws.path))

    again = EditService(ws).revert_applied([record.id])

    assert [(c["code"], c["record_id"]) for c in again["conflicts"]] == [
        ("applied_edit_not_found", record.id)
    ]
    assert _state(load_project(ws.path)) == restored


def test_a_record_whose_clips_were_deleted_is_blocked_and_restore_writes_nothing(
    tmp_path, monkeypatch
):
    project = build(tmp_path)
    project.edit_decisions = [cut("c", 1.0, 1.9)]
    ws = workspace(project, monkeypatch, tmp_path, pad_mode="silence")
    assert EditService(ws).approve(["c"]) == 1
    [record] = ws.project.editorial.edit_log
    ws.mutate("before wipe", "after wipe", lambda p: setattr(p, "clips", []))
    stuck = _state(ws.project)

    [state] = [r["restore"] for r in EditService(ws).list_applied_edits()["records"]]
    result = EditService(ws).revert_applied([record.id])

    assert state["state"] == "blocked"
    assert result["status"] == "conflict"
    assert _state(load_project(ws.path)) == stuck


def test_a_dry_run_of_several_ripple_records_leaves_the_project_untouched(tmp_path, monkeypatch):
    ws, _before, a, b = _two_adjacent_cuts(tmp_path, monkeypatch)
    memory = _state(ws.project)
    log = [r.model_dump_json() for r in ws.project.editorial.edit_log]

    result = EditService(ws).revert_applied([a, b], dry_run=True)

    assert result["status"] == "planned"
    assert result["summary"]["ids"] == [b, a]
    assert _state(ws.project) == memory
    assert [r.model_dump_json() for r in ws.project.editorial.edit_log] == log
    assert _state(load_project(ws.path)) == memory


def _rounded(value):
    """Float noise of shifting there and back (6.9999999 for 7.0) is not a difference."""
    if isinstance(value, float):
        return round(value, 6)
    if isinstance(value, dict):
        return {k: _rounded(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_rounded(v) for v in value]
    return value


def _comment_span(project: EpisodeProject, comment_id: str) -> tuple[float, float | None]:
    found = next(c for c in project.review.comments if c.id == comment_id)
    return found.timeline_start, found.timeline_end


@pytest.mark.parametrize("order", ["a-b", "b-a", "together"])
def test_a_comment_spanning_two_cuts_gets_each_end_back_from_its_own_cut(
    tmp_path, monkeypatch, order
):
    project = build(tmp_path)
    project.edit_decisions = [cut("a", 1.0, 1.9), cut("b", 3.0, 3.3)]
    ws = workspace(project, monkeypatch, tmp_path, pad_mode="silence")
    before = _state(ws.project)
    assert _comment_span(ws.project, "overlap-start") == (1.8, 3.5)
    assert EditService(ws).approve(["a"]) == 1
    assert EditService(ws).approve(["b"]) == 1
    a, b = (r.id for r in ws.project.editorial.edit_log)

    if order == "together":
        assert EditService(ws).revert_applied([a, b])["status"] == "restored"
    else:
        first, second = (a, b) if order == "a-b" else (b, a)
        assert EditService(ws).revert_applied([first])["status"] == "restored"
        halfway = _comment_span(load_project(ws.path), "overlap-start")
        # The restored cut returns its own end of the comment and no more.
        expected = (1.8, 3.2) if first == a else (1.0, 3.5 - 0.9)
        assert halfway == (pytest.approx(expected[0]), pytest.approx(expected[1]))
        assert EditService(ws).revert_applied([second])["status"] == "restored"

    assert _rounded(_state(load_project(ws.path))) == _rounded(before)


def test_a_comment_start_goes_home_with_its_cut_even_when_a_pad_sits_at_the_other_cut(
    tmp_path, monkeypatch
):
    project = build(tmp_path)
    project.edit_decisions = [cut("a", 1.0, 1.9, gap=0.25), cut("b", 3.0, 3.3, gap=0.25)]
    ws = workspace(project, monkeypatch, tmp_path, pad_mode="silence")
    assert EditService(ws).approve(["a"]) == 1
    assert EditService(ws).approve(["b"]) == 1
    a, b = (r.id for r in ws.project.editorial.edit_log)

    assert EditService(ws).revert_applied([a])["status"] == "restored"

    assert _comment_span(load_project(ws.path), "overlap-start")[0] == pytest.approx(1.8)
    assert EditService(ws).revert_applied([b])["status"] == "restored"
    assert _comment_span(load_project(ws.path), "overlap-start")[0] == pytest.approx(1.8)


def test_adjacent_cuts_with_room_tone_pads_restore_even_though_their_fills_share_a_clock(
    tmp_path, monkeypatch
):
    project = build(tmp_path)
    project.edit_decisions = [cut("a", 2.0, 2.9, gap=0.25), cut("b", 1.0, 2.0, gap=0.25)]
    ws = workspace(project, monkeypatch, tmp_path, pad_mode="room_tone")
    before = _state(ws.project)
    assert EditService(ws).approve(["a"]) == 1
    assert EditService(ws).approve(["b"]) == 1
    a, b = (r.id for r in ws.project.editorial.edit_log)
    states = {r["id"]: r["restore"] for r in EditService(ws).list_applied_edits()["records"]}
    assert (states[b]["state"], states[a]["code"], states[a]["blocked_by"]) == (
        "ready",
        "seam_gone",
        [b],
    )

    assert EditService(ws).revert_applied([a, b])["status"] == "restored"

    assert _rounded(_state(load_project(ws.path))) == _rounded(before)


@pytest.mark.parametrize("pad_mode", ["silence", "room_tone"])
def test_a_cut_on_an_edited_non_dialogue_track_with_a_pad_restores(tmp_path, monkeypatch, pad_mode):
    project = build(tmp_path)
    project.tracks.append(
        Track(
            id="bed",
            label="Bed",
            role=TrackRole.MUSIC,
            media=project.tracks[0].media.model_copy(),
        )
    )
    project.clips.append(
        Clip(id="bed", track_id="bed", source_start=0, source_end=12.0, timeline_start=0)
    )
    (tmp_path / "raw" / "bed.wav").write_bytes((tmp_path / "raw" / "host.wav").read_bytes())
    project.tracks[-1].media.path = "raw/bed.wav"
    project.edit_decisions = [cut("c", 4.6, 5.4, gap=0.25).model_copy(update={"track_id": "bed"})]
    ws = workspace(project, monkeypatch, tmp_path, pad_mode=pad_mode)
    before = _state(ws.project)
    assert EditService(ws).approve(["c"]) == 1
    [record] = ws.project.editorial.edit_log
    assert record.inverse.pad is not None
    [state] = [r["restore"] for r in EditService(ws).list_applied_edits()["records"]]
    assert state["state"] == "ready", state

    assert EditService(ws).revert_applied([record.id])["status"] == "restored"

    assert _rounded(_state(load_project(ws.path))) == _rounded(before)


def test_the_inverse_and_the_comment_bodies_in_it_stay_out_of_listings_views_and_diffs(
    tmp_path, monkeypatch
):
    from podcast_mcp.gui.mapper import map_applied_edits_to_timeline
    from podcast_mcp.models.history import ProjectStateSnapshot
    from podcast_mcp.project.history.diff import diff_snapshots
    from podcast_mcp.services.collaboration.share import sanitize_guest_project_view

    secret = "HOST-ONLY-COMMENT-BODY"
    project = build(tmp_path)
    next(c for c in project.review.comments if c.id == "inside").body = secret
    project.edit_decisions = [cut("c", 1.0, 1.9)]
    ws = workspace(project, monkeypatch, tmp_path, pad_mode="silence")
    empty = ProjectStateSnapshot(editorial={"edit_log": []})
    assert EditService(ws).approve(["c"]) == 1
    [record] = ws.project.editorial.edit_log
    assert secret in record.model_dump_json()

    listing = EditService(ws).list_applied_edits()
    mapped = map_applied_edits_to_timeline(ws.project, listing)
    mapped_models = map_applied_edits_to_timeline(ws.project, [record])
    guest = sanitize_guest_project_view(
        {
            "project_path": "/p",
            "applied_edits": {
                "count": 1,
                "records": [{**record.model_dump(), "restore": {"state": "ready"}}],
            },
        }
    )
    after = ProjectStateSnapshot(editorial={"edit_log": [record.model_dump(mode="json")]})
    diff = diff_snapshots(empty, after)

    for payload in (listing, mapped, mapped_models, guest["applied_edits"], diff["edit_log"]):
        assert secret not in json.dumps(payload)
        assert all(
            "inverse" not in row for row in payload["records" if "records" in payload else "added"]
        )
    assert listing["records"][0]["restore"]["state"] == "ready"
    assert guest["applied_edits"]["records"][0]["restore"] == {"state": "ready"}
