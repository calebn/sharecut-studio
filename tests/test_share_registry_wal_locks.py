from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path

import pytest

from podcast_mcp.edits.share_registry import SqliteShareRegistry

pytestmark = pytest.mark.skipif(os.name != "posix", reason="POSIX advisory byte-range locks")

SQLITE_WAL_DMS_OFFSET = 128

_PROBE = """
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDWR)
try:
    fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB, 1, int(sys.argv[2]), 0)
except OSError:
    sys.exit(1)
sys.exit(0)
"""


def _peer_sees_connection_alive(shm: Path) -> bool:
    probe = subprocess.run(
        [sys.executable, "-I", "-c", _PROBE, str(shm), str(SQLITE_WAL_DMS_OFFSET)], check=False
    )
    return probe.returncode == 1


def test_probe_detects_a_live_wal_connection(tmp_path: Path) -> None:
    path = tmp_path / "plain.db"
    with closing(sqlite3.connect(path, isolation_level=None)) as connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("CREATE TABLE t (x)")
        connection.execute("SELECT count(*) FROM t").fetchall()
        assert _peer_sees_connection_alive(Path(f"{path}-shm"))


def test_registry_privacy_checks_leave_sqlite_wal_locks_held(tmp_path: Path) -> None:
    path = tmp_path / "registry.sqlite"
    with closing(SqliteShareRegistry(path)) as registry:
        shm = Path(f"{path}-shm")
        assert _peer_sees_connection_alive(shm), "construction released the WAL lock"
        registry.get_active("absent-token")
        assert _peer_sees_connection_alive(shm), "a read released the WAL lock"
        registry.recording_key_secret()
        assert _peer_sees_connection_alive(shm), "a write released the WAL lock"


def test_loose_sidecar_is_refused_and_a_peer_registrys_locks_stay_held(tmp_path: Path) -> None:
    path = tmp_path / "registry.sqlite"
    shm = Path(f"{path}-shm")
    with closing(SqliteShareRegistry(path)):
        os.chmod(shm, 0o644)
        with pytest.raises(PermissionError, match="private"):
            SqliteShareRegistry(path)
        assert _peer_sees_connection_alive(shm), "refusing a sidecar released the WAL lock"
        assert shm.stat().st_mode & 0o777 == 0o644


def test_loose_main_file_is_refused_not_tightened(tmp_path: Path) -> None:
    path = tmp_path / "registry.sqlite"
    with closing(SqliteShareRegistry(path)):
        os.chmod(path, 0o644)
        with pytest.raises(PermissionError, match="private"):
            SqliteShareRegistry(path)
        assert path.stat().st_mode & 0o777 == 0o644
