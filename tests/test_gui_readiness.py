from __future__ import annotations

from pathlib import Path

from podcast_mcp.edits.edit_log import archive_decision
from podcast_mcp.edits.timeline_ops import ripple_delete
from podcast_mcp.history.diff import diff_snapshots
from podcast_mcp.models import (
    Clip,
    ClipJoinMode,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    SpeakerIngestAlignment,
    Track,
    TrackRole,
)
from podcast_mcp.models.history import ProjectStateSnapshot

ROOT = Path(__file__).resolve().parents[1]


def _project_with_two_clips() -> EpisodeProject:
    p = EpisodeProject.create("gui_test", "/tmp/gui_test")
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    p.timeline.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=2.0,
            source_end=4.0,
            timeline_start=2.0,
            join_in_mode=ClipJoinMode.FADE,
        ),
    ]
    return p


def test_list_clips_includes_join_in_mode_and_source_id() -> None:
    from podcast_mcp.edits.timeline_ops import list_clips

    p = _project_with_two_clips()
    p.clips[1].source_id = "src1"
    data = list_clips(p, track_id="host")
    clip = data["tracks"]["host"][1]
    assert clip["join_in_mode"] == "fade"
    assert clip["source_id"] == "src1"
    assert clip["origin_track_id"] == "host"
    assert clip["join_left_clip_id"] == data["tracks"]["host"][0]["id"]
    assert data["tracks"]["host"][0]["join_left_clip_id"] is None
    assert data["tracks"]["host"][0]["join_render_mode"] is None
    assert clip["join_render_mode"] == "fade"
    assert clip["join_crossfade_ms"] == 0
    assert clip["join_crossfade_blocked"] is None


def test_archive_decision_and_list_applied() -> None:
    from podcast_mcp.edits.edit_log import list_applied_edits

    p = _project_with_two_clips()
    decision = EditDecision(
        id="d1",
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=1.0,
        end=1.5,
        reason="filler:um",
        crossfade_ms=20,
    )
    archive_decision(
        p,
        decision,
        operation="approve_edits",
        timeline_start=1.0,
        timeline_end=1.5,
    )
    records = list_applied_edits(p, track_id="host")
    assert len(records) == 1
    assert records[0].reason == "filler:um"
    assert records[0].operation == "approve_edits"


def test_ripple_delete_archives_edit_log() -> None:
    import pytest

    from podcast_mcp.edits.edit_log import list_applied_edits

    p = _project_with_two_clips()
    ripple_delete(p, 1.0, 1.5, use_inaudible_opt=False)
    records = list_applied_edits(p)
    assert len(records) == 1
    assert records[0].operation == "ripple_delete"
    assert records[0].timeline_start == 1.0
    assert records[0].params["per_track_source"] == {
        "host": [pytest.approx(1.0), pytest.approx(1.5)]
    }


def test_punch_delete_archives_per_track_source() -> None:
    import pytest

    from podcast_mcp.edits.edit_log import list_applied_edits
    from podcast_mcp.edits.timeline_ops import punch_delete

    p = _project_with_two_clips()
    punch_delete(p, "host", 2.5, 3.0, use_inaudible_opt=False)
    records = list_applied_edits(p, track_id="host")
    assert len(records) == 1
    assert records[0].params["per_track_source"]["host"] == [
        pytest.approx(2.5),
        pytest.approx(3.0),
    ]


def test_split_clips_at_records_split_source_by_track() -> None:
    import pytest

    from podcast_mcp.edits.edit_log import list_applied_edits
    from podcast_mcp.edits.timeline_ops import split_clips_at

    p = _project_with_two_clips()
    split_clips_at(p, 1.0, ["host"])
    records = list_applied_edits(p, track_id="host")
    assert records[-1].params["split_source_by_track"] == {"host": pytest.approx(1.0)}


def test_seam_source_by_track_skips_tracks_without_material() -> None:
    from podcast_mcp.edits.edit_log import seam_source_by_track

    p = _project_with_two_clips()
    assert seam_source_by_track({"host": p.clips, "empty": [], "gap": [p.clips[1]]}, 0.5, 1.5) == {
        "host": [0.5, 1.5]
    }


