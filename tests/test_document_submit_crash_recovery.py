"""Crash consistency of document submit: kill a writer at each handoff between history,
``episode.project.json`` and ``document.db``, then restart and check what survived.

A crash between the project commit and the journal INSERT/COMMIT still gets journaled by
the next submit (#575). The handoff matrix, the first-commit history case and the
writer blocked on the project lock are #571. The kill is SIGKILL on POSIX and
TerminateProcess on win32.

``DocumentSyncService.submit`` writes one edit in this order, under the project lock and
one open ``document.db`` write transaction:

1. history snapshots + ``history/index.json`` (``HistoryManager.record``)
2. ``episode.project.json`` with ``document_sync.last_command`` (``ProjectStore.commit``)
3. the journal row (``SyncStore.append_and_apply``), then ``Applied`` is published
4. ``COMMIT`` of ``document.db``, then the project lock is released
"""

from __future__ import annotations

import json
import multiprocessing as mp
import os
import signal
import sqlite3
import sys
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from podcast_mcp.models import load_project
from podcast_mcp.project_store import (
    history_index_path,
    history_snapshot_ids,
    read_history_index,
)
from podcast_mcp.services import ProjectWorkspace
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.service import document_db_path, document_server_seq
from podcast_mcp.services.session_sync.log import SyncStore

# win32 has no SIGKILL: os.kill with any signal but CTRL_C/CTRL_BREAK_EVENT calls
# TerminateProcess there (no Python cleanup either), with the signal number as exit code.
_KILL = signal.SIGTERM if sys.platform == "win32" else signal.SIGKILL
_KILLED_EXIT = int(_KILL) if sys.platform == "win32" else -int(_KILL)


def _die(**_ignored: Any) -> None:
    """Kill this process; ignores the details ``record_and_die`` records (``published_seq``)."""
    os.kill(os.getpid(), _KILL)


_CTX = mp.get_context("spawn")

BEFORE_PROJECT_COMMIT = "before_project_commit"
AFTER_PROJECT_COMMIT = "after_project_commit"
AFTER_JOURNAL_INSERT = "after_journal_insert"
MID_PUBLISH = "mid_publish"
AFTER_JOURNAL_COMMIT = "after_journal_commit"


def _crash_command(
    command_id: str = "crash-1", client_seq: int = 1, body: str = "crash"
) -> DocumentCommand:
    return DocumentCommand(
        type="AddComment",
        payload={"body": body, "author": "v", "timeline_start": float(client_seq)},
        client_id="v",
        role="viewer",
        client_seq=client_seq,
        command_id=command_id,
    )


def _arm_kill(point: str, kill_id: str, die: Callable[..., None]) -> None:
    """In this (child) process, call ``die`` at ``point`` of ``kill_id``'s submit.

    ``AFTER_PROJECT_COMMIT`` / ``AFTER_JOURNAL_INSERT`` match ``kill_id``'s journal write,
    so they also reach ``journal_saved_command``'s recovery write of a crash-saved command.
    """
    from podcast_mcp import project_store
    from podcast_mcp.services.session_sync import log as sync_log
    from podcast_mcp.services.session_sync.hub import SessionHub

    if point == BEFORE_PROJECT_COMMIT:
        # History snapshots and index.json are written; die before the project file is.
        def die_instead_of_saving(*_args: Any, **_kwargs: Any) -> None:
            die()

        project_store.save_project = die_instead_of_saving  # type: ignore[assignment]
    elif point in (AFTER_PROJECT_COMMIT, AFTER_JOURNAL_INSERT):
        real_append_and_apply = SyncStore.append_and_apply

        def killing_append_and_apply(self, *, command_id, **kwargs):
            if command_id != kill_id:
                return real_append_and_apply(self, command_id=command_id, **kwargs)
            if point == AFTER_PROJECT_COMMIT:
                # The project commit (with document_sync.last_command) has already
                # landed; die before the journal write even starts.
                die()

            real_apply_fn = kwargs["apply_fn"]

            def killing_apply_fn(snap, appended):
                # The INSERT has run inside the open transaction; die before COMMIT.
                die()
                return real_apply_fn(snap, appended)  # pragma: no cover - never reached

            return real_append_and_apply(
                self, command_id=command_id, **{**kwargs, "apply_fn": killing_apply_fn}
            )

        SyncStore.append_and_apply = killing_append_and_apply  # type: ignore[method-assign]
    elif point == MID_PUBLISH:
        # Applied is built from the journal row, still inside the open transaction.
        def killing_publish(_self: SessionHub, _key: str, event: dict[str, Any]) -> None:
            die(published_seq=event["server_seq"])

        SessionHub.publish = killing_publish  # type: ignore[method-assign]
    elif point == AFTER_JOURNAL_COMMIT:
        real_immediate_transaction = sync_log.immediate_transaction

        def has_kill_row(conn: sqlite3.Connection) -> bool:
            row = conn.execute("SELECT 1 FROM commands WHERE command_id = ?", (kill_id,))
            return row.fetchone() is not None

        @contextmanager
        def commit_then_die(conn: sqlite3.Connection) -> Iterator[None]:
            # Only the transaction that commits kill_id's row, not a later one that
            # finds it already there.
            had_row = has_kill_row(conn)
            with real_immediate_transaction(conn):
                yield
            # COMMIT ran; the project lock is still held.
            if not had_row and has_kill_row(conn):
                die()

        sync_log.immediate_transaction = commit_then_die
    else:
        raise ValueError(point)


