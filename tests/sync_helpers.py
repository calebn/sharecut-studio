from __future__ import annotations

import asyncio
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import Context
from uuid import uuid4

import pytest

from podcast_mcp.models import EpisodeProject
from podcast_mcp.services.document_sync.service import (
    EXTERNAL_MUTATE,
    EXTERNAL_MUTATE_CLIENT_ID,
    _empty_journal_snapshot,
    _journal_snapshot,
    document_db_path,
)
from podcast_mcp.services.session_sync.log import SyncStore
from podcast_mcp.services.session_sync.service import sync_db_path
from podcast_mcp.services.session_sync.snapshot import apply_command, empty_snapshot


@contextmanager
def _hub_delivery_fence(
    loop: asyncio.AbstractEventLoop, monkeypatch: pytest.MonkeyPatch
) -> Iterator[Callable[[], None]]:
    scheduled: list[asyncio.Future[None]] = []
    call_soon_threadsafe = loop.call_soon_threadsafe

    def schedule(
        callback: Callable[..., object], *args: object, context: Context | None = None
    ) -> asyncio.Handle:
        completed = loop.create_future()

        def deliver() -> None:
            try:
                callback(*args)
            except BaseException as error:
                completed.set_exception(error)
            else:
                completed.set_result(None)

        handle = call_soon_threadsafe(deliver, context=context)
        scheduled.append(completed)
        return handle

    def delivered() -> None:
        batch = tuple(scheduled)
        scheduled.clear()
        assert batch, "no hub delivery was scheduled"
        marker = loop.create_future()
        loop.call_soon(marker.set_result, None)
        loop.run_until_complete(marker)
        for completed in batch:
            assert completed.done(), "scheduled hub delivery did not complete"
            completed.result()

    with monkeypatch.context() as scoped:
        scoped.setattr(loop, "call_soon_threadsafe", schedule)
        yield delivered


def _foreign_session_write(
    project: EpisodeProject,
    sec: float,
    *,
    command_type: str = "SetPlayhead",
    payload: dict | None = None,
    role: str = "agent",
    client_id: str = "agent-control",
) -> dict:
    """Append one row on a fresh sync.db connection, as another process would. By default this
    is an agent ``SetPlayhead`` to ``sec``."""
    store = SyncStore(sync_db_path(project), enforce_command_ids=True)
    try:
        row, _snap, _idempotent = store.append_and_apply(
            command_id=uuid4().hex,
            client_id=client_id,
            client_seq=None,
            role=role,
            type=command_type,
            payload=payload if payload is not None else {"playhead_sec": sec},
            causation_id=None,
            apply_fn=apply_command,
            empty_snap_fn=empty_snapshot,
        )
        return row
    finally:
        store.close()


def drain(q: asyncio.Queue, event_type: str | None = None) -> list[dict]:
    """Pop everything currently queued on a hub queue; with ``event_type``, keep only
    events whose ``type`` matches (e.g. ``"Applied"``).
    """
    out: list[dict] = []
    while True:
        try:
            event = q.get_nowait()
        except asyncio.QueueEmpty:
            return out
        if event_type is None or event.get("type") == event_type:
            out.append(event)


def _foreign_document_write(project: EpisodeProject) -> dict:
    """Append an ``ExternalMutate`` row on a fresh document.db connection."""
    store = SyncStore(document_db_path(project))
    try:
        row, _snap, _idempotent = store.append_and_apply(
            command_id=uuid4().hex,
            client_id=EXTERNAL_MUTATE_CLIENT_ID,
            client_seq=None,
            role="agent",
            type=EXTERNAL_MUTATE,
            payload={"projection": "shell"},
            causation_id=None,
            apply_fn=_journal_snapshot,
            empty_snap_fn=_empty_journal_snapshot,
        )
        return row
    finally:
        store.close()


def receive_host_plane(socket, plane: str) -> dict:
    for _ in range(40):
        frame = socket.receive_json()
        if frame.get("plane") == plane:
            return frame
    raise AssertionError(f"no {plane} frame")
