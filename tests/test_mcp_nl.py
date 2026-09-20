from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.models import (
    CombinedTranscript,
    CombinedUtterance,
    load_project,
    save_project,
)


def _project(path: Path):
    proj = load_project(path)
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=22.0,
                text="What is the secret to great audio?",
            )
        ]
    )
    save_project(proj, path)
    return path


def test_get_transcript_timestamps(tmp_path):
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _project(Path(path))
    out = mcp_server.get_transcript(path, combined=True, format="timestamps")
    assert "[0]" in out


def test_edit_impact_and_list(tmp_path):
    path = mcp_server.episode_create(str(tmp_path / "ws2"))
    _project(Path(path))
    mcp_server.cut_time_range_tool(path, "host", 1.0, 2.0)
    listed = mcp_server.list_edit_decisions_tool(path, review_required=True)
    assert "cut_" in listed
    report = mcp_server.edit_impact_report_tool(path, markdown=True)
    assert "Edit impact" in report


def test_approve_reject_edits(tmp_path):
    path = mcp_server.episode_create(str(tmp_path / "ws3"))
    _project(Path(path))
    mcp_server.cut_time_range_tool(path, "host", 0.5, 1.5, review_required=True)
    proj = load_project(Path(path))
    eid = proj.edit_decisions[0].id
    mcp_server.approve_edits_tool(path, json.dumps([eid]))
    proj2 = load_project(Path(path))
    assert not any(e.id == eid for e in proj2.edit_decisions)
    mcp_server.cut_time_range_tool(path, "host", 2.0, 3.0, review_required=True)
    proj2 = load_project(Path(path))
    eid2 = proj2.edit_decisions[0].id
    mcp_server.reject_edits_tool(path, json.dumps([eid2]))
    proj3 = load_project(Path(path))
    assert not any(e.id == eid2 for e in proj3.edit_decisions)


def test_social_clips_mcp(tmp_path):
    path = mcp_server.episode_create(str(tmp_path / "ws4"))
    _project(Path(path))
    out = mcp_server.propose_social_clips_tool(path, platform="tiktok")
    data = json.loads(out)
    assert len(data) >= 1
    cid = data[0]["id"]
    mcp_server.approve_social_clips_tool(path, json.dumps([cid]))
    with patch("podcast_mcp.clips.social._source_audio") as src:
        src.return_value = tmp_path / "fake.wav"
        (tmp_path / "fake.wav").write_bytes(b"\x00")
        with patch("podcast_mcp.clips.social.FFmpegEngine") as eng:
            eng.return_value.extract_segment = MagicMock(
                side_effect=lambda s, o, a, b: o.write_bytes(b"w") or o
            )
            exported = mcp_server.export_social_clips_tool(path)
    assert json.loads(exported)


def test_history_undo_rerender(tmp_path):
    path = mcp_server.episode_create(str(tmp_path / "ws5"))
    _project(Path(path))
    mcp_server.cut_time_range_tool(path, "host", 1.0, 2.0)
    with patch("podcast_mcp.services.history.rerender_preview") as rr:
        rr.return_value = {"path": "/x", "ok": True, "edit_count": 0}
        out = mcp_server.history_undo(path, rerender=True)
    assert "preview" in out


def test_preview_inaudible_cut_tool(tmp_path):
    path = mcp_server.episode_create(str(tmp_path / "ws6"))
    _project(Path(path))
    with patch("podcast_mcp.mcp.tools.edits.EditService") as svc_cls:
        svc_cls.return_value.preview_inaudible_cut.return_value = {
            "track_id": "host",
            "timeline_mode": True,
            "start": 1.0,
            "end": 2.0,
            "mode": "vocal_transcript_guided",
            "shifted_start_ms": 0.0,
            "shifted_end_ms": 0.0,
            "confidence": 0.9,
            "details": {"strategy": "word+waveform"},
        }
        out = json.loads(
            mcp_server.preview_inaudible_cut_tool(
                path,
                start=1.0,
                end=2.0,
                speaker="Host",
                timeline=True,
            )
        )
    svc_cls.return_value.preview_inaudible_cut.assert_called_once_with(
        track_id=None,
        speaker="Host",
        start=1.0,
        end=2.0,
        timeline=True,
    )
    assert out["track_id"] == "host"
    assert out["timeline_mode"] is True


def test_suggest_handoff_cut_tool(tmp_path):
    path = mcp_server.episode_create(str(tmp_path / "ws_handoff"))
    _project(Path(path))
    with patch("podcast_mcp.mcp.tools.edits.EditService") as svc_cls:
        svc_cls.return_value.suggest_handoff_cut.return_value = {
            "track_id": "host",
            "timebase": "timeline",
            "keep_left_end": 1.6,
            "keep_right_start": 8.0,
            "cut_start": 2.2,
            "cut_end": 7.1,
            "use_inaudible_opt": False,
            "ok": True,
            "warnings": [],
            "islands": [],
        }
        out = json.loads(
            mcp_server.suggest_handoff_cut_tool(
                path,
                keep_left_end=1.6,
                keep_right_start=8.0,
                speaker="Host",
            )
        )
    svc_cls.return_value.suggest_handoff_cut.assert_called_once_with(
        track_id=None,
        speaker="Host",
        keep_left_end=1.6,
        keep_right_start=8.0,
        quiet_db=-48.0,
        min_island_sec=0.12,
        hop_ms=20,
        retain_sec=1.0,
    )
    assert out["ok"] is True
    assert out["use_inaudible_opt"] is False
    assert out["cut_start"] == 2.2


def test_join_quality_and_sweep_tools(tmp_path):
    path = mcp_server.episode_create(str(tmp_path / "ws_jq"))
    _project(Path(path))
    with patch("podcast_mcp.mcp.tools.edits.EditService") as svc_cls:
        svc_cls.return_value.join_quality.return_value = {
            "track_id": "host",
            "verdict": "pass",
            "risk": 0.1,
            "disclaimer": "x",
        }
        svc_cls.return_value.join_qa_sweep.return_value = {
            "join_count": 2,
            "fail_count": 0,
            "review_count": 0,
            "pass_count": 2,
        }
        q = json.loads(
            mcp_server.join_quality_tool(path, track_id="host", join_sec=1.5, timebase="timeline")
        )
        s = json.loads(mcp_server.join_qa_sweep_tool(path, track_id="host"))
    assert q["verdict"] == "pass"
    assert s["join_count"] == 2
    svc_cls.return_value.join_quality.assert_called_once()
    svc_cls.return_value.join_qa_sweep.assert_called_once_with(track_id="host")