def _submit_then_die(
    project_path: str,
    stage: str,
    target_id: str = "crash-1",
    client_seq: int = 1,
    body: str = "crash",
    kill_id: str | None = None,
) -> None:
    """Submit ``target_id``, killing the process at ``stage`` of ``kill_id``'s journal write.

    ``kill_id`` defaults to ``target_id``; pass a crash-saved command's id to kill the
    process inside ``journal_saved_command``'s recovery write instead.
    """
    _arm_kill(stage, kill_id or target_id, _die)
    svc = DocumentSyncService.open(project_path)
    svc.submit(_crash_command(target_id, client_seq, body))


def _run_crash(*args: object) -> None:
    proc = _CTX.Process(target=_submit_then_die, args=args)
    proc.start()
    proc.join(60)
    assert proc.exitcode == _KILLED_EXIT


def _journal_rows(project_path) -> list[tuple[str, object]]:
    store = SyncStore(document_db_path(load_project(project_path)))
    try:
        return [(row["command_id"], row["payload"]["result"]) for row in store.commands_after(0)]
    finally:
        store.close()


@pytest.mark.parametrize("stage", ["after_project_commit", "after_journal_insert"])
def test_sigkill_between_project_commit_and_journal_is_replayed_once(minimal_project, stage):
    _run_crash(str(minimal_project), stage)

    project = load_project(minimal_project)
    assert [c.body for c in project.comments] == ["crash"]
    saved = project.document_sync.last_command
    assert saved is not None
    assert saved.command_id == "crash-1"

    store = SyncStore(document_db_path(project))
    try:
        assert store.commands_after(0) == []
    finally:
        store.close()

    retry = DocumentSyncService.open(minimal_project)
    result = retry.submit(_crash_command())
    assert result["idempotent"] is True
    assert [c.body for c in load_project(minimal_project).comments] == ["crash"]

    store = SyncStore(document_db_path(project))
    try:
        rows = store.commands_after(0)
    finally:
        store.close()
    assert [(r["command_id"], r["payload"]["result"]) for r in rows] == [("crash-1", None)]

    following = retry.submit(
        DocumentCommand(
            type="AddComment",
            payload={"body": "next", "author": "v", "timeline_start": 2.0},
            client_id="v",
            role="viewer",
            client_seq=2,
        )
    )
    assert following["ok"]
    store = SyncStore(document_db_path(project))
    try:
        rows = store.commands_after(0)
    finally:
        store.close()
    assert len(rows) == 2


