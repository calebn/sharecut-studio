from __future__ import annotations

import subprocess
import threading
from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from pause_policy_public_helpers import project, workspace
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp.tools import timeline as mcp_timeline
from podcast_mcp.models import Track, TrackRole, load_project, save_project
from podcast_mcp.services.document_sync import DocumentCommand, DocumentSyncService
from podcast_mcp.services.document_sync.payloads import validate_payload
from podcast_mcp.util import project_state
from podcast_mcp.util.coded_error import CodedError, CodedValueError
from podcast_mcp.util.project_state import project_commit_lock_path
from process_helpers import reap
from test_project_commit_lock import _CTX, _hold_lock
from test_strip_silence_tool_pin import (
    _REPLY_KEYS,
    _entries,
    _history,
    _journal,
    _path,
    _registered,
    _run,
    _spans,
)
from test_strip_silence_tool_pin import (
    _config as _config,
)


def _rows(path: str) -> list[dict]:
    return DocumentSyncService.open(path).store.commands_after(0)


def _last_command(path: str):
    return load_project(Path(path)).document_sync.last_command


def test_an_applying_call_journals_one_row_with_the_payload_and_the_reply(tmp_path):
    path = _path(tmp_path)
    assert _last_command(path) is None
    reply = _run(path, speaker="Host")
    (row,) = _rows(path)
    assert row["type"] == "StripSilence"
    assert row["client_id"] == "mcp-agent"
    assert row["role"] == "agent"
    stored = row["payload"]
    assert stored["track_id"] is None
    assert stored["speaker"] == "Host"
    assert stored["over_voice_floor_db"] == 0.0
    assert stored["min_duration_sec"] == 0.5
    assert stored["use_inaudible_opt"] is None
    assert set(stored["result"]) == _REPLY_KEYS
    assert stored["result"] == reply
    saved = _last_command(path)
    assert saved is not None
    assert saved.type == "StripSilence"
    assert saved.command_id == row["command_id"]


def test_a_call_that_finds_no_silence_still_journals_and_sets_last_command(tmp_path):
    path = _path(tmp_path)
    reply = _run(path, track_id="host", min_duration_sec=2.0)
    assert reply["silence_intervals"] == 0
    assert _journal(path) == ["StripSilence"]
    assert _last_command(path).type == "StripSilence"
    assert [e["label"] for e in _entries(path)] == ["before strip silence", "after strip silence"]


def test_the_registered_path_journals_exactly_one_row_per_call(tmp_path):
    path = _path(tmp_path)
    assert not _registered({"project_path": path, "track_id": "host"}).is_error
    assert _journal(path) == ["StripSilence"]
    assert "ExternalMutate" not in _journal(path)


def test_each_call_adds_exactly_one_row_and_a_history_step(tmp_path):
    path = _path(tmp_path)
    _run(path, track_id="host")
    _run(path, track_id="host")
    assert _journal(path) == ["StripSilence"] * 2
    assert _history(path)["total"] == 3


def _bare_path(tmp_path: Path) -> str:
    root = tmp_path / "ws"
    root.mkdir()
    result = project(root)
    result.tracks.append(Track(id="bare", label="Bare", role=TrackRole.DIALOGUE, media=None))
    return str(workspace(result).path)


def _guest_path(tmp_path: Path) -> str:
    return _path(tmp_path, guest="quiet")


def _unreadable_path(tmp_path: Path) -> str:
    path = _path(tmp_path)
    (Path(path).parent / "raw" / "host.wav").write_bytes(b"this is not an audio container")
    return path


@pytest.mark.parametrize(
    ("make", "kwargs", "raises"),
    [
        (_path, {}, CodedValueError),
        (_guest_path, {"speaker": "s"}, CodedValueError),
        (_path, {"track_id": "nope"}, CodedError),
        (_bare_path, {"track_id": "bare"}, CodedError),
        (_path, {"track_id": "host", "min_duration_sec": float("nan")}, CodedValueError),
        (_unreadable_path, {"track_id": "host"}, subprocess.CalledProcessError),
    ],
    ids=[
        "missing-argument",
        "ambiguous-speaker",
        "track-not-found",
        "track-has-no-media",
        "invalid-payload",
        "unreadable-media",
    ],
)
def test_an_error_writes_no_row_and_leaves_last_command_alone(tmp_path, make, kwargs, raises):
    path = make(tmp_path)
    before = Path(path).read_bytes()
    with pytest.raises(raises):
        _run(path, **kwargs)
    assert _journal(path) == []
    assert _last_command(path) is None
    assert Path(path).read_bytes() == before
    assert _history(path)["total"] == 0


def test_a_missing_project_writes_no_row_and_stays_project_not_found(tmp_path):
    missing = str(tmp_path / "nope")
    with pytest.raises(FileNotFoundError) as raised:
        mcp_timeline.strip_silence_tool(missing, track_id="host")
    assert raised.value.code == "project_not_found"


def test_the_payload_defaults():
    assert validate_payload("StripSilence", {}) == {
        "track_id": None,
        "speaker": None,
        "over_voice_floor_db": 0.0,
        "min_duration_sec": 0.5,
        "use_inaudible_opt": None,
    }


