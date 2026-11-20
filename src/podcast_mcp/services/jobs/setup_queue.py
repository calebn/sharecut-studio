"""Episodes whose first run waits for a model download: one app-level sidecar, FIFO.

The file is ``setup_queue.json`` in ``settings.config_dir()`` next to ``recent_projects.json``.
One entry per project file: the run request (with its resolved config, so a restart can still
start it) and the models it waits for. The queue lock covers one read-modify-write and is never
held while models are validated or a job starts. One Studio host per config directory is the
supported setup; the lock does not span processes.
"""

from __future__ import annotations

import logging
import threading
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from podcast_mcp import settings
from podcast_mcp.util.atomic_json import load_json_object, write_json_atomic
from podcast_mcp.util.coded_error import CodedValueError

log = logging.getLogger(__name__)

SETUP_QUEUE_FILENAME = "setup_queue.json"
_LOCK = threading.Lock()
_CANCELS: dict[str, int] = {}
PARKED: dict[str, tuple[str, dict[str, Any] | None]] = {}
FAILURES: dict[str, int] = {}
_MOVING: dict[str, int] = {}
_PARTNER: dict[str, str] = {}
CORRUPT_KEEP = 3
CLAIM_MOVING = -1


class Move:
    """One episode's move in progress; ``follow`` is called with the lock not held."""

    def __init__(self, queue: SetupQueue, old_key: str) -> None:
        self.queue = queue
        self.old_key = old_key
        self.new_key: str | None = None
        self.displaced: dict[str, Any] | None = None
        self.token: str | None = None

    def follow(self, new: Path | str) -> None:
        """Re-key the entry to ``new``; raises OSError when the queue file cannot be written."""
        new_key = _key(new)
        with _LOCK:
            self.new_key = new_key
            _MOVING[new_key] = _MOVING.get(new_key, 0) + 1
            _PARTNER[self.old_key] = new_key
            _PARTNER[new_key] = self.old_key
            entries = self.queue._load()
            hit = next((e for e in entries if e["project_path"] == self.old_key), None)
            if hit is None:
                return
            self.displaced = next((e for e in entries if e["project_path"] == new_key), None)
            kept = [e for e in entries if e is not self.displaced]
            hit["project_path"] = new_key
            self.queue._store(kept)
            _carry(self.old_key, new_key)
            self.token = hit["token"]

    def roll_back_unless_moved(self) -> None:
        if self.token is None or self.new_key is None or Path(self.new_key).exists():
            return
        _carry(self.new_key, self.old_key)
        try:
            entries = self.queue._load()
            for entry in entries:
                if entry["project_path"] == self.new_key and entry["token"] == self.token:
                    entry["project_path"] = self.old_key
            if self.displaced is not None:
                entries.append(self.displaced)
                entries.sort(key=lambda e: e["queued_at"])
            self.queue._store(entries)
        except OSError:
            log.error("Cannot put the setup queue entry of %s back", self.old_key, exc_info=True)


@dataclass(frozen=True)
class QueuedRun:
    """The answer to a run that was queued instead of started."""

    waiting_for: list[dict[str, Any]]
    position: int

    def payload(self) -> dict[str, Any]:
        return {"queued": True, "waiting_for": self.waiting_for, "position": self.position}


def _carry(old_key: str, new_key: str) -> None:
    for book in (PARKED, FAILURES):
        book.pop(new_key, None)
        if old_key in book:
            book[new_key] = book.pop(old_key)  # type: ignore[assignment]


def _key(project_path: Path | str) -> str:
    return str(Path(project_path).expanduser().resolve())


def _valid(raw: object) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    if not isinstance(raw.get("project_path"), str) or not isinstance(raw.get("request"), dict):
        return None
    waiting_for = raw.get("waiting_for")
    return {
        "project_path": raw["project_path"],
        "token": raw["token"] if isinstance(raw.get("token"), str) else "",
        "queued_at": raw["queued_at"] if isinstance(raw.get("queued_at"), str) else "",
        "request": raw["request"],
        "waiting_for": [m for m in waiting_for if isinstance(m, dict)]
        if isinstance(waiting_for, list)
        else [],
    }