@pytest.mark.parametrize("stage", ["after_project_commit", "after_journal_insert"])
def test_a_second_crash_after_a_recovery_keeps_both_edits_journaled(minimal_project, stage):
    _run_crash(str(minimal_project), "after_project_commit")
    _run_crash(str(minimal_project), stage, "crash-2", 2, "crash again")

    project = load_project(minimal_project)
    assert [c.body for c in project.comments] == ["crash", "crash again"]
    saved = project.document_sync.last_command
    assert saved is not None
    assert saved.command_id == "crash-2"
    assert saved.base_server_seq == 1
    # The second submit committed the first crash's recovered row before its own apply.
    assert _journal_rows(minimal_project) == [("crash-1", None)]

    retry = DocumentSyncService.open(minimal_project)
    assert retry.submit(_crash_command())["idempotent"] is True
    assert retry.submit(_crash_command("crash-2", 2, "crash again"))["idempotent"] is True
    assert [c.body for c in load_project(minimal_project).comments] == ["crash", "crash again"]
    assert _journal_rows(minimal_project) == [("crash-1", None), ("crash-2", None)]


@pytest.mark.parametrize("stage", ["after_project_commit", "after_journal_insert"])
def test_a_crash_during_recovery_leaves_the_saved_command_recoverable(minimal_project, stage):
    _run_crash(str(minimal_project), "after_project_commit")
    # The next submit journals crash-1 first (its own document.db transaction); kill it
    # there: before that write starts, or after its INSERT but before its COMMIT.
    _run_crash(str(minimal_project), stage, "crash-2", 2, "crash again", "crash-1")

    project = load_project(minimal_project)
    # crash-2 was never applied: recovery runs before its apply.
    assert [c.body for c in project.comments] == ["crash"]
    saved = project.document_sync.last_command
    assert saved is not None
    assert saved.command_id == "crash-1"
    # No row survives the killed recovery transaction.
    assert _journal_rows(minimal_project) == []

    retry = DocumentSyncService.open(minimal_project)
    assert retry.submit(_crash_command("crash-2", 2, "crash again"))["ok"]
    assert retry.submit(_crash_command())["idempotent"] is True
    assert [c.body for c in load_project(minimal_project).comments] == ["crash", "crash again"]
    rows = _journal_rows(minimal_project)
    assert [command_id for command_id, _ in rows] == ["crash-1", "crash-2"]
    assert rows[0][1] is None


# --- #571: every handoff, the first commit's history, and a writer waiting on the lock ---

SEED_ID = "seed-1"
HANDOFF_ID = "crash-571"
WAITER_ID = "waiter-1"
WAITER_LOCK_TIMEOUT_SEC = 15.0


@dataclass(frozen=True)
class Handoff:
    saved: bool  # episode.project.json holds the edit and its last_command when the writer dies
    journaled: bool  # a fresh document.db connection sees its row
    in_transaction: bool  # the dying writer's own connection sees its row
    index_ahead: bool  # history/index.json lists entries episode.project.json does not


HANDOFFS = {
    BEFORE_PROJECT_COMMIT: Handoff(
        saved=False, journaled=False, in_transaction=False, index_ahead=True
    ),
    AFTER_PROJECT_COMMIT: Handoff(
        saved=True, journaled=False, in_transaction=False, index_ahead=False
    ),
    AFTER_JOURNAL_INSERT: Handoff(
        saved=True, journaled=False, in_transaction=True, index_ahead=False
    ),
    MID_PUBLISH: Handoff(saved=True, journaled=False, in_transaction=True, index_ahead=False),
    AFTER_JOURNAL_COMMIT: Handoff(
        saved=True, journaled=True, in_transaction=True, index_ahead=False
    ),
}


def _handoff_command() -> DocumentCommand:
    return _crash_command(HANDOFF_ID, 2, "crashed")


def _bodies(project_path: str | Path) -> list[str]:
    return [c.body for c in load_project(project_path).comments]


def _committed_journal(project_path: str | Path) -> list[list[Any]]:
    """Committed journal rows as [server_seq, command_id, body] on a raw sqlite connection.

    A ``SyncStore`` would run its schema script first, and the dying writer may hold the
    write lock.
    """
    conn = sqlite3.connect(str(document_db_path(load_project(project_path))))
    try:
        rows = conn.execute(
            "SELECT server_seq, command_id, payload FROM commands ORDER BY server_seq"
        ).fetchall()
    finally:
        conn.close()
    return [[int(seq), str(cid), str(json.loads(payload)["body"])] for seq, cid, payload in rows]


