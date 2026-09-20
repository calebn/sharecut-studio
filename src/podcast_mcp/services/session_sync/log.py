"""Sqlite append-only command log + materialized snapshot."""

from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from podcast_mcp.services.session_sync.commands import presence_color_index

_TABLE_PREFIX_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _validate_table_prefix(prefix: str) -> str:
    if prefix == "":
        return prefix
    if not _TABLE_PREFIX_RE.fullmatch(prefix):
        raise ValueError(f"invalid table_prefix: {prefix!r}")
    return prefix


def _schema(prefix: str) -> str:
    p = prefix
    return f"""
CREATE TABLE IF NOT EXISTS {p}commands (
  server_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  client_seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  causation_id TEXT,
  ts_ns INTEGER NOT NULL,
  UNIQUE (client_id, client_seq)
);

CREATE TABLE IF NOT EXISTS {p}snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  server_seq INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  updated_at_ns INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS {p}clients (
  client_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  label TEXT,
  acked_server_seq INTEGER NOT NULL DEFAULT 0,
  last_seen_ns INTEGER NOT NULL,
  playhead_sec REAL,
  meta TEXT
);
"""


def _table(prefix: str, name: str) -> str:
    ident = prefix + name
    if ident != name and not _TABLE_PREFIX_RE.fullmatch(ident):
        raise ValueError(f"invalid table name: {ident!r}")
    return ident


