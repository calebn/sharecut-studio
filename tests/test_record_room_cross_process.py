# ruff: noqa: F401, F811  (fixtures imported from test_share_restorable_revoke)
"""Record room mint/restore/revoke are serialized across processes (#2329).

The room guard is a cross-process file lock beside the in-process RLock. Without it two
processes (GUI server and CLI/MCP) each revoke the other's fresh room and the project ends
with no usable record link.
"""

from __future__ import annotations

import json
import logging
import subprocess
import sys
import textwrap
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

import pytest

from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration import share as share_module
from podcast_mcp.services.collaboration.review_shares import list_shares
from podcast_mcp.services.collaboration.share import ShareService, _row_live
from podcast_mcp.util.project_state import ProjectBusyError
from test_share_restorable_revoke import (
    _room,
    _seed,
    effects,
    project_writes,
    timers,
)

SMALL_TIMEOUT = 0.4
CHILD_DEADLINE_SEC = 60.0


def _room_lock_path(ws: ProjectWorkspace) -> Path:
    # Imported lazily so the helper missing is a red for the tests that need it only.
    from podcast_mcp.util.project_state import record_room_lock_path

    return record_room_lock_path(Path(ws.project.workspace_dir))


def _wait_for(path: Path, deadline: float = CHILD_DEADLINE_SEC) -> None:
    end = time.monotonic() + deadline
    while not path.exists():
        assert time.monotonic() < end, f"timed out waiting for {path}"
        time.sleep(0.02)


def _record_rows(ws: ProjectWorkspace) -> list[dict]:
    return [r for r in list_shares(ws.project) if r.get("kind") == "record"]


def _usable_rooms(ws: ProjectWorkspace) -> set[str]:
    return {str(r["session_id"]) for r in _record_rows(ws) if _row_live(r)}


_HOLDER = textwrap.dedent(
    """
    import sys
    from pathlib import Path
    from filelock import FileLock

    lock_path, held, release = sys.argv[1:4]
    Path(lock_path).parent.mkdir(parents=True, exist_ok=True)
    with FileLock(lock_path):
        Path(held).write_text("1")
        while not Path(release).exists():
            import time
            time.sleep(0.02)
    """
)