def _history_ids(project_path: str | Path) -> tuple[list[str], list[str] | None]:
    """(entry ids saved in episode.project.json, entry ids in history/index.json)."""
    project = load_project(project_path)
    index = read_history_index(history_index_path(project))
    saved = [entry.id for entry in project.history.entries]
    return saved, None if index is None else [entry.id for entry in index.entries]


def _submit_then_die_at(project_path: str, point: str, marker: str, reached=None, go=None):
    """Submit the handoff command; at ``point``, record every store in ``marker`` and die.

    With ``go``, set ``reached`` and wait for ``go`` first, still holding the locks.
    """
    svc = DocumentSyncService.open(project_path)

    def record_and_die(**extra: Any) -> None:
        saved_history, index_history = _history_ids(project_path)
        last = load_project(project_path).document_sync.last_command
        Path(marker).write_text(
            json.dumps(
                {
                    "bodies": _bodies(project_path),
                    "last_command": None if last is None else last.command_id,
                    "journal": _committed_journal(project_path),
                    "in_transaction": svc.store.find_by_command_id(HANDOFF_ID) is not None,
                    "saved_history": saved_history,
                    "index_history": index_history,
                    **extra,
                }
            )
        )
        if reached is not None:
            reached.set()
        if go is not None:
            go.wait(60)
        _die()

    _arm_kill(point, HANDOFF_ID, record_and_die)
    svc.submit(_handoff_command())
    raise AssertionError(f"kill point {point} never fired")


def _submit_waiting_on_the_lock(project_path: str, ready, results) -> None:
    from podcast_mcp.util import project_state

    # Bounded: a lock the killed writer kept would surface as filelock.Timeout (the
    # routes' 503 project_busy) instead of hanging for the default 30 s.
    project_state.PROJECT_COMMIT_LOCK_TIMEOUT_SEC = WAITER_LOCK_TIMEOUT_SEC
    svc = DocumentSyncService.open(project_path)
    ready.set()
    started = time.monotonic()
    try:
        result = svc.submit(_crash_command(WAITER_ID, 3, "second"))
        results.put(("ok", int(result["server_seq"]), time.monotonic() - started))
    except Exception as exc:
        results.put((type(exc).__name__, None, time.monotonic() - started))


def _start_crash_at(project_path: Path, point: str, tmp_path: Path, go=None):
    marker = tmp_path / f"{point}.json"
    reached = _CTX.Event()
    proc = _CTX.Process(
        target=_submit_then_die_at,
        args=(str(project_path), point, str(marker), reached, go),
    )
    proc.start()
    return proc, marker, reached


@pytest.fixture
def seeded_project(minimal_project: Path) -> Path:
    """One journaled comment first, so history and document.db already hold an edit."""
    DocumentSyncService.open(minimal_project).submit(_crash_command(SEED_ID, 1, "seed"))
    return minimal_project