def test_seam_source_by_track_falls_back_to_removed_span_in_a_gap() -> None:
    from podcast_mcp.edits.edit_log import seam_source_by_track

    clip = Clip(id="c", track_id="host", source_start=4.0, source_end=8.0, timeline_start=3.0)
    assert seam_source_by_track({"host": [clip]}, 1.0, 5.0) == {"host": [4.0, 6.0]}


def test_seam_source_by_track_gap_fallback_follows_timeline_order() -> None:
    """A cut edge in a gap reads the nearest clip in timeline order, not the source-sorted extreme."""
    import pytest

    from podcast_mcp.edits.edit_log import seam_source_by_track

    # Start in the 5-7 gap; b (src 30-34) is first inside the cut, c (src 0-10) follows.
    clips = [
        Clip(id="a", track_id="host", source_start=20.0, source_end=25.0, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=30.0, source_end=34.0, timeline_start=7.0),
        Clip(id="c", track_id="host", source_start=0.0, source_end=10.0, timeline_start=11.0),
    ]
    assert seam_source_by_track({"host": clips}, 6.0, 13.0) == {
        "host": [pytest.approx(30.0), pytest.approx(2.0)]
    }
    # End in the 6-8 gap; e (src 10-12) is last inside the cut, d (src 40-44) precedes it.
    clips = [
        Clip(id="d", track_id="host", source_start=40.0, source_end=44.0, timeline_start=0.0),
        Clip(id="e", track_id="host", source_start=10.0, source_end=12.0, timeline_start=4.0),
        Clip(id="f", track_id="host", source_start=0.0, source_end=5.0, timeline_start=8.0),
    ]
    assert seam_source_by_track({"host": clips}, 3.0, 7.0) == {
        "host": [pytest.approx(43.0), pytest.approx(12.0)]
    }


def _project_with_moved_clip() -> EpisodeProject:
    """W src[0,5]@0, X src[10,20]@5, Z src[30,40]@18; Y src[5,8] parked at 30."""
    p = _project_with_two_clips()
    p.timeline.tracks[0].media = MediaAsset(path="raw/host.wav", duration_sec=60.0)
    p.timeline.clips = [
        Clip(id="w", track_id="host", source_start=0.0, source_end=5.0, timeline_start=0.0),
        Clip(id="x", track_id="host", source_start=10.0, source_end=20.0, timeline_start=5.0),
        Clip(id="z", track_id="host", source_start=30.0, source_end=40.0, timeline_start=18.0),
        Clip(id="y", track_id="host", source_start=5.0, source_end=8.0, timeline_start=30.0),
    ]
    return p


def test_ripple_across_a_moved_clip_records_the_seam_not_the_source_envelope() -> None:
    import pytest

    from podcast_mcp.edits.clips_ops import clips_for_track
    from podcast_mcp.edits.edit_log import list_applied_edits
    from podcast_mcp.edits.timeline_ops import move_clips

    p = _project_with_moved_clip()
    move_clips(p, [{"clip_id": "y", "track_id": "host", "timeline_start": 15.0}])
    ripple_delete(p, 10.0, 21.0, use_inaudible_opt=False)
    record = list_applied_edits(p)[-1]
    assert record.operation == "ripple_delete"
    # Merged source spans sort to [5, 33]; the cut actually joins X@15 to Z@33.
    assert record.params["per_track_source"] == {"host": [pytest.approx(15.0), pytest.approx(33.0)]}
    clips = clips_for_track(p, "host")
    left = next(c for c in clips if c.source_end == pytest.approx(15.0))
    right = next(c for c in clips if c.source_start == pytest.approx(33.0))
    assert left.timeline_end == pytest.approx(10.0)
    assert right.timeline_start == pytest.approx(10.0)


