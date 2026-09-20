from __future__ import annotations

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
    from podcast_mcp.edits.edit_log import list_applied_edits

    p = _project_with_two_clips()
    ripple_delete(p, 1.0, 1.5)
    records = list_applied_edits(p)
    assert len(records) == 1
    assert records[0].operation == "ripple_delete"
    assert records[0].timeline_start == 1.0


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
