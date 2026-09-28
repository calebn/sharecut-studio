"""Per-client presence deltas: diff the roster against what was last fanned out.

Presence is ephemeral, latest-wins state, but the legacy fan-out sent every client's full
row to every subscriber on every tick (``clients^2`` per tick). ``PresenceRosterTracker``
keeps, per project key, the client rows it last fanned out, and diffs the live roster
against that base on every fan-out run:

- A changed set of live client ids (join, ``remove_client``, 30s age-out) sends one full
  ``Presence`` and bumps the roster version.
- Otherwise it sends one ``PresenceDelta`` per client whose row changed, holding only that
  client's changed top-level keys (``changes``) plus changed ``meta`` keys
  (``changes["meta"]``; a ``None`` meta value means that key was removed).

``roster_version`` is a per-project-key monotonic counter that survives ``clear_key``:
versions never repeat for a key within a server process, and one project's joins and
leaves are not observable through another project's version. Every client applies the
rule "equal version -> apply; older version -> drop; newer version or an unknown client
-> request the roster".
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Any

PRESENCE_DELTA = "PresenceDelta"
ROSTER_REQUEST = "RosterRequest"
PRESENCE_RESYNC = "PresenceResync"

# Row keys diffed for a PresenceDelta's top-level ``changes``. ``meta`` is diffed
# separately (``meta_changes``); ``client_id`` identifies the row, not a change.
_ROW_KEYS = ("role", "label", "acked_server_seq", "playhead_sec", "followers")


def row_changes(prev: dict[str, Any] | None, curr: dict[str, Any]) -> dict[str, Any]:
    """Top-level ``changes`` for one client row moving from ``prev`` to ``curr``.

    ``last_seen_ns`` is always included (liveness depends on it); every other top-level
    key is included only when it changed. ``meta`` changes nest under ``changes["meta"]``
    (``meta_changes``), omitted entirely when nothing in ``meta`` changed.
    """
    changes: dict[str, Any] = {"last_seen_ns": curr.get("last_seen_ns")}
    for key in _ROW_KEYS:
        if prev is None or prev.get(key) != curr.get(key):
            changes[key] = curr.get(key)
    meta = meta_changes(prev.get("meta") if prev else None, curr.get("meta"))
    if meta:
        changes["meta"] = meta
    return changes


def meta_changes(prev: dict[str, Any] | None, curr: dict[str, Any] | None) -> dict[str, Any]:
    """Changed top-level ``meta`` keys. A key present in ``prev`` but not ``curr`` maps to
    ``None`` (removed); a key with a new value maps to that value."""
    prev = prev or {}
    curr = curr or {}
    changes: dict[str, Any] = {}
    for key in set(prev) | set(curr):
        if prev.get(key) != curr.get(key):
            changes[key] = curr.get(key) if key in curr else None
    return changes


def presence_roster_event(
    clients: list[dict[str, Any]],
    *,
    roster_version: int,
    server_time_ns: int | None = None,
) -> dict[str, Any]:
    """Full-roster ``Presence`` frame: hello, join/leave, and a ``RosterRequest`` reply."""
    return {
        "type": "Presence",
        "clients": clients,
        "roster_version": roster_version,
        "server_time_ns": server_time_ns if server_time_ns is not None else time.time_ns(),
    }


def presence_delta_event(
    author_client_id: str,
    changes: dict[str, Any],
    *,
    roster_version: int,
    server_time_ns: int | None = None,
) -> dict[str, Any]:
    """One client's changed roster row, for a per-client ``PresenceDelta`` frame."""
    return {
        "type": PRESENCE_DELTA,
        "author_client_id": author_client_id,
        "changes": changes,
        "roster_version": roster_version,
        "server_time_ns": server_time_ns if server_time_ns is not None else time.time_ns(),
    }


def presence_resync_event() -> dict[str, Any]:
    """Hub-overflow marker (``hub._session_overflow``): this subscriber's queue dropped
    buffered ``Presence`` / ``PresenceDelta`` frames, so the client must send a
    ``RosterRequest`` instead of trusting deltas it never received.
    """
    return {"type": PRESENCE_RESYNC}


