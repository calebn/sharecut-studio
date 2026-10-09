"""Backup refusal preserves live SQLite authority and excludes local attackers."""

from __future__ import annotations

import os
import sqlite3
from contextlib import closing
from pathlib import Path

import pytest

from podcast_mcp.edits import share_registry
from test_share_registry import _share_template


def _lookup(owner: share_registry.SqliteShareRegistry, token: str) -> str | None:
    try:
        row = owner.get_active(token)
        return row["id"] if row else None
    except sqlite3.Error as exc:
        return f"{type(exc).__name__}: {exc}"


@pytest.mark.parametrize(
    "target", ["main", "wal", "shm", "journal", "main-hardlink", "wal-hardlink", "shm-hardlink"]
)
def test_backup_refuses_source_namespace_and_aliases_without_splitting_authority(
    tmp_path: Path, target: str
) -> None:
    source = share_registry.SqliteShareRegistry(tmp_path / "owner" / "registry.db")
    fresh = None
    try:
        secret = source.recording_key_secret()
        source.claim_active(_share_template(token="before", id="before-id"))
        suffix = {"main": "", "wal": "-wal", "shm": "-shm", "journal": "-journal"}
        name = target.removesuffix("-hardlink")
        reserved = Path(str(source.db_path) + suffix[name])
        destination = reserved
        if target.endswith("-hardlink"):
            aliases = tmp_path / "aliases"
            aliases.mkdir(mode=0o700)
            destination = aliases / "alias.db"
            os.link(reserved, destination)
        namespace = [
            source.db_path,
            *[Path(str(source.db_path) + s) for s in ("-wal", "-shm", "-journal")],
        ]
        if destination not in namespace:
            namespace.append(destination)
        before = {
            p.name: (p.stat().st_ino, p.read_bytes()) if p.exists() else None for p in namespace
        }
        refusal = None
        try:
            source.backup_to(destination)
        except (OSError, ValueError, RuntimeError) as exc:
            refusal = exc
        after = {
            p.name: (p.stat().st_ino, p.read_bytes()) if p.exists() else None for p in namespace
        }
        old_before = _lookup(source, "before")
        source.claim_active(_share_template(token="future", id="future-id"))
        old_future = _lookup(source, "future")
        source._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        fresh = share_registry.SqliteShareRegistry(source.db_path)
        authority = {
            "old_before": old_before,
            "old_future": old_future,
            "fresh_before": _lookup(fresh, "before"),
            "fresh_future": _lookup(fresh, "future"),
            "fresh_secret": fresh.recording_key_secret(),
        }
        assert authority == {
            "old_before": "before-id",
            "old_future": "future-id",
            "fresh_before": "before-id",
            "fresh_future": "future-id",
            "fresh_secret": secret,
        }
        assert after == before, "refused backup must not write or replace the source namespace"
        assert refusal is not None, f"backup accepted reserved source target {target}"
    finally:
        if fresh:
            fresh.close()
        source.close()


def test_backup_refuses_existing_live_wal_destination_with_its_own_secret(tmp_path: Path) -> None:
    source = share_registry.SqliteShareRegistry(tmp_path / "source" / "registry.db")
    destination = share_registry.SqliteShareRegistry(tmp_path / "destination" / "backup.db")
    fresh = None
    try:
        source_secret = source.recording_key_secret()
        destination_secret = destination.recording_key_secret()
        assert source_secret != destination_secret
        destination.claim_active(_share_template(token="destination-before", id="destination-id"))
        source.claim_active(_share_template(token="source-only", id="source-id"))
        files = [
            destination.db_path,
            Path(str(destination.db_path) + "-wal"),
            Path(str(destination.db_path) + "-shm"),
        ]
        before = [(p.stat().st_ino, p.read_bytes()) for p in files]
        refusal = None
        try:
            source.backup_to(destination.db_path)
        except (OSError, ValueError, RuntimeError) as exc:
            refusal = exc
        after = [(p.stat().st_ino, p.read_bytes()) for p in files]
        assert after == before, "backup changed a live destination's main/WAL/SHM files"
        assert refusal is not None, "an existing destination must be refused"
        assert destination.recording_key_secret() == destination_secret
        assert _lookup(destination, "source-only") is None
        destination.claim_active(_share_template(token="destination-future", id="future-id"))
        fresh = share_registry.SqliteShareRegistry(destination.db_path)
        assert fresh.recording_key_secret() == destination_secret
        assert _lookup(fresh, "destination-before") == "destination-id"
        assert _lookup(fresh, "destination-future") == "future-id"
        assert _lookup(fresh, "source-only") is None
        assert source.recording_key_secret() == source_secret
    finally:
        if fresh:
            fresh.close()
        destination.close()
        source.close()


@pytest.mark.skipif(os.name != "posix", reason="POSIX non-sticky write/rename authority")
def test_backup_refuses_writable_nonsticky_parent_before_attacker_receives_secrets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = share_registry.SqliteShareRegistry(tmp_path / "source" / "registry.db")
    original_connect = sqlite3.connect
    destination_parent = tmp_path / "untrusted"
    destination_parent.mkdir()
    destination_parent.chmod(0o777)
    attacker = destination_parent / "attacker.db"
    with closing(original_connect(attacker, isolation_level=None)) as database:
        database.execute("CREATE TABLE attacker_marker (value TEXT)")
        database.execute("INSERT INTO attacker_marker VALUES ('untouched')")
    attacker.chmod(0o666)
    before = (attacker.stat().st_ino, attacker.read_bytes())

    def attacker_substitution(database: str, *args, **kwargs) -> sqlite3.Connection:
        path = Path(database)
        if path.parent == destination_parent and path.name.startswith(".backup.db."):
            path.unlink()
            path.symlink_to(attacker)
        return original_connect(database, *args, **kwargs)

    try:
        secret = source.recording_key_secret()
        source.claim_active(_share_template(token="host-capability", id="host-id"))
        # The actor takes the entry immediately before SQLite reopens its pathname.
        monkeypatch.setattr(share_registry.sqlite3, "connect", attacker_substitution)
        refusal = None
        try:
            source.backup_to(destination_parent / "backup.db")
        except (OSError, ValueError, RuntimeError) as exc:
            refusal = exc
        with closing(original_connect(attacker)) as observer:
            tables = {
                row[0]
                for row in observer.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            leaked = (
                observer.execute("SELECT secret FROM recording_key_secret").fetchall()
                if "recording_key_secret" in tables
                else []
            )
            assert leaked == [], "attacker database received the host secret"
            assert observer.execute("SELECT value FROM attacker_marker").fetchall() == [
                ("untouched",)
            ]
        assert (attacker.stat().st_ino, attacker.read_bytes()) == before
        assert refusal is not None, "untrusted writable destination parent was accepted"
        assert not (destination_parent / "backup.db").exists()
        assert source.recording_key_secret() == secret
        assert _lookup(source, "host-capability") == "host-id"
    finally:
        source.close()