@contextmanager
def _subprocess_holds(lock_path: Path, tmp_path: Path) -> Iterator[Path]:
    """A real second process holds ``lock_path`` until the yielded release file appears."""
    held = tmp_path / "held"
    release = tmp_path / "release"
    proc = subprocess.Popen(
        [sys.executable, "-c", _HOLDER, str(lock_path), str(held), str(release)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        _wait_for(held)
        yield release
    finally:
        release.write_text("1")
        proc.communicate(timeout=30)


def test_mint_is_refused_while_another_process_holds_the_room_lock(
    minimal_project, sample_wav, tmp_workspace, tmp_path, effects, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    lock_path = _room_lock_path(ws)
    monkeypatch.setattr(share_module, "RECORD_ROOM_LOCK_TIMEOUT_SEC", SMALL_TIMEOUT)
    with _subprocess_holds(lock_path, tmp_path) as release:
        with pytest.raises(ProjectBusyError):
            ShareService(ws).create_record_room()
        assert _record_rows(ws) == []
        release.write_text("1")
        deadline = time.monotonic() + 30
        room = None
        while room is None:
            try:
                room = ShareService(ws).create_record_room()
            except ProjectBusyError:
                assert time.monotonic() < deadline, "lock never released"
                time.sleep(0.05)
    assert _usable_rooms(ws) == {room["session_id"]}


def test_revoke_room_is_refused_while_another_process_holds_the_room_lock(
    minimal_project, sample_wav, tmp_workspace, tmp_path, effects, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    room = _room(ws)
    lock_path = _room_lock_path(ws)
    monkeypatch.setattr(share_module, "RECORD_ROOM_LOCK_TIMEOUT_SEC", SMALL_TIMEOUT)
    with _subprocess_holds(lock_path, tmp_path):
        with pytest.raises(ProjectBusyError):
            ShareService(ws).revoke_room(room["session_id"])
        with pytest.raises(ProjectBusyError):
            ShareService(ws).revoke(room["producer"]["token"])
    assert _usable_rooms(ws) == {room["session_id"]}


def test_restore_is_refused_while_another_process_holds_the_room_lock(
    minimal_project, sample_wav, tmp_workspace, tmp_path, effects, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    room = _room(ws)
    now = datetime(2030, 1, 1, tzinfo=UTC)
    ShareService(ws).revoke_room(room["session_id"], restorable_for=10.0, now=now)
    lock_path = _room_lock_path(ws)
    monkeypatch.setattr(share_module, "RECORD_ROOM_LOCK_TIMEOUT_SEC", SMALL_TIMEOUT)
    with _subprocess_holds(lock_path, tmp_path):
        with pytest.raises(ProjectBusyError):
            ShareService(ws).restore_room(room["session_id"], now=now)
        with pytest.raises(ProjectBusyError):
            ShareService(ws).restore(room["producer"]["token"], now=now)
    assert _usable_rooms(ws) == set()


_CHILD = textwrap.dedent(
    """
    import json, os, sys, time
    from pathlib import Path

    name, proj, bar = sys.argv[1:4]
    bar = Path(bar)

    def wait(p):
        end = time.monotonic() + 60
        while not Path(p).exists():
            if time.monotonic() > end:
                raise SystemExit(f"timeout waiting {p}")
            time.sleep(0.02)

    from podcast_mcp.project.store import WriteGrantKind, write_grant
    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.services.collaboration.share import ShareService
    import podcast_mcp.services.record as rec

    with write_grant(WriteGrantKind.DISPATCHER):
        if name == "A":
            orig = rec.begin_record_session

            def paused(project, sid, target):
                result = orig(project, sid, target)
                (bar / "A_minted").write_text(sid)
                end = time.monotonic() + 3.0  # B may legitimately be waiting on A's lock
                while not (bar / "B_done").exists() and time.monotonic() < end:
                    time.sleep(0.02)
                return result

            rec.begin_record_session = paused
        else:
            wait(bar / "A_minted")
        ws = ProjectWorkspace.open(Path(proj))
        out = {"proc": name, "ok": False}
        try:
            room = ShareService(ws).create_record_room(target=None)
            out.update(ok=True, session_id=room["session_id"])
        except Exception as exc:
            out.update(error=type(exc).__name__)
        if name == "B":
            (bar / "B_done").write_text("1")
        print(json.dumps(out), flush=True)
    """
)


def test_two_processes_minting_concurrently_leave_a_usable_room(
    minimal_project, sample_wav, tmp_workspace, tmp_path, effects
):
    _seed(minimal_project, sample_wav)
    bar = tmp_path / "bar"
    bar.mkdir()
    procs = {
        name: subprocess.Popen(
            [sys.executable, "-c", _CHILD, name, str(minimal_project), str(bar)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        for name in ("A", "B")
    }
    results: dict[str, dict] = {}
    for name, proc in procs.items():
        out, err = proc.communicate(timeout=120)
        assert proc.returncode == 0, f"{name} failed: {err[-800:]}"
        results[name] = json.loads(out.strip().splitlines()[-1])

    fresh = ProjectWorkspace.open(minimal_project)
    usable = _usable_rooms(fresh)
    winners = {r["session_id"] for r in results.values() if r["ok"]}
    assert winners, f"no mint succeeded: {results}"
    # Never zero usable rooms, and no success reported for a room the other mint revoked.
    assert usable, f"both mints finished with no usable room: {results}"
    assert winners & usable, f"every reported room was revoked: {results}"
    # Exactly one live room (the latest mint wins) with both of its tokens usable.
    assert len(usable) == 1
    (sid,) = usable
    live_roles = {r["role"] for r in _record_rows(fresh) if r["session_id"] == sid and _row_live(r)}
    assert live_roles == {"guest", "producer"}


def test_in_process_waiter_gives_up_with_project_busy_instead_of_waiting_forever(
    minimal_project, sample_wav, tmp_workspace, effects, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    monkeypatch.setattr(share_module, "RECORD_ROOM_LOCK_TIMEOUT_SEC", SMALL_TIMEOUT)
    held = threading.Event()
    release = threading.Event()

    def holder() -> None:
        with share_module._record_room_lock:
            held.set()
            release.wait(30)

    thread = threading.Thread(target=holder)
    thread.start()
    try:
        assert held.wait(10)
        outcome: list[BaseException | None] = []

        def contender() -> None:
            from podcast_mcp.project.store import WriteGrantKind, write_grant

            try:
                with write_grant(WriteGrantKind.DISPATCHER):
                    ShareService(ws).create_record_room()
                outcome.append(None)
            except BaseException as exc:
                outcome.append(exc)

        waiter = threading.Thread(target=contender)
        started = time.monotonic()
        waiter.start()
        waiter.join(10)
        assert not waiter.is_alive(), "mint is still blocked on the in-process lock"
        assert time.monotonic() - started < 10
        assert isinstance(outcome[0], ProjectBusyError), outcome
    finally:
        release.set()
        thread.join(30)
    assert _record_rows(ws) == []


def test_mint_stays_reentrant_without_contention(
    minimal_project, sample_wav, tmp_workspace, effects
):
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    assert _usable_rooms(ws) == {room["session_id"]}
    again = ShareService(ws).create_record_room()
    assert _usable_rooms(ws) == {again["session_id"]}


def test_regression_pin_first_listing_failure_logs_and_mint_still_returns_room(
    minimal_project, sample_wav, tmp_workspace, effects, monkeypatch, caplog
):
    ws = _seed(minimal_project, sample_wav)
    real = ShareService._live_other_record_rooms
    calls = {"n": 0}

    def flaky(self, session_id):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("listing boom")
        return real(self, session_id)

    revoked: list[str] = []
    monkeypatch.setattr(ShareService, "_live_other_record_rooms", flaky)
    monkeypatch.setattr(
        ShareService, "_revoke_room_tokens", lambda self, sid: revoked.append(sid) or []
    )
    with caplog.at_level(logging.ERROR):
        room = ShareService(ws).create_record_room()
    assert "failed to list previous record rooms" in caplog.text
    assert revoked == []
    assert _usable_rooms(ws) == {room["session_id"]}