class SetupQueue:
    """Read and change the sidecar; every call reads the file, so any object sees the same queue."""

    @property
    def path(self) -> Path:
        return settings.config_dir() / SETUP_QUEUE_FILENAME

    def _load(self) -> list[dict[str, Any]]:
        try:
            data = load_json_object(self.path)
        except ValueError as exc:
            if "unreadable" in str(exc):
                raise OSError(str(exc)) from exc
            stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
            aside = self.path.with_name(f"{SETUP_QUEUE_FILENAME}.corrupt-{stamp}")
            log.warning(
                "Setup queue %s is unreadable (%s); keeping it as %s", self.path, exc, aside
            )
            self.path.replace(aside)
            for old in sorted(self.path.parent.glob(f"{SETUP_QUEUE_FILENAME}.corrupt-*"))[
                :-CORRUPT_KEEP
            ]:
                old.unlink(missing_ok=True)
            return []
        items = data.get("entries") if data is not None else None
        if not isinstance(items, list):
            return []
        entries = (_valid(item) for item in items)
        return [entry for entry in entries if entry is not None]

    def _store(self, entries: list[dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(self.path, {"version": 1, "entries": entries})

    def entries(self) -> list[dict[str, Any]]:
        with _LOCK:
            return self._load()

    def enqueue(
        self,
        project_path: Path | str,
        *,
        request: dict[str, Any],
        waiting_for: list[dict[str, Any]],
        queued_at: str | None = None,
    ) -> QueuedRun:
        """Add the project, or replace its entry in place; the position it holds is returned."""
        key = _key(project_path)
        with _LOCK:
            if key in _MOVING:
                raise CodedValueError(
                    "This episode is being moved. Try again in a moment.", code="project_moving"
                )
            entries = self._load()
            stamp = queued_at or datetime.now(UTC).isoformat(timespec="microseconds")
            fresh = {
                "project_path": key,
                "token": uuid.uuid4().hex,
                "queued_at": stamp,
                "request": request,
                "waiting_for": waiting_for,
            }
            for index, entry in enumerate(entries):
                if entry["project_path"] == key:
                    entries[index] = {**fresh, "queued_at": entry["queued_at"]}
                    position = index + 1
                    break
            else:
                entries.append(fresh)
                if queued_at is not None:
                    entries.sort(key=lambda entry: entry["queued_at"])
                position = [e["project_path"] for e in entries].index(key) + 1
            self._store(entries)
        return QueuedRun(waiting_for=waiting_for, position=position)

    def claim(self, project_path: Path | str, token: str) -> int | None:
        """Take the entry off the queue for the run that starts it.

        Returns the project's cancel generation, ``None`` when the entry was cancelled or
        replaced since it was read, or ``CLAIM_MOVING`` when its episode is being moved (or
        was, since the run was read): the entry stays and the run must not start.
        """
        key = _key(project_path)
        with _LOCK:
            entries = self._load()
            if key in _MOVING or any(
                e["token"] == token and e["project_path"] != key for e in entries
            ):
                return CLAIM_MOVING
            kept = [e for e in entries if not (e["project_path"] == key and e["token"] == token)]
            if len(kept) == len(entries):
                return None
            self._store(kept)
            return _CANCELS.get(key, 0)

    def requeue(
        self,
        entry: dict[str, Any],
        *,
        waiting_for: list[dict[str, Any]],
        generation: int,
    ) -> str | None:
        """Put a claimed entry back in its place unless the person cancelled or queued it anew.

        Returns the new entry's token, or ``None`` when nothing was put back.
        """
        key = _key(entry["project_path"])
        with _LOCK:
            if _CANCELS.get(key, 0) != generation:
                return None
            entries = self._load()
            if any(e["project_path"] == key for e in entries):
                return None
            token = uuid.uuid4().hex
            entries.append({**entry, "token": token, "waiting_for": waiting_for})
            entries.sort(key=lambda e: e["queued_at"])
            self._store(entries)
            return token

    def take(self, project_path: Path | str) -> tuple[dict[str, Any], int] | None:
        """Remove the project's entry for a run started by hand.

        Returns the entry and the cancel generation, or ``None`` when nothing was queued.
        """
        key = _key(project_path)
        with _LOCK:
            entries = self._load()
            taken = next((e for e in entries if e["project_path"] == key), None)
            if taken is None:
                return None
            self._store([e for e in entries if e is not taken])
            return taken, _CANCELS.get(key, 0)

    def restore(self, entry: dict[str, Any], generation: int) -> None:
        """Put back an entry ``take`` removed, unless it was cancelled or queued anew meanwhile."""
        key = entry["project_path"]
        with _LOCK:
            if _CANCELS.get(key, 0) != generation:
                return
            entries = self._load()
            if any(e["project_path"] == key for e in entries):
                return
            entries.append(entry)
            entries.sort(key=lambda e: e["queued_at"])
            self._store(entries)

    @contextmanager
    def moving(self, old: Path | str) -> Iterator[Move]:
        """Mark an episode as moving for the whole move, before its busy check.

        While marked, no run claims its entry and a drain leaves it alone. ``Move.follow(new)``
        then re-keys the entry (with its parked state and failure count) to ``new`` before the
        rename; an entry already at ``new`` is replaced by the moved episode's. When the project
        file is not at ``new`` at the end, the move failed or was rolled back and everything goes
        back to ``old``.
        """
        move = Move(self, _key(old))
        with _LOCK:
            _MOVING[move.old_key] = _MOVING.get(move.old_key, 0) + 1
        try:
            yield move
        finally:
            with _LOCK:
                try:
                    move.roll_back_unless_moved()
                finally:
                    for key in (move.old_key, move.new_key):
                        if key is not None:
                            _MOVING[key] -= 1
                            if not _MOVING[key]:
                                del _MOVING[key]
                    _PARTNER.pop(move.old_key, None)
                    if move.new_key is not None:
                        _PARTNER.pop(move.new_key, None)

    @staticmethod
    def is_moving(project_path: Path | str) -> bool:
        with _LOCK:
            return _key(project_path) in _MOVING

    def update_waiting(
        self, project_path: Path | str, token: str, waiting_for: list[dict[str, Any]]
    ) -> None:
        key = _key(project_path)
        with _LOCK:
            entries = self._load()
            for entry in entries:
                if entry["project_path"] == key and entry["token"] == token:
                    if entry["waiting_for"] == waiting_for:
                        return
                    entry["waiting_for"] = waiting_for
                    self._store(entries)
                    return

    def cancel(self, project_path: Path | str) -> bool:
        """Remove the project and make any run in flight for it unable to requeue itself."""
        key = _key(project_path)
        with _LOCK:
            keys = {key, _PARTNER.get(key, key)}
            for each in keys:
                _CANCELS[each] = _CANCELS.get(each, 0) + 1
            entries = self._load()
            kept = [entry for entry in entries if entry["project_path"] not in keys]
            if len(kept) == len(entries):
                return False
            self._store(kept)
            return True

    def remove(self, project_path: Path | str, *, unless_moving: bool = False) -> bool:
        key = _key(project_path)
        with _LOCK:
            if unless_moving and key in _MOVING:
                return False
            entries = self._load()
            kept = [entry for entry in entries if entry["project_path"] != key]
            if len(kept) == len(entries):
                return False
            self._store(kept)
            return True

    def holds(self, project_path: Path | str, token: str) -> bool:
        key = _key(project_path)
        return any(
            entry["project_path"] == key and entry["token"] == token for entry in self.entries()
        )

    def waiting_paths(self) -> set[str]:
        try:
            paths = {entry["project_path"] for entry in self.entries()}
            with _LOCK:
                return paths | {_PARTNER[p] for p in paths if p in _PARTNER}
        except OSError:
            log.warning("Cannot read the setup queue at %s", self.path, exc_info=True)
            return set()

    def standing(self, project_path: Path | str | None) -> dict[str, Any]:
        """What the status payload says about one project: waiting, for which models, and where."""
        idle: dict[str, Any] = {
            "waiting": False,
            "waiting_for": [],
            "position": None,
            "parked": False,
        }
        if project_path is None:
            return idle
        key = _key(project_path)
        try:
            entries = self.entries()
        except OSError:
            log.warning("Cannot read the setup queue at %s", self.path, exc_info=True)
            return idle
        with _LOCK:
            keys = {key, _PARTNER.get(key, key)}
        for index, entry in enumerate(entries):
            if entry["project_path"] in keys:
                return {
                    "waiting": True,
                    "waiting_for": entry["waiting_for"],
                    "position": index + 1,
                    "parked": PARKED.get(entry["project_path"], ("",))[0] == entry["token"],
                }
        return idle