def test_punch_across_a_moved_clip_records_the_seam() -> None:
    import pytest

    from podcast_mcp.edits.edit_log import list_applied_edits
    from podcast_mcp.edits.timeline_ops import move_clips, punch_delete

    p = _project_with_moved_clip()
    move_clips(p, [{"clip_id": "y", "track_id": "host", "timeline_start": 15.0}])
    punch_delete(p, "host", 10.0, 21.0, use_inaudible_opt=False)
    record = list_applied_edits(p, track_id="host")[-1]
    assert record.params["per_track_source"] == {"host": [pytest.approx(15.0), pytest.approx(33.0)]}


def test_applied_edit_source_clocks_still_bind_after_chained_edits() -> None:
    """Recorded clocks stay within the GUI's APPLIED_EDGE_EPS_SEC through ripple/split/trim/roll."""
    import re

    from podcast_mcp.edits.clips_ops import clips_for_track
    from podcast_mcp.edits.edit_log import list_applied_edits
    from podcast_mcp.edits.timeline_ops import roll_clip_join, split_clips_at, trim_clip_edge

    ticks_ts = (ROOT / "gui/web/src/timeline/appliedEditTicks.ts").read_text(encoding="utf-8")
    match = re.search(r"export const APPLIED_EDGE_EPS_SEC = ([\d.e-]+);", ticks_ts)
    assert match
    eps = float(match.group(1))

    p = _project_with_two_clips()
    p.timeline.tracks[0].media = MediaAsset(path="raw/host.wav", duration_sec=60.0)
    p.timeline.clips = [
        Clip(id="a", track_id="host", source_start=0.0, source_end=10.0, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=10.0, source_end=20.0, timeline_start=10.0),
    ]
    ripple_delete(p, 2.1, 3.37, use_inaudible_opt=False)
    first = list_applied_edits(p)[-1]
    split_clips_at(p, 6.123)
    clips = clips_for_track(p, "host")
    trim_clip_edge(p, clips[-1].id, "out", 19.5)
    clips = clips_for_track(p, "host")
    roll_clip_join(p, clips[1].id, clips[2].id, 0.237)
    ripple_delete(p, 0.5, 1.1, use_inaudible_opt=False)

    pre, post = first.params["per_track_source"]["host"]
    clips = clips_for_track(p, "host")
    left = [c for c in clips if abs(c.source_end - pre) <= eps]
    right = [c for c in clips if abs(c.source_start - post) <= eps]
    assert len(left) == 1 and len(right) == 1
    assert abs(left[0].timeline_end - right[0].timeline_start) <= eps


def _edit_log_operations() -> set[str]:
    """Every literal ``operation=`` passed to an ``edit_log`` archive writer under ``src/``."""
    import ast

    writers = {"archive_timeline_op", "archive_decision"}
    ops: set[str] = set()
    for path in (ROOT / "src/podcast_mcp").rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
            if name not in writers:
                continue
            for kw in node.keywords:
                if kw.arg == "operation" and isinstance(kw.value, ast.Constant):
                    ops.add(str(kw.value.value))
    return ops


def test_every_edit_log_operation_has_an_applied_tick_case() -> None:
    """The GUI's ``recordAnchors`` names each server operation; none rides the default (#527)."""
    import re

    ticks_ts = (ROOT / "gui/web/src/timeline/appliedEditTicks.ts").read_text(encoding="utf-8")
    cases = set(re.findall(r'case "([a-z_]+)":', ticks_ts))
    ops = _edit_log_operations()
    assert {"ripple_delete", "approve_edits", "trim_clip_edge"} <= ops
    assert ops - cases == set()


def test_history_diff_detects_clip_change() -> None:
    before = ProjectStateSnapshot(
        timeline={
            "clips": [
                {
                    "id": "a",
                    "track_id": "host",
                    "source_start": 0.0,
                    "source_end": 2.0,
                    "timeline_start": 0.0,
                    "fade_in_ms": 0,
                    "fade_out_ms": 0,
                    "join_in_mode": "fade",
                }
            ],
            "tracks": [],
        }
    )
    after = ProjectStateSnapshot(
        timeline={
            "clips": [
                {
                    "id": "a",
                    "track_id": "host",
                    "source_start": 0.0,
                    "source_end": 2.0,
                    "timeline_start": 0.0,
                    "fade_in_ms": 10,
                    "fade_out_ms": 0,
                    "join_in_mode": "fade",
                }
            ],
            "tracks": [],
        }
    )
    diff = diff_snapshots(before, after)
    assert diff["clips"]["changed"][0]["id"] == "a"