def test_numeric_strings_ints_and_bools_are_coerced_to_floats(tmp_path):
    path = _path(tmp_path)
    _run(path, track_id="host", over_voice_floor_db="3.0", min_duration_sec=True)
    params = _entries(path)[1]["params"]
    assert params["over_voice_floor_db"] == 3.0
    assert params["min_duration_sec"] == 1.0
    assert isinstance(params["min_duration_sec"], float)
    other = _path(tmp_path / "other")
    _run(other, track_id="host", over_voice_floor_db=3, min_duration_sec=1)
    other_params = _entries(other)[1]["params"]
    assert isinstance(other_params["over_voice_floor_db"], float)
    assert isinstance(other_params["min_duration_sec"], float)


def test_a_track_added_by_an_outside_write_resolves_on_the_saved_file(tmp_path):
    path = _path(tmp_path)
    saved = load_project(Path(path))
    host = saved.tracks[0]
    saved.tracks.append(host.model_copy(update={"id": "late", "label": "Late"}))
    saved.clips.append(
        saved.clips[0].model_copy(update={"id": "late-0", "track_id": "late"}),
    )
    save_project(saved, Path(path))
    reply = _run(path, track_id="late")
    assert reply["track_id"] == "late"
    assert _journal(path) == ["StripSilence"]


def test_a_second_writer_waits_for_the_held_call_and_gets_a_later_server_seq(tmp_path, monkeypatch):
    from podcast_mcp.services.document import analysis

    path = _path(tmp_path)
    started = threading.Event()
    release = threading.Event()
    real = analysis.strip_silence

    def slow(*args, **kwargs):
        started.set()
        assert release.wait(30)
        return real(*args, **kwargs)

    monkeypatch.setattr(analysis, "strip_silence", slow)
    outcome: dict[str, object] = {}

    def strip() -> None:
        outcome["reply"] = _run(path, track_id="host")

    def meta() -> None:
        command = DocumentCommand(
            type="SetTrackMeta",
            payload={"track_id": "host", "label": "Renamed"},
            client_id="gui",
            client_seq=1,
            role="host",
        )
        outcome["meta"] = DocumentSyncService.open(path).submit(command)

    first = threading.Thread(target=strip)
    first.start()
    assert started.wait(30)
    second = threading.Thread(target=meta)
    second.start()
    second.join(1.0)
    assert second.is_alive()
    release.set()
    first.join(60)
    second.join(60)
    assert not first.is_alive()
    assert not second.is_alive()
    assert set(outcome["reply"]) == _REPLY_KEYS
    assert _journal(path) == ["StripSilence", "SetTrackMeta"]
    assert [r["server_seq"] for r in _rows(path)] == sorted(r["server_seq"] for r in _rows(path))
    assert len(_spans(path)) == 3


def test_a_real_submit_carries_the_shell_snapshot_with_the_rebuilt_clips(tmp_path):
    path = _path(tmp_path)
    command = DocumentCommand(
        type="StripSilence",
        payload={"track_id": "host"},
        client_id="mcp-agent",
        client_seq=None,
        role="agent",
    )
    result = DocumentSyncService.open(path).submit(command)
    assert result["snapshot"]["delta"]["projection"] == "shell"
    snapshot = DocumentSyncService.open(path).document_snapshot()
    project_view = snapshot["project"]
    assert project_view["clips"]["clip_count"] == 3
    assert project_view["timeline_duration_sec"] == pytest.approx(3.2)
    assert [u["text"] for u in project_view["transcript"]["utterances"]] == ["h0", "h2", "h3"]


def _post(client: TestClient, path: str, payload: dict):
    return client.post(
        f"/api/document/command?path={quote(path)}",
        json={"type": "StripSilence", "payload": payload, "client_id": "gui", "client_seq": 1},
    )


def test_the_command_route_maps_a_missing_track_to_a_409_conflict(tmp_path):
    path = _path(tmp_path)
    response = _post(TestClient(create_app()), path, {"track_id": "nope"})
    assert response.status_code == 409
    assert response.headers["x-sharecut-error-code"] == "track_not_found"
    assert response.json()["detail"]["conflict"] is True
    assert _journal(path) == []


def test_the_command_route_maps_missing_argument_to_a_400(tmp_path):
    path = _path(tmp_path)
    response = _post(TestClient(create_app()), path, {})
    assert response.status_code == 400
    assert response.headers["x-sharecut-error-code"] == "missing_argument"
    assert _journal(path) == []


def test_the_command_route_applies_a_strip(tmp_path):
    path = _path(tmp_path)
    response = _post(TestClient(create_app()), path, {"track_id": "host"})
    assert response.status_code == 200
    assert _journal(path) == ["StripSilence"]


def test_the_command_route_reports_project_busy_when_the_project_lock_is_held(
    tmp_path, monkeypatch
):
    path = _path(tmp_path)
    lock_path = project_commit_lock_path(load_project(Path(path)))
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    ready, release = _CTX.Event(), _CTX.Event()
    holder = _CTX.Process(target=_hold_lock, args=(str(lock_path), ready, release))
    holder.start()
    assert ready.wait(30)
    monkeypatch.setattr(project_state, "PROJECT_COMMIT_LOCK_TIMEOUT_SEC", 0.3)
    try:
        response = _post(TestClient(create_app()), path, {"track_id": "host"})
    finally:
        release.set()
        reap(holder, 30)
    assert response.status_code == 503
    assert response.headers["x-sharecut-error-code"] == "project_busy"
    assert _journal(path) == []
    assert len(_spans(path)) == 1
