"""Record room mint/restore/revoke are serialized across processes (#2329).

The room guard is a cross-process file lock beside the in-process per-workspace RLock.
Without it two processes (GUI server and CLI/MCP) each revoke the other's fresh room and
the project ends with no usable record link.
"""

from __future__ import annotations

import contextlib
import json
import subprocess
import sys
import textwrap
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

import pytest

from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration import share as share_module
from podcast_mcp.services.collaboration.review_shares import list_shares
from podcast_mcp.services.collaboration.share import ShareService, _row_live, lookup_share
from podcast_mcp.util.project_state import ProjectBusyError, record_room_lock_path
from test_share_restorable_revoke import (  # noqa: F401  (effects and the autouse fixtures)
    _review_share,
    _room,
    _seed,
    effects,
    project_writes,
    timers,
)

SMALL_TIMEOUT = 0.4
CHILD_DEADLINE_SEC = 60.0


def _record_rows(ws: ProjectWorkspace) -> list[dict]:
    return [r for r in list_shares(ws.project) if r.get("kind") == "record"]


def _usable_rooms(ws: ProjectWorkspace) -> set[str]:
    return {str(r["session_id"]) for r in _record_rows(ws) if _row_live(r)}


_HOLDER = textwrap.dedent(
    """
    import sys
    from pathlib import Path
    from filelock import FileLock

    lock_path = sys.argv[1]
    Path(lock_path).parent.mkdir(parents=True, exist_ok=True)
    with FileLock(lock_path):
        print("held", flush=True)
        sys.stdin.readline()  # blocks until the parent writes a line or closes stdin
    """
)