def test_meta_snapshot_round_trip() -> None:
    from podcast_mcp.models.project_format import (
        apply_editable_snapshot,
        snapshot_editable_state,
    )

    p = _project_with_two_clips()
    p.meta.ingest_alignment = {
        "host": SpeakerIngestAlignment(
            session_start_in_file_sec=1.5,
            content_align_sec=0.1,
            align_method="vad",
        )
    }
    snap = snapshot_editable_state(p)
    assert snap["meta"]["ingest_alignment"]["host"]["session_start_in_file_sec"] == 1.5
    p2 = EpisodeProject.create("other", "/tmp/other")
    apply_editable_snapshot(p2, snap)
    assert p2.meta.ingest_alignment is not None
    assert p2.meta.ingest_alignment["host"].session_start_in_file_sec == 1.5


def test_history_entry_operation_params() -> None:
    from podcast_mcp.history.manager import HistoryManager

    p = _project_with_two_clips()
    ws = p.workspace_path()
    ws.mkdir(parents=True, exist_ok=True)
    from podcast_mcp.project_store import ProjectStore

    store = ProjectStore(ws / "episode.project.json")
    store.commit(p)
    mgr = HistoryManager(ws / "episode.project.json")
    entry = mgr.record(
        p,
        "after ripple delete",
        force=True,
        operation="ripple_delete",
        params={"timeline_start": 1.0, "timeline_end": 2.0},
    )
    assert entry.operation == "ripple_delete"
    assert entry.params["timeline_start"] == 1.0


def test_render_status_report() -> None:
    from podcast_mcp.engines.render_status import render_status_report

    p = _project_with_two_clips()
    report = render_status_report(p)
    assert "tracks" in report
    assert "premix" in report
    assert report["needs_rerender"] is True


def test_render_status_report_with_premix(tmp_path) -> None:
    from podcast_mcp.engines.render_status import render_status_report

    p = EpisodeProject.create("gui_test2", str(tmp_path))
    base = _project_with_two_clips()
    p.timeline.tracks = base.timeline.tracks
    p.timeline.clips = base.timeline.clips
    premix = p.artifacts_dir() / "premix.wav"
    premix.parent.mkdir(parents=True, exist_ok=True)
    premix.write_bytes(b"RIFF")
    report = render_status_report(p)
    assert report["premix"]["exists"] is True
    assert report["premix"]["size_bytes"] == 4


def test_render_status_reports_duration_mismatch(tmp_path, sample_wav) -> None:
    from podcast_mcp.engines.play_audit import write_stem_hash
    from podcast_mcp.engines.render_status import render_status_report
    from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole

    p = EpisodeProject.create("dur_mismatch", str(tmp_path))
    p.ensure_dirs()
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    p.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=0.0,
        )
    ]
    stem = p.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(sample_wav.read_bytes())
    write_stem_hash(p, "host")
    premix = p.artifacts_dir() / "premix.wav"
    premix.write_bytes(b"RIFF")
    report = render_status_report(p)
    assert report["tracks"]["host"]["duration_mismatch"] is True
    assert report["tracks"]["host"]["stem_is_fresh"] is False
    assert report["needs_rerender"] is True


def test_history_diff_empty_and_out_of_range(minimal_project):
    from podcast_mcp.services import HistoryService, ProjectWorkspace

    ws = ProjectWorkspace.open(minimal_project)
    svc = HistoryService(ws)
    assert svc.diff() == {
        "diff": {},
        "summary": [],
        "from_index": None,
        "to_index": None,
    }
    ws.record_snapshot("only", force=True)
    try:
        svc.diff(from_index=0, to_index=99)
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError for out-of-range diff")