def is_own_presence_echo(event: dict[str, Any], client_id: str) -> bool:
    """True when ``event`` is a ``PresenceDelta`` authored by ``client_id`` and carries no
    ``followers`` change (the host/guest pumps skip a plain own-cursor echo, but a change
    in the socket's own follower count is still delivered, since nothing else tells a
    client its own ``followers`` count moved)."""
    if event.get("type") != PRESENCE_DELTA:
        return False
    if event.get("author_client_id") != client_id:
        return False
    changes = event.get("changes")
    return not (isinstance(changes, dict) and "followers" in changes)


class PresenceRosterTracker:
    """Per-project-key base of the last fanned-out client rows."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._bases: dict[str, dict[str, dict[str, Any]]] = {}
        self._versions: dict[str, int] = {}

    def version(self, project_key: str) -> int:
        """The roster version last handed out for ``project_key`` (0 before any fan-out)."""
        with self._lock:
            return self._versions.get(project_key, 0)

    def roster(
        self,
        project_key: str,
        read_rows: Callable[[], list[dict[str, Any]]],
    ) -> tuple[list[dict[str, Any]], int]:
        """Rows and version for a ``RosterRequest`` reply, read together under the lock.

        Returns the base rows last fanned out for ``project_key``: exactly what later
        ``PresenceDelta``s diff against, so the pair is consistent by construction. Before
        any fan-out (no base) it falls back to ``read_rows()``, called outside the lock.
        """
        with self._lock:
            base = self._bases.get(project_key)
            version = self._versions.get(project_key, 0)
            if base is not None:
                return [dict(row) for row in base.values()], version
        return read_rows(), version

    def clear_key(self, project_key: str) -> None:
        """Drop the tracked base for ``project_key`` (the hub's ``_key_idle``, or a failed
        fan-out read). The key's version is kept, one int per project key this process has
        fanned out, so a key's versions never repeat within the process and the next
        fan-out sends a full ``Presence`` at a higher version."""
        with self._lock:
            self._bases.pop(project_key, None)

    def reset(self) -> None:
        """Drop every tracked project key. Tests call this between cases."""
        with self._lock:
            self._bases.clear()
            self._versions.clear()

    def events(
        self,
        project_key: str,
        live_rows: list[dict[str, Any]],
        *,
        server_time_ns: int | None = None,
    ) -> list[dict[str, Any]]:
        """Diff ``live_rows`` (``SyncStore.list_clients()``) against the base for
        ``project_key`` and return the frames to fan out.

        A changed live client-id set (including the first call for a key) returns one
        full ``Presence`` at a freshly bumped version. Otherwise returns one
        ``PresenceDelta`` per row that changed since the last diff, at the current
        version, and updates the base for exactly the rows it reports.
        """
        now = server_time_ns if server_time_ns is not None else time.time_ns()
        curr_by_id = {row["client_id"]: row for row in live_rows}
        with self._lock:
            base = self._bases.get(project_key)
            if base is None or set(base) != set(curr_by_id):
                version = self._versions.get(project_key, 0) + 1
                self._versions[project_key] = version
                self._bases[project_key] = {
                    client_id: dict(row) for client_id, row in curr_by_id.items()
                }
                return [
                    presence_roster_event(live_rows, roster_version=version, server_time_ns=now)
                ]
            version = self._versions.get(project_key, 0)
            events: list[dict[str, Any]] = []
            for client_id, row in curr_by_id.items():
                prev_row = base.get(client_id)
                if prev_row == row:
                    continue
                events.append(
                    presence_delta_event(
                        client_id,
                        row_changes(prev_row, row),
                        roster_version=version,
                        server_time_ns=now,
                    )
                )
                base[client_id] = dict(row)
            return events


_TRACKER = PresenceRosterTracker()


def get_roster_tracker() -> PresenceRosterTracker:
    return _TRACKER