@contextmanager
def _subprocess_holds(lock_path: Path, tmp_path: Path) -> Iterator[Callable[[], None]]:
    """A real second process holds ``lock_path`` until the yielded ``release()`` is called."""
    proc = subprocess.Popen(
        [sys.executable, "-c", _HOLDER, str(lock_path)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    def release_lock() -> None:
        assert proc.stdin is not None
        proc.stdin.close()
        proc.wait(timeout=CHILD_DEADLINE_SEC)

    try:
        assert proc.stdout is not None
        assert proc.stdout.readline().strip() == "held"
        yield release_lock
    finally:
        if proc.stdin is not None and not proc.stdin.closed:
            proc.stdin.close()
        proc.communicate(timeout=CHILD_DEADLINE_SEC)


@pytest.mark.usefixtures("effects")
def test_mint_is_refused_while_another_process_holds_the_room_lock(
    minimal_project, sample_wav, tmp_workspace, tmp_path, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    lock_path = record_room_lock_path(Path(ws.project.workspace_dir))
    monkeypatch.setattr(share_module, "RECORD_ROOM_LOCK_TIMEOUT_SEC", SMALL_TIMEOUT)
    with _subprocess_holds(lock_path, tmp_path) as release:
        with pytest.raises(ProjectBusyError):
            ShareService(ws).create_record_room()
        assert _record_rows(ws) == []
        release()
        room = ShareService(ws).create_record_room()
    assert _usable_rooms(ws) == {room["session_id"]}


@pytest.mark.usefixtures("effects")
def test_revoke_room_is_refused_while_another_process_holds_the_room_lock(
    minimal_project, sample_wav, tmp_workspace, tmp_path, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    room = _room(ws)
    lock_path = record_room_lock_path(Path(ws.project.workspace_dir))
    monkeypatch.setattr(share_module, "RECORD_ROOM_LOCK_TIMEOUT_SEC", SMALL_TIMEOUT)
    with _subprocess_holds(lock_path, tmp_path):
        with pytest.raises(ProjectBusyError):
            ShareService(ws).revoke_room(room["session_id"])
        with pytest.raises(ProjectBusyError):
            ShareService(ws).revoke(room["producer"]["token"])
    assert _usable_rooms(ws) == {room["session_id"]}


@pytest.mark.usefixtures("effects")
def test_restore_is_refused_while_another_process_holds_the_room_lock(
    minimal_project, sample_wav, tmp_workspace, tmp_path, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    room = _room(ws)
    now = datetime(2030, 1, 1, tzinfo=UTC)
    ShareService(ws).revoke_room(room["session_id"], restorable_for=10.0, now=now)
    lock_path = record_room_lock_path(Path(ws.project.workspace_dir))
    monkeypatch.setattr(share_module, "RECORD_ROOM_LOCK_TIMEOUT_SEC", SMALL_TIMEOUT)
    with _subprocess_holds(lock_path, tmp_path):
        with pytest.raises(ProjectBusyError):
            ShareService(ws).restore_room(room["session_id"], now=now)
        with pytest.raises(ProjectBusyError):
            ShareService(ws).restore(room["producer"]["token"], now=now)
    assert _usable_rooms(ws) == set()


_CHILD = textwrap.dedent(
    """
    import json, sys
    from pathlib import Path

    name, proj = sys.argv[1:3]

    from podcast_mcp.project.store import WriteGrantKind, write_grant
    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.services.collaboration.share import ShareService
    import podcast_mcp.services.record as rec

    with write_grant(WriteGrantKind.DISPATCHER):
        if name == "A":
            orig = rec.begin_record_session

            def paused(project, sid, target):
                result = orig(project, sid, target)
                print("minted", flush=True)
                sys.stdin.readline()  # the parent releases A once B finished or is blocked on A
                return result

            rec.begin_record_session = paused
        ws = ProjectWorkspace.open(Path(proj))
        out = {"proc": name, "ok": False}
        try:
            room = ShareService(ws).create_record_room(target=None)
            out.update(ok=True, session_id=room["session_id"])
        except Exception as exc:
            out.update(error=type(exc).__name__)
        print(json.dumps(out), flush=True)
    """
)


@pytest.mark.usefixtures("effects")
def test_two_processes_minting_concurrently_leave_a_usable_room(
    minimal_project, sample_wav, tmp_workspace, tmp_path
):
    _seed(minimal_project, sample_wav)

    def spawn(name: str) -> subprocess.Popen[str]:
        return subprocess.Popen(
            [sys.executable, "-c", _CHILD, name, str(minimal_project)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    a = spawn("A")
    assert a.stdout is not None and a.stdin is not None
    assert a.stdout.readline().strip() == "minted"  # A holds its fresh room, paused
    b = spawn("B")
    outputs: dict[str, tuple[str, str]] = {}
    # B either finishes while A is paused or is legitimately blocked on A's lock.
    with contextlib.suppress(subprocess.TimeoutExpired):
        outputs["B"] = b.communicate(timeout=3.0)
    a.stdin.close()
    outputs["A"] = a.communicate(timeout=120)
    if "B" not in outputs:
        outputs["B"] = b.communicate(timeout=120)
    results: dict[str, dict] = {}
    for name, proc in (("A", a), ("B", b)):
        out, err = outputs[name]
        assert proc.returncode == 0, f"{name} failed: {err[-800:]}"
        results[name] = json.loads(out.strip().splitlines()[-1])

    fresh = ProjectWorkspace.open(minimal_project)
    usable = _usable_rooms(fresh)
    winners = {r["session_id"] for r in results.values() if r["ok"]}
    assert winners, f"no mint succeeded: {results}"
    # Some usable room exists, and at least one reported winner is still usable.
    assert usable, f"both mints finished with no usable room: {results}"
    assert winners & usable, f"every reported room was revoked: {results}"
    # Exactly one live room (the latest mint wins) with both of its tokens usable.
    assert len(usable) == 1
    (sid,) = usable
    live_roles = {r["role"] for r in _record_rows(fresh) if r["session_id"] == sid and _row_live(r)}
    assert live_roles == {"guest", "producer"}


@pytest.mark.usefixtures("effects")
def test_in_process_waiter_gives_up_with_project_busy_instead_of_waiting_forever(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    monkeypatch.setattr(share_module, "RECORD_ROOM_LOCK_TIMEOUT_SEC", SMALL_TIMEOUT)
    held = threading.Event()
    release = threading.Event()

    def holder() -> None:
        with share_module._room_thread_lock(Path(ws.project.workspace_dir).resolve()):
            held.set()
            release.wait(30)

    thread = threading.Thread(target=holder)
    thread.start()
    try:
        assert held.wait(10)
        outcome: list[BaseException | None] = []

        def contender() -> None:
            try:
                with write_grant(WriteGrantKind.DISPATCHER):
                    ShareService(ws).create_record_room()
                outcome.append(None)
            except BaseException as exc:
                outcome.append(exc)

        waiter = threading.Thread(target=contender)
        waiter.start()
        waiter.join(10)
        assert not waiter.is_alive(), "mint is still blocked on the in-process lock"
        assert isinstance(outcome[0], ProjectBusyError), outcome
    finally:
        release.set()
        thread.join(30)
    assert _record_rows(ws) == []


@pytest.mark.usefixtures("effects")
def test_two_mints_in_a_row_leave_only_the_second_room_usable(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    assert _usable_rooms(ws) == {room["session_id"]}
    again = ShareService(ws).create_record_room()
    assert _usable_rooms(ws) == {again["session_id"]}


@contextmanager
def _guard_held_by_another_thread(ws: ProjectWorkspace) -> Iterator[threading.Event]:
    held = threading.Event()
    release = threading.Event()

    def holder() -> None:
        with ShareService(ws)._record_room_guard():
            held.set()
            release.wait(30)

    thread = threading.Thread(target=holder)
    thread.start()
    try:
        assert held.wait(10)
        yield release
    finally:
        release.set()
        thread.join(30)


@pytest.mark.usefixtures("effects")
def test_review_revoke_and_restore_do_not_wait_for_the_room_guard(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    room = _room(ws)
    share = _review_share(ws)
    monkeypatch.setattr(share_module, "RECORD_ROOM_LOCK_TIMEOUT_SEC", SMALL_TIMEOUT)
    now = datetime(2030, 1, 1, tzinfo=UTC)
    with _guard_held_by_another_thread(ws):
        ShareService(ws).revoke(share["token"], restorable_for=10.0, now=now)
        ShareService(ws).restore(share["token"], now=now)
        ShareService(ws).revoke(share["token"])
        with pytest.raises(ProjectBusyError):
            ShareService(ws).revoke(room["producer"]["token"])
    with pytest.raises(KeyError):
        lookup_share(share["token"])


@pytest.mark.usefixtures("effects")
@pytest.mark.parametrize("call", ["revoke", "restore"])
def test_a_token_that_reads_as_unknown_waits_for_the_guard(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, call
):
    """The token looks unknown on both reads: fail closed and wait for the guard."""
    ws = _seed(minimal_project, sample_wav)
    room = _room(ws)
    token = room["producer"]["token"]
    monkeypatch.setattr(share_module, "RECORD_ROOM_LOCK_TIMEOUT_SEC", SMALL_TIMEOUT)
    monkeypatch.setattr(share_module.share_pending, "pending_row", lambda ws, token: None)
    monkeypatch.setattr(
        share_module,
        "list_shares",
        lambda project: [r for r in list_shares(project) if r.get("token") != token],
    )
    with _guard_held_by_another_thread(ws):
        with pytest.raises(ProjectBusyError):
            getattr(ShareService(ws), call)(token)


@pytest.mark.usefixtures("effects")
def test_a_token_parked_between_the_two_reads_is_answered_from_the_guarded_read(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    """The first read misses; the holder releases; the re-read under the guard sees the park."""
    ws = _seed(minimal_project, sample_wav)
    room = _room(ws)
    token = room["producer"]["token"]
    now = datetime(2030, 1, 1, tzinfo=UTC)
    ShareService(ws).revoke_room(room["session_id"], restorable_for=10.0, now=now)
    parked = share_module.share_pending.pending_row(ws, token)
    assert parked is not None
    monkeypatch.setattr(share_module, "RECORD_ROOM_LOCK_TIMEOUT_SEC", 30.0)
    real = share_module.share_pending.pending_row
    calls: list[str] = []

    def pending_row(workspace, tok):
        calls.append(tok)
        return None if len(calls) == 1 else real(workspace, tok)

    monkeypatch.setattr(share_module.share_pending, "pending_row", pending_row)
    with _guard_held_by_another_thread(ws) as release:
        threading.Timer(0.3, release.set).start()
        result = ShareService(ws).revoke(token, restorable_for=10.0, now=now)
    assert len(calls) == 2
    assert result == {
        "revoked": True,
        "token": token,
        "restorable_until": parked["restorable_until"],
    }


@pytest.mark.usefixtures("effects")
def test_an_absent_token_gets_no_review_cleanup(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    cleaned: list[object] = []
    monkeypatch.setattr(share_module, "list_shares", lambda project: [])
    monkeypatch.setattr(share_module, "revoke_share", lambda project, token: True)
    monkeypatch.setattr(
        share_module.share_pending, "delete_review_effects", lambda *a: cleaned.append(a)
    )
    ShareService(ws).revoke("no-such-token")
    assert cleaned == []


@pytest.mark.usefixtures("effects")
def test_a_failed_row_read_propagates_and_revokes_nothing(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, caplog
):
    ws = _seed(minimal_project, sample_wav)
    share = _review_share(ws)
    token = share["token"]

    def boom(workspace, tok):
        raise OSError("sidecar unreadable")

    with monkeypatch.context() as patch:
        patch.setattr(share_module.share_pending, "pending_row", boom)
        with pytest.raises(OSError, match="sidecar unreadable"):
            ShareService(ws).revoke(token, restorable_for=10.0)
    assert share_module.get_share_registry().get_active(token) is not None
    assert share_module.share_pending.pending_row(ws, token) is None
    assert token not in caplog.text


@pytest.mark.usefixtures("effects")
def test_a_held_room_guard_on_one_project_does_not_block_another_project(
    minimal_project, sample_wav, tmp_workspace, tmp_path, monkeypatch
):
    ws = _seed(minimal_project, sample_wav)
    monkeypatch.setattr(share_module, "RECORD_ROOM_LOCK_TIMEOUT_SEC", SMALL_TIMEOUT)
    other = Path(ws.project.workspace_dir).parent / "other-project-workspace"
    other.mkdir()
    held = share_module._room_thread_lock(other)
    assert held is not share_module._room_thread_lock(Path(ws.project.workspace_dir).resolve())
    release = threading.Event()
    taken = threading.Event()

    def holder() -> None:
        with held:
            taken.set()
            release.wait(30)

    thread = threading.Thread(target=holder)
    thread.start()
    try:
        assert taken.wait(10)
        room = ShareService(ws).create_record_room()
    finally:
        release.set()
        thread.join(30)
    assert _usable_rooms(ws) == {room["session_id"]}
