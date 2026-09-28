"""Bridge other processes' sync.db / document.db writes into this process's hub (#695).

Stdio ``podcast-mcp``, the ``podcast session`` / ``podcast play`` CLIs and
``podcast record land`` journal rows into the shared ``artifacts/session/`` stores,
but their hub publish reaches their own, empty hub. While at least one GUI socket
(host ``/api/document/ws`` / ``/api/session/ws``, guest ``/daw/ws``) holds a lease on
a workspace, one daemon thread polls both journals' ``server_seq`` every
``CROSS_PROCESS_POLL_S`` (a parse-free read, the same one the meta routes use) and
republishes rows this process did not publish itself
(``SessionHub.unpublished_seqs``) through the services' ``publish_cross_process_head``.
No lease, no thread.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import threading
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any

from podcast_mcp.services.document_sync.service import (
    DocumentSyncService,
    document_db_path,
    document_hub_key,
    document_server_seq_at,
)
from podcast_mcp.services.session_sync.hub import get_hub
from podcast_mcp.services.session_sync.service import (
    SessionSyncService,
    session_server_seq_at,
    sync_db_path,
)
from podcast_mcp.services.workspace import ProjectWorkspace

log = logging.getLogger(__name__)

CROSS_PROCESS_POLL_S = 0.5
"""Watcher cadence: another process's journal write reaches open tabs within about this long.

Costs two single-row reads per tick per workspace with an open socket (none without one);
a host holding hundreds of workspaces open would want per-workspace backoff or one
shared probe."""

_PUBLISH_ATTEMPTS = 3
"""Ticks a failing cross-process publish is tried on before its rows are left to the sanity poll."""


@dataclass
class _Plane:
    """One journal the watcher follows."""

    name: str
    hub_key: str
    read_seq: Callable[[], int | None]
    publish_head: Callable[[int | None], dict[str, Any] | None]
    seen: int | None = None
    failures: int = 0

    def baseline(self) -> None:
        self.seen = self.read_seq()

    def poll(self) -> dict[str, Any] | None:
        current = self.read_seq()
        if current is None:  # unreadable this tick; best_effort_meta logged it
            return None
        after = self.seen
        if current == after:
            return None
        self.seen = current
        if current == 0:
            return None
        # after is None when the baseline read failed: publish_head checks the head alone.
        if not get_hub().unpublished_seqs(self.hub_key, after, current):
            return None  # every row since the last tick was written and published here
        try:
            event = self.publish_head(after)
        except Exception:
            self.failures += 1
            if self.failures < _PUBLISH_ATTEMPTS:
                self.seen = after  # retry these rows on the next tick
            else:
                self.failures = 0  # give up; the sanity poll converges the tabs
            raise
        self.failures = 0
        return event


class CrossProcessWatcher:
    """Polls one workspace's two journals on a daemon thread until ``stop``."""

    def __init__(self, ws: ProjectWorkspace, *, interval: float) -> None:
        project = ws.project
        self._project_path = ws.path
        self._interval = interval
        self._stop = threading.Event()
        self._start_lock = threading.Lock()
        self._started = False
        self._document: DocumentSyncService | None = None
        session = SessionSyncService(project)
        self.planes = (
            _Plane(
                "session",
                str(project.workspace_path()),
                lambda: session_server_seq_at(sync_db_path(project)),
                session.publish_cross_process_head,
            ),
            _Plane(
                "document",
                document_hub_key(project),
                lambda: document_server_seq_at(document_db_path(project)),
                self._publish_document_head,
            ),
        )
        self._thread = threading.Thread(target=self._run, name="cross-process-sync", daemon=True)

    def start(self) -> None:
        """Baseline both planes, then start polling. Idempotent; blocking (store reads)."""
        with self._start_lock:
            if self._started:
                return
            for plane in self.planes:
                plane.baseline()
            self._thread.start()
            self._started = True

    def stop(self) -> None:
        """Ask the thread to exit after its current tick (non-blocking)."""
        self._stop.set()

    def join(self, timeout: float | None = None) -> None:  # tests
        if self._started:
            self._thread.join(timeout)

    def tick(self) -> None:
        hub = get_hub()
        if all(hub.listener_count(plane.hub_key) == 0 for plane in self.planes):
            return  # nothing subscribed (e.g. a socket between unsubscribe and release)
        for plane in self.planes:
            try:
                plane.poll()
            except Exception:
                log.warning(
                    "Cross-process %s sync failed for %s; tabs fall back to the sanity poll",
                    plane.name,
                    self._project_path,
                    exc_info=True,
                )

    def _publish_document_head(self, after: int | None) -> dict[str, Any] | None:
        if self._document is None:
            self._document = DocumentSyncService.open(self._project_path)
        return self._document.publish_cross_process_head(after)

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            self.tick()