def _sql_bundle(prefix: str) -> dict[str, str]:
    """Bind validated table names once so execute() never interpolates identifiers."""
    commands = _table(prefix, "commands")
    snapshot = _table(prefix, "snapshot")
    clients = _table(prefix, "clients")

    def bind(sql: str) -> str:
        return (
            sql.replace("__COMMANDS__", commands)
            .replace("__SNAPSHOT__", snapshot)
            .replace("__CLIENTS__", clients)
        )

    return {
        "get_snapshot": bind(
            "SELECT server_seq, data, updated_at_ns FROM __SNAPSHOT__ WHERE id = 1"
        ),
        "put_snapshot": bind(
            "INSERT INTO __SNAPSHOT__ (id, server_seq, data, updated_at_ns) "
            "VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET "
            "server_seq = excluded.server_seq, data = excluded.data, "
            "updated_at_ns = excluded.updated_at_ns"
        ),
        "find_client_seq": bind(
            "SELECT server_seq, command_id, client_id, client_seq, role, "
            "type, payload, causation_id, ts_ns FROM __COMMANDS__ "
            "WHERE client_id = ? AND client_seq = ?"
        ),
        "find_command_id": bind(
            "SELECT server_seq, command_id, client_id, client_seq, role, "
            "type, payload, causation_id, ts_ns FROM __COMMANDS__ WHERE command_id = ?"
        ),
        "insert_command": bind(
            "INSERT INTO __COMMANDS__ (command_id, client_id, client_seq, role, type, "
            "payload, causation_id, ts_ns) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ),
        "commands_after": bind(
            "SELECT server_seq, command_id, client_id, client_seq, role, "
            "type, payload, causation_id, ts_ns FROM __COMMANDS__ "
            "WHERE server_seq > ? ORDER BY server_seq ASC"
        ),
        "prune_clients": bind("DELETE FROM __CLIENTS__ WHERE last_seen_ns < ?"),
        "select_client": bind("SELECT acked_server_seq, meta FROM __CLIENTS__ WHERE client_id = ?"),
        "upsert_client": bind(
            "INSERT INTO __CLIENTS__ (client_id, role, label, acked_server_seq, "
            "last_seen_ns, playhead_sec, meta) VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(client_id) DO UPDATE SET role = excluded.role, "
            "label = COALESCE(excluded.label, __CLIENTS__.label), "
            "acked_server_seq = CASE WHEN excluded.acked_server_seq > "
            "__CLIENTS__.acked_server_seq THEN excluded.acked_server_seq ELSE "
            "__CLIENTS__.acked_server_seq END, last_seen_ns = excluded.last_seen_ns, "
            "playhead_sec = COALESCE(excluded.playhead_sec, __CLIENTS__.playhead_sec), "
            "meta = excluded.meta"
        ),
        "live_client_ids": bind("SELECT client_id FROM __CLIENTS__ WHERE last_seen_ns >= ?"),
        "delete_client": bind("DELETE FROM __CLIENTS__ WHERE client_id = ?"),
        "delete_all_commands": bind("DELETE FROM __COMMANDS__"),
        "delete_all_clients": bind("DELETE FROM __CLIENTS__"),
        "list_clients": bind(
            "SELECT client_id, role, label, acked_server_seq, last_seen_ns, "
            "playhead_sec, meta FROM __CLIENTS__ WHERE last_seen_ns >= ? ORDER BY client_id"
        ),
    }


_STORE_CACHE: dict[str, SyncStore] = {}
_STORE_LOCK = threading.Lock()


def sync_store_cache_key(path: Path, table_prefix: str = "") -> str:
    return f"{path.resolve()}|{table_prefix}"


def cached_sync_store(path: Path, *, table_prefix: str = "") -> SyncStore:
    key = sync_store_cache_key(path, table_prefix)
    with _STORE_LOCK:
        store = _STORE_CACHE.get(key)
        if store is None:
            store = SyncStore(path, table_prefix=table_prefix)
            _STORE_CACHE[key] = store
        return store


def drop_cached_sync_stores(*, table_prefix: str | None = None) -> list[SyncStore]:
    with _STORE_LOCK:
        if table_prefix is None:
            stores = list(_STORE_CACHE.values())
            _STORE_CACHE.clear()
        else:
            suffix = f"|{table_prefix}"
            keys = [key for key in _STORE_CACHE if key.endswith(suffix)]
            stores = [_STORE_CACHE.pop(key) for key in keys]
    return stores


class SyncStore:
    """Per-project sqlite authority store."""

    def __init__(self, db_path: Path, *, table_prefix: str = "") -> None:
        self.db_path = db_path
        self._p = _validate_table_prefix(table_prefix)
        self._sql = _sql_bundle(self._p)
        self._lock = threading.RLock()
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(
            str(db_path),
            check_same_thread=False,
            isolation_level=None,
        )
        self._conn.row_factory = sqlite3.Row
        self._client_generation: dict[str, int] = {}
        with self._lock:
            self._conn.executescript(_schema(self._p))

    def claim_client(self, client_id: str) -> int:
        with self._lock:
            gen = self._client_generation.get(client_id, 0) + 1
            self._client_generation[client_id] = gen
            return gen

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def _get_snapshot_unlocked(self) -> dict[str, Any] | None:
        row = self._conn.execute(self._sql["get_snapshot"]).fetchone()
        if row is None:
            return None
        data = json.loads(row["data"])
        data["server_seq"] = int(row["server_seq"])
        data["updated_at_ns"] = int(row["updated_at_ns"])
        return data

    def get_snapshot(self) -> dict[str, Any] | None:
        with self._lock:
            return self._get_snapshot_unlocked()

    def _put_snapshot_unlocked(self, server_seq: int, data: dict[str, Any]) -> None:
        payload = json.dumps(data, separators=(",", ":"))
        now = time.time_ns()
        self._conn.execute(self._sql["put_snapshot"], (server_seq, payload, now))

    def put_snapshot(self, server_seq: int, data: dict[str, Any]) -> None:
        with self._lock:
            self._put_snapshot_unlocked(server_seq, data)

    def reset(
        self,
        empty_snap: dict[str, Any],
        *,
        guard: Callable[[dict[str, Any] | None], None] | None = None,
    ) -> None:
        """Drop the command log and clients, then write *empty_snap*."""
        with self._lock:
            if guard is not None:
                guard(self._get_snapshot_unlocked())
            self._conn.execute(self._sql["delete_all_commands"])
            self._conn.execute(self._sql["delete_all_clients"])
            self._client_generation.clear()
            self._put_snapshot_unlocked(0, empty_snap)

    def mutate_snapshot(
        self,
        mutator: Callable[[dict[str, Any]], dict[str, Any] | None],
    ) -> dict[str, Any] | None:
        """Apply *mutator* to the snapshot under the store lock.

        Return ``None`` from *mutator* to skip the write.
        """
        with self._lock:
            snap = self._get_snapshot_unlocked()
            if snap is None:
                return None
            seq = int(snap.get("server_seq") or 0)
            body = {
                key: value
                for key, value in snap.items()
                if key not in ("server_seq", "updated_at_ns")
            }
            updated = mutator(body)
            if updated is None:
                return snap
            updated.pop("server_seq", None)
            updated.pop("updated_at_ns", None)
            self._put_snapshot_unlocked(seq, updated)
            out = dict(updated)
            out["server_seq"] = seq
            return out

    def _find_by_client_seq_unlocked(
        self, client_id: str, client_seq: int
    ) -> dict[str, Any] | None:
        row = self._conn.execute(
            self._sql["find_client_seq"],
            (client_id, client_seq),
        ).fetchone()
        return self._row_to_cmd(row) if row else None

    def find_by_client_seq(self, client_id: str, client_seq: int) -> dict[str, Any] | None:
        with self._lock:
            return self._find_by_client_seq_unlocked(client_id, client_seq)

    def find_by_command_id(self, command_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(self._sql["find_command_id"], (command_id,)).fetchone()
            return self._row_to_cmd(row) if row else None

    def append_command(
        self,
        *,
        command_id: str,
        client_id: str,
        client_seq: int,
        role: str,
        type: str,
        payload: dict[str, Any],
        causation_id: str | None,
    ) -> dict[str, Any]:
        """Insert command; returns full row including server_seq.

        Idempotent on (client_id, client_seq): returns existing row.
        """
        with self._lock:
            return self._append_command_unlocked(
                command_id=command_id,
                client_id=client_id,
                client_seq=client_seq,
                role=role,
                type=type,
                payload=payload,
                causation_id=causation_id,
            )

    def _append_command_unlocked(
        self,
        *,
        command_id: str,
        client_id: str,
        client_seq: int,
        role: str,
        type: str,
        payload: dict[str, Any],
        causation_id: str | None,
    ) -> dict[str, Any]:
        existing = self._find_by_client_seq_unlocked(client_id, client_seq)
        if existing is not None:
            return existing
        now = time.time_ns()
        try:
            cur = self._conn.execute(
                self._sql["insert_command"],
                (
                    command_id,
                    client_id,
                    client_seq,
                    role,
                    type,
                    json.dumps(payload, separators=(",", ":")),
                    causation_id,
                    now,
                ),
            )
            if cur.lastrowid is None:
                raise RuntimeError("sqlite insert returned no lastrowid")
            server_seq = int(cur.lastrowid)
        except sqlite3.IntegrityError:  # pragma: no cover - rare multi-writer race
            again = self._find_by_client_seq_unlocked(client_id, client_seq)
            if again is None:
                raise RuntimeError("failed to append or load command") from None
            return again
        return {
            "server_seq": server_seq,
            "command_id": command_id,
            "client_id": client_id,
            "client_seq": client_seq,
            "role": role,
            "type": type,
            "payload": payload,
            "causation_id": causation_id,
            "ts_ns": now,
        }

    def append_and_apply(
        self,
        *,
        command_id: str,
        client_id: str,
        client_seq: int,
        role: str,
        type: str,
        payload: dict[str, Any],
        causation_id: str | None,
        apply_fn,
        empty_snap_fn,
    ) -> tuple[dict[str, Any], dict[str, Any], bool]:
        """Append (or load idempotent row) and materialize snapshot under one lock.

        Prevents concurrent writers from read-modify-writing stale snapshots.
        Returns ``(row, snapshot, idempotent)``.
        """
        with self._lock:
            existing = self._find_by_client_seq_unlocked(client_id, client_seq)
            if existing is not None:
                snap = self._get_snapshot_unlocked() or empty_snap_fn()
                return existing, snap, True
            row = self._append_command_unlocked(
                command_id=command_id,
                client_id=client_id,
                client_seq=client_seq,
                role=role,
                type=type,
                payload=payload,
                causation_id=causation_id,
            )
            snap = self._get_snapshot_unlocked() or empty_snap_fn()
            snap = apply_fn(snap, row)
            self._put_snapshot_unlocked(int(row["server_seq"]), snap)
            return row, snap, False

    def commands_after(self, server_seq: int) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(self._sql["commands_after"], (server_seq,)).fetchall()
        return [self._row_to_cmd(r) for r in rows]

    def touch_client(
        self,
        client_id: str,
        *,
        role: str,
        label: str | None = None,
        acked_server_seq: int | None = None,
        playhead_sec: float | None = None,
        meta: dict[str, Any] | None = None,
    ) -> None:
        now = time.time_ns()
        prune_cutoff = now - 600_000_000_000
        with self._lock:
            self._conn.execute(self._sql["prune_clients"], (prune_cutoff,))
            row = self._conn.execute(self._sql["select_client"], (client_id,)).fetchone()
            prev_ack = int(row["acked_server_seq"]) if row else 0
            ack = prev_ack if acked_server_seq is None else int(acked_server_seq)
            existing_meta: dict[str, Any] = {}
            if row and row["meta"]:
                try:
                    parsed = json.loads(row["meta"])
                except (TypeError, json.JSONDecodeError):
                    parsed = None
                if isinstance(parsed, dict):
                    existing_meta = parsed
            merged = self._merge_client_meta(client_id, existing_meta, meta, now=now)
            self._conn.execute(
                self._sql["upsert_client"],
                (
                    client_id,
                    role,
                    label,
                    ack,
                    now,
                    playhead_sec,
                    json.dumps(merged, separators=(",", ":")),
                ),
            )

    def _merge_client_meta(
        self,
        client_id: str,
        existing: dict[str, Any],
        incoming: dict[str, Any] | None,
        *,
        now: int,
    ) -> dict[str, Any]:
        merged = dict(existing)
        if incoming is not None:
            patch = dict(incoming)
            patch.pop("color_index", None)
            for key, value in patch.items():
                if value is None:
                    merged.pop(key, None)
                else:
                    merged[key] = value
        if "color_index" not in existing:
            merged["color_index"] = presence_color_index(client_id)
        else:
            merged["color_index"] = existing["color_index"]
        if incoming is not None and incoming.get("transport") is not None:
            transport = merged.get("transport")
            if isinstance(transport, dict):
                merged["transport"] = {**transport, "stamped_ns": now}
        following = merged.get("following")
        if following and (following == client_id or following not in self._live_ids_unlocked(now)):
            merged.pop("following", None)
        return merged

    def _live_ids_unlocked(self, now: int, *, max_age_ns: int = 30_000_000_000) -> set[str]:
        cutoff = now - max_age_ns
        rows = self._conn.execute(self._sql["live_client_ids"], (cutoff,)).fetchall()
        return {str(r["client_id"]) for r in rows}

    def remove_client(self, client_id: str, *, generation: int | None = None) -> None:
        with self._lock:
            if generation is not None and self._client_generation.get(client_id) != generation:
                return
            self._conn.execute(self._sql["delete_client"], (client_id,))
            self._client_generation.pop(client_id, None)

    def list_clients(self, *, max_age_ns: int = 30_000_000_000) -> list[dict[str, Any]]:
        cutoff = time.time_ns() - max_age_ns
        with self._lock:
            rows = self._conn.execute(self._sql["list_clients"], (cutoff,)).fetchall()
        parsed: list[dict[str, Any]] = []
        for r in rows:
            meta = json.loads(r["meta"]) if r["meta"] else None
            if meta is not None and not isinstance(meta, dict):
                meta = None
            parsed.append(
                {
                    "client_id": r["client_id"],
                    "role": r["role"],
                    "label": r["label"],
                    "acked_server_seq": int(r["acked_server_seq"]),
                    "last_seen_ns": int(r["last_seen_ns"]),
                    "playhead_sec": r["playhead_sec"],
                    "meta": meta,
                }
            )
        follower_counts: dict[str, int] = {}
        for row in parsed:
            target = (row["meta"] or {}).get("following") if row["meta"] else None
            if target:
                follower_counts[str(target)] = follower_counts.get(str(target), 0) + 1
        for row in parsed:
            row["followers"] = follower_counts.get(row["client_id"], 0)
        return parsed

    @staticmethod
    def _row_to_cmd(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "server_seq": int(row["server_seq"]),
            "command_id": row["command_id"],
            "client_id": row["client_id"],
            "client_seq": int(row["client_seq"]),
            "role": row["role"],
            "type": row["type"],
            "payload": json.loads(row["payload"]),
            "causation_id": row["causation_id"],
            "ts_ns": int(row["ts_ns"]),
        }
