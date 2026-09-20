"""More coverage for speaker service, gui_launch, project_store, document sync."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch
from uuid import uuid4

# patch is used throughout
from podcast_mcp.project_store import ProjectStore
from podcast_mcp.services.comment import CommentService
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.service import (
    DocumentSyncService,
    notify_comments_changed,
)
from podcast_mcp.services.gui_launch import (
    GuiLaunchResult,
    _port_in_use,
    ensure_viewer,
    is_viewer_up,
)
from podcast_mcp.services.speaker import SpeakerService
from podcast_mcp.services.workspace import ProjectWorkspace


def test_gui_launch_result_to_json():
    r = GuiLaunchResult(
        ok=True,
        url="http://x",
        host="127.0.0.1",
        port=1,
        project_path="/p",
        already_running=False,
        opened_browser=False,
    )
    assert json.loads(r.to_json())["ok"] is True


def test_is_viewer_up_false_paths():
    import urllib.error

    with patch(
        "podcast_mcp.services.gui_launch.urllib.request.urlopen",
        side_effect=urllib.error.URLError("down"),
    ):
        assert is_viewer_up("127.0.0.1", 1) is False

    class BadResp:
        status = 500

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return None

        def read(self):
            return b"{}"

    with patch(
        "podcast_mcp.services.gui_launch.urllib.request.urlopen",
        return_value=BadResp(),
    ):
        assert is_viewer_up("127.0.0.1", 1) is False

    class OkBadJson:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return None

        def read(self):
            return b"not-json"

    with patch(
        "podcast_mcp.services.gui_launch.urllib.request.urlopen",
        return_value=OkBadJson(),
    ):
        assert is_viewer_up("127.0.0.1", 1) is False


def test_port_in_use_localhost():
    assert isinstance(_port_in_use("127.0.0.1", 65530), bool)


def test_ensure_viewer_process_exits(tmp_path: Path):
    proj = tmp_path / "episode.project.json"
    proj.write_text("{}", encoding="utf-8")
    proc = MagicMock()
    proc.pid = 9
    proc.poll.return_value = 1
    with (
        patch("podcast_mcp.services.gui_launch.is_viewer_up", return_value=False),
        patch("podcast_mcp.services.gui_launch._port_in_use", return_value=False),
        patch("podcast_mcp.services.gui_launch.popen", return_value=proc),
    ):
        result = ensure_viewer(proj, open_browser=False, wait_sec=0.5)
    assert result.ok is False
    assert "exited" in (result.error or "").lower()


def test_ensure_viewer_timeout(tmp_path: Path):
    proj = tmp_path / "episode.project.json"
    proj.write_text("{}", encoding="utf-8")
    proc = MagicMock()
    proc.pid = 10
    proc.poll.return_value = None
    with (
        patch("podcast_mcp.services.gui_launch.is_viewer_up", return_value=False),
        patch("podcast_mcp.services.gui_launch._port_in_use", return_value=False),
        patch("podcast_mcp.services.gui_launch.popen", return_value=proc),
        patch("podcast_mcp.services.gui_launch.time.sleep"),
    ):
        result = ensure_viewer(proj, open_browser=False, wait_sec=0.01)
    assert result.ok is False
    assert "timed out" in (result.error or "").lower()


def test_ensure_viewer_hint_when_dist_missing(tmp_path: Path):
    proj = tmp_path / "episode.project.json"
    proj.write_text("{}", encoding="utf-8")
    with (
        patch("podcast_mcp.services.gui_launch.is_viewer_up", return_value=True),
        patch(
            "podcast_mcp.services.gui_launch.resolve_gui_static_root",
            return_value=tmp_path / "nodist",
        ),
        patch("podcast_mcp.services.gui_launch.webbrowser.open", return_value=False),
    ):
        result = ensure_viewer(proj, open_browser=True)
    assert result.ok is True
    assert result.hint and "dist" in result.hint.lower()


def test_project_store_dir_and_reload(minimal_project):
    store = ProjectStore(minimal_project.parent)
    project = store.load()
    name = project.meta.name
    assert name
    # reload mutates the same object via model_dump into __dict__
    store.reload(project)
    assert project.meta["name"] == name or getattr(project.meta, "name", None) == name

    from podcast_mcp.models.history import ProjectHistory

    # Re-load a clean model for history sync path
    project = store.load()
    project.history = ProjectHistory()
    store.commit(project)
    assert (project.workspace_path() / "history" / "index.json").is_file()


def test_speaker_service_mocked(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    svc = SpeakerService(ws)

    assert isinstance(svc.doctor(), dict)
    assert isinstance(svc.doctor_static(), dict)
    assert isinstance(svc.profiles(), list)

    mock_backend = MagicMock()
    mock_backend.name.return_value = "mock"
    mock_ctx = MagicMock()
    mock_ctx.speaker_id = MagicMock()

    with (
        patch(
            "podcast_mcp.services.speaker.load_transcript_context",
            return_value=mock_ctx,
        ),
        patch(
            "podcast_mcp.services.speaker.resolve_speaker_backend",
            return_value=mock_backend,
        ),
        patch(
            "podcast_mcp.services.speaker.enroll_track",
            return_value=MagicMock(),
        ),
    ):
        out = svc.enroll(track_id="host")
        assert out["backend"] == "mock"
        assert "host" in out["enrolled"]

    with (
        patch(
            "podcast_mcp.services.speaker.load_transcript_context",
            return_value=mock_ctx,
        ),
        patch(
            "podcast_mcp.services.speaker.resolve_speaker_backend",
            return_value=mock_backend,
        ),
        patch("podcast_mcp.services.speaker.score_window", return_value=None),
    ):
        assert svc.score("host", 0.0, 1.0)["error"]

    wa = MagicMock()
    wa.scores = {"host": 0.9, "guest": 0.1}
    wa.best_track_id = "host"
    wa.to_dict.return_value = {"best": "host"}
    wb = MagicMock()
    wb.scores = {"host": 0.2, "guest": 0.8}
    wb.best_track_id = "guest"
    wb.to_dict.return_value = {"best": "guest"}

    with (
        patch(
            "podcast_mcp.services.speaker.load_transcript_context",
            return_value=mock_ctx,
        ),
        patch(
            "podcast_mcp.services.speaker.resolve_speaker_backend",
            return_value=mock_backend,
        ),
        patch(
            "podcast_mcp.services.speaker.score_window",
            side_effect=[wa, wb],
        ),
    ):
        cmp = svc.compare_pair("host", 0, 1, "guest", 0, 1)
        assert "same_speaker_likely" in cmp
        assert cmp["same_speaker_likely"] is False

    with (
        patch(
            "podcast_mcp.services.speaker.load_transcript_context",
            return_value=mock_ctx,
        ),
        patch(
            "podcast_mcp.services.speaker.resolve_speaker_backend",
            return_value=mock_backend,
        ),
        patch(
            "podcast_mcp.services.speaker.score_window",
            side_effect=[None, wb],
        ),
    ):
        assert svc.compare_pair("host", 0, 1, "guest", 0, 1)["error"]

    with (
        patch(
            "podcast_mcp.services.speaker.load_transcript_context",
            return_value=mock_ctx,
        ),
        patch(
            "podcast_mcp.services.speaker.run_speaker_attribution",
            return_value={"ok": True},
        ),
    ):
        assert svc.attribute(dry_run=True)["ok"] is True
        with patch.object(ws, "mutate", return_value={"applied": True}) as mut:
            assert svc.attribute(dry_run=False)["applied"] is True
            mut.assert_called_once()


def _cmd(type_: str, payload: dict) -> DocumentCommand:
    return DocumentCommand(
        command_id=uuid4().hex,
        client_id="test",
        client_seq=1,
        role="editor",
        type=type_,
        payload=payload,
    )


def test_document_sync_apply_paths(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    comment = CommentService(ws).add(body="doc", author="a", timeline_start=1.0)
    svc = DocumentSyncService.open(minimal_project)

    svc._apply(_cmd("UpdateComment", {"comment_id": comment["id"], "body": "upd"}))
    svc._apply(
        _cmd(
            "ResolveComment",
            {"comment_id": comment["id"], "by": "a", "resolved": True},
        )
    )
    svc._apply(
        _cmd(
            "AddReply",
            {"comment_id": comment["id"], "body": "r", "author": "b"},
        )
    )
    action = svc._apply(_cmd("AddAction", {"comment_id": comment["id"], "text": "todo"}))
    # SetActionDone if action id available
    action_id = None
    if isinstance(action, dict):
        action_id = (
            action.get("id")
            or (action.get("action") or {}).get("id")
            or (action.get("action_item") or {}).get("id")
        )
    if action_id:
        svc._apply(
            _cmd(
                "SetActionDone",
                {
                    "comment_id": comment["id"],
                    "action_id": action_id,
                    "done": True,
                    "by": "a",
                },
            )
        )
    svc._apply(
        _cmd(
            "AddComment",
            {
                "body": "n2",
                "author": "a",
                "timeline_start": 2.0,
            },
        )
    )
    # Delete last comment via DeleteComment
    snap = svc.comments_snapshot()
    last_id = snap["comments"][-1]["id"]
    svc._apply(_cmd("DeleteComment", {"comment_id": last_id}))

    notify_comments_changed(minimal_project)
    with patch(
        "podcast_mcp.services.document_sync.service.DocumentSyncService.open",
        side_effect=OSError("nope"),
    ):
        notify_comments_changed(minimal_project)


def test_mcp_speaker_tools(minimal_project):
    from podcast_mcp.mcp.tools import speaker as speaker_tools

    with patch("podcast_mcp.mcp.tools.speaker.SpeakerService") as Svc:
        Svc.doctor_static.return_value = {"ok": True}
        inst = Svc.return_value
        inst.profiles.return_value = []
        inst.enroll.return_value = {"enrolled": []}
        inst.score.return_value = {"best": "host"}
        inst.attribute.return_value = {"ok": True}
        inst.compare_window.return_value = {"tracks": []}
        inst.label.return_value = {"labeled": 0}
        inst.set_expected_speaker_count.return_value = {"expected_speaker_count": 2}
        assert "ok" in speaker_tools.speaker_doctor_tool()
        speaker_tools.speaker_profiles_tool(str(minimal_project))
        speaker_tools.speaker_enroll_tool(str(minimal_project), track_id="host")
        speaker_tools.speaker_score_tool(str(minimal_project), "host", 0.0, 1.0)
        speaker_tools.speaker_compare_window_tool(str(minimal_project), 0.0, 1.0)
        speaker_tools.speaker_label_tool(str(minimal_project), "host", 0.0, 1.0)
        speaker_tools.speaker_set_count_tool(str(minimal_project), 2)
        speaker_tools.speaker_attribute_tool(str(minimal_project), dry_run=True)


def test_mcp_ingest_verify_and_play_compare(minimal_project):
    from podcast_mcp.mcp.tools import ingest as ingest_tools

    mock_svc = MagicMock()
    mock_svc.verify_alignment.return_value = MagicMock()
    with (
        patch(
            "podcast_mcp.mcp.tools.ingest.IngestService",
            return_value=mock_svc,
        ),
        patch(
            "podcast_mcp.mcp.tools.ingest.verify_result_to_dict",
            return_value={"ok": True},
        ),
    ):
        out = ingest_tools.ingest_verify_alignment_tool(str(minimal_project))
        assert "ok" in out

    result = MagicMock()
    result.source_label = "premix"
    result.start_sec = 0.0
    result.end_sec = 1.0
    result.tier = "premix"
    result.compare_segments = []
    with patch("podcast_mcp.mcp.tools.ingest.PlayService") as PSvc:
        PSvc.return_value.play.return_value = result
        out = ingest_tools.play_compare_tool(str(minimal_project), dry_run=True)
        assert "premix" in out