@dataclass
class _Entry:
    watcher: CrossProcessWatcher
    refs: int = 0


class CrossProcessLease:
    """One socket's hold on a workspace watcher; ``release`` is idempotent and never raises."""

    def __init__(
        self, bridge: CrossProcessBridge | None, key: str, watcher: CrossProcessWatcher | None
    ) -> None:
        self._bridge = bridge
        self._key = key
        self._watcher = watcher

    def release(self) -> None:
        bridge, self._bridge = self._bridge, None
        if bridge is not None and self._watcher is not None:
            bridge.release(self._key, self._watcher)


class CrossProcessBridge:
    """Refcounted watchers, one per workspace with at least one leased socket."""

    def __init__(self, *, interval: float | None = None) -> None:
        self._interval = interval
        self._lock = threading.Lock()
        self._entries: dict[str, _Entry] = {}

    def acquire(self, ws: ProjectWorkspace) -> CrossProcessLease:
        """Lease the watcher for ``ws`` (starting it on first use). Blocking: call from a
        worker thread, after subscribing to the hub and before reading the hello snapshot,
        so a write between the two is either in the snapshot or published. Never raises: a
        failure logs and returns a no-op lease (tabs keep the 30 s sanity poll)."""
        key = str(ws.project.workspace_path())
        watcher: CrossProcessWatcher | None = None
        try:
            with self._lock:
                entry = self._entries.get(key)
                if entry is None:
                    interval = (
                        self._interval if self._interval is not None else CROSS_PROCESS_POLL_S
                    )
                    entry = _Entry(CrossProcessWatcher(ws, interval=interval))
                    self._entries[key] = entry
                entry.refs += 1
                watcher = entry.watcher
            watcher.start()
        except Exception:
            log.warning(
                "Could not watch %s for cross-process writes; tabs fall back to the sanity poll",
                ws.path,
                exc_info=True,
            )
            if watcher is not None:
                self.release(key, watcher)
            return CrossProcessLease(None, key, None)
        return CrossProcessLease(self, key, watcher)

    def release(self, key: str, watcher: CrossProcessWatcher) -> None:
        with self._lock:
            entry = self._entries.get(key)
            if entry is None or entry.watcher is not watcher:
                return
            entry.refs -= 1
            if entry.refs > 0:
                return
            del self._entries[key]
        watcher.stop()

    def watching(self, key: str) -> bool:
        with self._lock:
            return key in self._entries

    def stop_all(self) -> None:
        with self._lock:
            entries = list(self._entries.values())
            self._entries.clear()
        for entry in entries:
            entry.watcher.stop()


_BRIDGE = CrossProcessBridge()


def cross_process_bridge() -> CrossProcessBridge:
    return _BRIDGE


def watch_cross_process_writes(ws: ProjectWorkspace) -> CrossProcessLease:
    """Lease the process-wide bridge for ``ws`` (see ``CrossProcessBridge.acquire``)."""
    return _BRIDGE.acquire(ws)


@contextlib.asynccontextmanager
async def cross_process_lease(ws: ProjectWorkspace) -> AsyncIterator[None]:
    """Hold a bridge lease on ``ws`` for the ``async with`` body (#695).

    Enter it after ``hub.subscribe(...)`` and before reading the hello snapshot. It
    acquires off the event loop and releases in its own ``finally``, so a raising
    cleanup step, or a cancellation mid-acquire, never pins the workspace watcher.
    """
    acquiring = asyncio.ensure_future(asyncio.to_thread(watch_cross_process_writes, ws))
    try:
        lease = await asyncio.shield(acquiring)
    except asyncio.CancelledError:
        acquiring.add_done_callback(_release_late_lease)
        raise
    try:
        yield
    finally:
        lease.release()


def _release_late_lease(acquiring: asyncio.Future[CrossProcessLease]) -> None:
    """Release a lease whose acquire finished after the socket task was cancelled."""
    if not acquiring.cancelled() and acquiring.exception() is None:
        acquiring.result().release()