@pytest.mark.parametrize("point", list(HANDOFFS))
def test_sigkill_at_each_handoff_loses_no_edit_and_applies_a_retry_once(
    seeded_project, tmp_path, point
):
    proc, marker, _reached = _start_crash_at(seeded_project, point, tmp_path)
    proc.join(120)
    assert proc.exitcode == _KILLED_EXIT, f"{point} never fired (exit {proc.exitcode})"
    expect = HANDOFFS[point]

    # The handoff: what each store held when the writer died.
    seen = json.loads(marker.read_text())
    assert seen["bodies"] == (["seed", "crashed"] if expect.saved else ["seed"])
    assert seen["last_command"] == (HANDOFF_ID if expect.saved else SEED_ID)
    journaled = [SEED_ID, HANDOFF_ID] if expect.journaled else [SEED_ID]
    assert [row[1] for row in seen["journal"]] == journaled
    assert seen["in_transaction"] is expect.in_transaction
    assert (seen["index_history"] != seen["saved_history"]) is expect.index_ahead
    if expect.index_ahead:
        # The dead commit appended to the index; the saved history is its prefix.
        assert seen["index_history"][: len(seen["saved_history"])] == seen["saved_history"]
    if point == MID_PUBLISH:
        assert seen["published_seq"] == 2  # Applied carried the row's seq before COMMIT

    # Restart: the kill left exactly what the handoff held, and undo stays usable.
    assert _bodies(seeded_project) == seen["bodies"]
    assert _committed_journal(seeded_project) == seen["journal"]
    assert document_server_seq(seeded_project) == len(seen["journal"])
    ws = ProjectWorkspace.open(seeded_project)
    assert [entry.id for entry in ws.project.history.entries] == seen["saved_history"]
    saved_ids = {entry.id for entry in ws.project.history.entries}
    assert saved_ids <= history_snapshot_ids(history_index_path(ws.project))

    # The client never got a reply, so it retries the same command.
    retry = DocumentSyncService.open(seeded_project).submit(_handoff_command())
    assert retry["ok"]
    # A saved edit is journaled (recovered first when the kill beat the COMMIT, #575).
    assert bool(retry.get("idempotent")) is expect.saved
    assert retry["server_seq"] == 2
    assert _bodies(seeded_project) == ["seed", "crashed"]  # applied exactly once
    rows = _journal_rows(seeded_project)
    assert [command_id for command_id, _ in rows] == [SEED_ID, HANDOFF_ID]
    # payload.result is null only on a row recovered from document_sync.last_command.
    assert (rows[1][1] is None) is (expect.saved and not expect.journaled)
    saved_history, index_history = _history_ids(seeded_project)
    assert index_history == saved_history  # the next commit repairs an index left ahead


@pytest.mark.parametrize("point", [BEFORE_PROJECT_COMMIT, MID_PUBLISH, AFTER_JOURNAL_COMMIT])
def test_writer_blocked_on_the_project_lock_proceeds_when_the_holder_is_killed(
    seeded_project, tmp_path, point
):
    go = _CTX.Event()
    crasher, _marker, reached = _start_crash_at(seeded_project, point, tmp_path, go=go)
    ready, results = _CTX.Event(), _CTX.Queue()
    waiter = _CTX.Process(
        target=_submit_waiting_on_the_lock, args=(str(seeded_project), ready, results)
    )
    try:
        assert reached.wait(60), "the crasher never reached its kill point"
        waiter.start()
        assert ready.wait(60)
        time.sleep(0.5)
        assert waiter.is_alive(), "the waiter should block on the holder's project lock"
    finally:
        go.set()
        crasher.join(60)
        if waiter.pid is not None:
            waiter.join(60)
    assert crasher.exitcode == _KILLED_EXIT
    assert waiter.exitcode == 0
    outcome, server_seq, waited = results.get(timeout=10)
    # Not filelock.Timeout, which the routes turn into 503 project_busy.
    assert outcome == "ok"
    assert waited < WAITER_LOCK_TIMEOUT_SEC
    expect = HANDOFFS[point]
    # The waiter built on the saved file and journaled a saved edit before its own.
    ids = [SEED_ID, HANDOFF_ID, WAITER_ID] if expect.saved else [SEED_ID, WAITER_ID]
    assert server_seq == len(ids)
    assert [row[1] for row in _committed_journal(seeded_project)] == ids
    expected_bodies = ["seed", "crashed", "second"] if expect.saved else ["seed", "second"]
    assert _bodies(seeded_project) == expected_bodies


def test_a_crash_before_the_first_commit_adopts_no_phantom_history(minimal_project, tmp_path):
    """A project saved without history ignores the index a killed first commit wrote (#576)."""
    proc, marker, _reached = _start_crash_at(minimal_project, BEFORE_PROJECT_COMMIT, tmp_path)
    proc.join(120)
    assert proc.exitcode == _KILLED_EXIT
    seen = json.loads(marker.read_text())
    assert seen["saved_history"] == []
    assert seen["index_history"]  # the dead commit's record() landed

    assert _bodies(minimal_project) == []
    assert ProjectWorkspace.open(minimal_project).project.history.entries == []

    retry = DocumentSyncService.open(minimal_project).submit(_handoff_command())
    assert retry["ok"]
    assert "idempotent" not in retry
    project = load_project(minimal_project)
    assert [entry.label for entry in project.history.entries] == [
        "before add comment",
        "after add comment",
    ]
    saved_history, index_history = _history_ids(minimal_project)
    assert index_history == saved_history
