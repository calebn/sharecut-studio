"""Share registry: coolname tokens, active + cooldown pools."""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Thread
from unittest.mock import patch

import pytest

from podcast_mcp.edits.review_shares import (
    create_share,
    list_shares,
    list_usable_shares,
    revoke_share,
)
from podcast_mcp.edits.share_registry import (
    RECORD_REVIEW_VERSION_SENTINEL,
    SHARE_COOLDOWN_DAYS,
    SqliteShareRegistry,
    claim_with_mint_retry,
    share_inactive,
    share_is_usable,
    share_last_used_at,
)
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services import ProjectWorkspace, ReviewService, ShareService
from podcast_mcp.services.share import lookup_share
from sqlite_helpers import FailingConnection


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat()


@pytest.fixture
def registry(tmp_path: Path) -> SqliteShareRegistry:
    return SqliteShareRegistry(tmp_path / "share_registry.sqlite")


def _share_template(**extra):
    now = datetime.now(UTC)
    row = {
        "project_workspace": "/tmp/ws",
        "review_version_id": "v1",
        "created_at": _iso(now),
        "last_used_at": _iso(now),
        "capabilities": ["play"],
        "revoked": False,
    }
    row.update(extra)
    return row


def test_claim_with_mint_retry_slug_shape(registry: SqliteShareRegistry):
    token = claim_with_mint_retry(_share_template(), registry=registry)["token"]
    assert token == token.lower()
    assert "-" in token
    assert token.replace("-", "").isalpha()
    assert " " not in token


def test_claim_with_mint_retry_skips_active_and_cooldown(registry: SqliteShareRegistry):
    now = datetime.now(UTC)
    reserved = ["alpha-beta-gamma", "delta-epsilon-zeta", "fresh-unique-slug"]
    registry.claim_active(
        {
            "token": reserved[0],
            "project_workspace": "/tmp/ws",
            "review_version_id": "v1",
            "created_at": _iso(now),
            "last_used_at": _iso(now),
            "capabilities": ["play"],
        }
    )
    registry.demote_to_cooldown(reserved[0], reason="revoked", now=now)
    registry.claim_active(
        {
            "token": reserved[1],
            "project_workspace": "/tmp/ws",
            "review_version_id": "v1",
            "created_at": _iso(now),
            "last_used_at": _iso(now),
            "capabilities": ["play"],
        }
    )

    seq = iter(reserved)

    def _fake_slug(_n: int = 3) -> str:
        return next(seq)

    with patch("podcast_mcp.edits.share_registry.generate_slug", side_effect=_fake_slug):
        token = claim_with_mint_retry(_share_template(), registry=registry, max_attempts=8)["token"]
    assert token == "fresh-unique-slug"
    assert registry.get_active("fresh-unique-slug") is not None


def test_cooldown_blocks_remint_until_reserved_until(registry: SqliteShareRegistry):
    now = datetime.now(UTC)
    token = "cool-down-slug"
    registry.claim_active(
        {
            "token": token,
            "project_workspace": "/tmp/ws",
            "review_version_id": "v1",
            "created_at": _iso(now),
            "last_used_at": _iso(now),
            "capabilities": [],
        }
    )
    registry.demote_to_cooldown(token, reason="revoked", now=now)
    assert registry.is_reserved(token, now=now)
    assert registry.get_active(token) is None

    with pytest.raises(ValueError, match="reserved"):
        registry.claim_active(
            {
                "token": token,
                "project_workspace": "/tmp/ws",
                "review_version_id": "v2",
                "created_at": _iso(now),
                "last_used_at": _iso(now),
                "capabilities": [],
            }
        )

    after = now + timedelta(days=SHARE_COOLDOWN_DAYS, seconds=1)
    assert not registry.is_reserved(token, now=after)
    registry.claim_active(
        {
            "token": token,
            "project_workspace": "/tmp/ws",
            "review_version_id": "v2",
            "created_at": _iso(after),
            "last_used_at": _iso(after),
            "capabilities": [],
        }
    )
    assert registry.get_active(token) is not None


def test_touch_last_used_throttled(registry: SqliteShareRegistry):
    now = datetime.now(UTC)
    token = "touch-me-please"
    registry.claim_active(
        {
            "token": token,
            "project_workspace": "/tmp/ws",
            "review_version_id": "v1",
            "created_at": _iso(now),
            "last_used_at": _iso(now),
            "capabilities": [],
        }
    )
    assert registry.touch_last_used(token, now=now + timedelta(minutes=30)) is None
    ts = registry.touch_last_used(token, now=now + timedelta(hours=2))
    assert ts is not None
    row = registry.get_active(token)
    assert row is not None
    assert row["last_used_at"] == ts


_LEGACY_ACTIVE_SCHEMA = """
CREATE TABLE IF NOT EXISTS active_shares (
  token TEXT PRIMARY KEY,
  project_workspace TEXT NOT NULL,
  review_version_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at TEXT,
  capabilities TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cooldown_shares (
  token TEXT PRIMARY KEY,
  last_used_at TEXT NOT NULL,
  reserved_until TEXT NOT NULL,
  reason TEXT NOT NULL,
  project_workspace TEXT
);
"""


def test_registry_migrates_legacy_db_adds_kind_columns(tmp_path: Path):
    import sqlite3

    path = tmp_path / "legacy.sqlite"
    conn = sqlite3.connect(str(path))
    conn.executescript(_LEGACY_ACTIVE_SCHEMA)
    conn.execute(
        """
        INSERT INTO active_shares (
          token, project_workspace, review_version_id,
          created_at, last_used_at, expires_at, capabilities
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "old-style-token",
            "/tmp/ws",
            "v1",
            _iso(datetime.now(UTC)),
            _iso(datetime.now(UTC)),
            None,
            "[]",
        ),
    )
    conn.commit()
    conn.close()

    registry = SqliteShareRegistry(path)
    row = registry.get_active("old-style-token")
    assert row is not None
    assert row["kind"] == "review"
    assert row["role"] is None
    assert row["session_id"] is None
    registry.close()


def test_claim_active_record_kind_round_trip(registry: SqliteShareRegistry):
    now = datetime.now(UTC)
    token = "record-guest-slug"
    registry.claim_active(
        {
            "token": token,
            "project_workspace": "/tmp/ws",
            "review_version_id": RECORD_REVIEW_VERSION_SENTINEL,
            "created_at": _iso(now),
            "last_used_at": _iso(now),
            "capabilities": ["join", "monitor", "comment"],
            "kind": "record",
            "role": "guest",
            "session_id": "abc",
        }
    )
    row = registry.get_active(token)
    assert row is not None
    assert row["kind"] == "record"
    assert row["role"] == "guest"
    assert row["session_id"] == "abc"
    assert row["review_version_id"] == ""
    assert row["capabilities"] == ["join", "monitor", "comment"]


def test_claim_active_rejects_unknown_kind(registry: SqliteShareRegistry):
    now = datetime.now(UTC)
    with pytest.raises(ValueError, match="unknown share kind"):
        registry.claim_active(
            {
                "token": "bad-kind-slug",
                "project_workspace": "/tmp/ws",
                "review_version_id": "v1",
                "created_at": _iso(now),
                "last_used_at": _iso(now),
                "capabilities": [],
                "kind": "studio",
            }
        )


def test_upsert_active_metadata_updates_kind_fields(registry: SqliteShareRegistry):
    now = datetime.now(UTC)
    token = "upsert-kind-slug"
    registry.claim_active(
        {
            "token": token,
            "project_workspace": "/tmp/ws",
            "review_version_id": "v1",
            "created_at": _iso(now),
            "last_used_at": _iso(now),
            "capabilities": ["play"],
        }
    )
    registry.upsert_active_metadata(
        {
            "token": token,
            "project_workspace": "/tmp/ws2",
            "review_version_id": RECORD_REVIEW_VERSION_SENTINEL,
            "expires_at": None,
            "capabilities": ["monitor", "comment"],
            "kind": "record",
            "role": "producer",
            "session_id": "room1",
        }
    )
    row = registry.get_active(token)
    assert row is not None
    assert row["kind"] == "record"
    assert row["role"] == "producer"
    assert row["session_id"] == "room1"
    assert row["project_workspace"] == "/tmp/ws2"
    assert row["capabilities"] == ["monitor", "comment"]


def test_share_is_usable_inactive_and_expired():
    now = datetime.now(UTC)
    base = {
        "token": "x",
        "created_at": _iso(now - timedelta(days=400)),
        "last_used_at": _iso(now - timedelta(days=400)),
        "revoked": False,
        "expires_at": None,
    }
    assert not share_is_usable(base, now=now)
    fresh = {
        **base,
        "created_at": _iso(now),
        "last_used_at": _iso(now),
        "expires_at": _iso(now - timedelta(seconds=1)),
    }
    assert not share_is_usable(fresh, now=now)
    ok = {
        **base,
        "created_at": _iso(now),
        "last_used_at": _iso(now),
        "expires_at": None,
    }
    assert share_is_usable(ok, now=now)


def test_share_last_used_falls_back_to_created_at_when_missing():
    now = datetime(2026, 1, 1, tzinfo=UTC)
    created = now - timedelta(days=400)
    row = {"token": "x", "created_at": _iso(created), "revoked": False}
    assert share_last_used_at(row) == created
    # Caller's clock decides inactivity (not wall-clock now).
    assert share_inactive(row, now=now)
    assert not share_is_usable(row, now=now)
    assert share_is_usable(row, now=created + timedelta(days=1))


def test_share_last_used_malformed_falls_back_to_created_at():
    now = datetime(2026, 1, 1, tzinfo=UTC)
    created = now - timedelta(days=2)
    row = {"token": "x", "created_at": _iso(created), "last_used_at": "not-a-date"}
    assert share_last_used_at(row) == created
    assert not share_inactive(row, now=now)
    assert share_is_usable(row, now=now)


def test_share_last_used_fails_closed_without_timestamps():
    now = datetime(2026, 1, 1, tzinfo=UTC)
    for row in (
        {"token": "x"},
        {"token": "x", "created_at": "garbage", "last_used_at": ""},
    ):
        assert share_last_used_at(row) == datetime.min.replace(tzinfo=UTC)
        assert share_inactive(row, now=now)
        assert not share_is_usable(row, now=now)
        assert not share_is_usable(row)


def _seed_premix(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def test_create_share_coolname_and_lookup_touch(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="Slug")
    share = ShareService(ws).create(review_version_id=ver["id"])
    token = share["token"]
    assert token == token.lower()
    assert "-" in token
    assert token.replace("-", "").isalpha()
    assert share.get("last_used_at")

    row = lookup_share(token)
    assert row["token"] == token
    assert list_usable_shares(ws.project)

    revoke_share(ws.project, token)
    with pytest.raises(KeyError):
        lookup_share(token)
    assert list_usable_shares(ws.project) == []


def test_create_share_sidecar_serializes(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="Lock")
    errors: list[BaseException] = []

    def worker() -> None:
        try:
            create_share(ws.project, review_version_id=ver["id"])
        except BaseException as exc:
            errors.append(exc)

    threads = [Thread(target=worker) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == []
    assert len(list_shares(ws.project)) == 8


def test_lookup_demotes_hard_expired(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="Exp")
    past = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    row = create_share(
        ws.project,
        review_version_id=ver["id"],
        expires_at=past,
    )
    with pytest.raises(KeyError):
        lookup_share(row["token"])
    from podcast_mcp.edits.share_registry import get_share_registry

    assert get_share_registry().get_active(row["token"]) is None
    assert get_share_registry().is_reserved(row["token"])


def test_override_path_used_verbatim(monkeypatch, tmp_path: Path):
    from podcast_mcp.edits import share_registry as sr

    override = tmp_path / "idx.json"
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(override))
    sr.reset_share_registry_for_tests()
    expected = override.resolve()
    # No .json -> .sqlite rewrite anywhere: env default and explicit path agree.
    assert sr.default_share_registry_db_path() == expected
    explicit = sr.get_share_registry(override)
    assert explicit.db_path == expected
    # Same path as the default -> the process singleton, not a second connection.
    assert explicit is sr.get_share_registry()
    assert expected.is_file()
    assert not expected.with_suffix(".sqlite").exists()


def test_json_override_revoke_is_seen_by_lookup(
    minimal_project, sample_wav, tmp_path: Path, monkeypatch
):
    """Regression: revoke and resolve must hit the same file for a *.json override."""
    from podcast_mcp.edits.share_registry import reset_share_registry_for_tests

    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(tmp_path / "shares.json"))
    reset_share_registry_for_tests()
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="JsonPin")
    token = ShareService(ws).create(review_version_id=ver["id"])["token"]
    assert lookup_share(token)["token"] == token
    ShareService(ws).revoke(token)
    with pytest.raises(KeyError):
        lookup_share(token)


def test_explicit_non_default_path_is_separate_registry(tmp_path: Path):
    from podcast_mcp.edits import share_registry as sr

    other = sr.get_share_registry(tmp_path / "other.sqlite")
    try:
        assert other is not sr.get_share_registry()
        assert other.db_path == (tmp_path / "other.sqlite").resolve()
    finally:
        other.close()


def test_chmod_oserror_ignored(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(
        "podcast_mcp.edits.share_registry.os.chmod",
        lambda *_a, **_k: (_ for _ in ()).throw(OSError("nope")),
    )
    reg = SqliteShareRegistry(tmp_path / "chmod.sqlite")
    assert reg.get_active("x") is None
    reg.close()


def test_claim_integrity_error(registry: SqliteShareRegistry):
    now = datetime.now(UTC)
    row = {
        "token": "dup-token-slug",
        "project_workspace": "/tmp/ws",
        "review_version_id": "v1",
        "created_at": _iso(now),
        "last_used_at": _iso(now),
        "capabilities": [],
    }
    registry.claim_active(row)

    def _not_reserved(token, *, now=None):
        return False

    registry.is_reserved = _not_reserved  # type: ignore[method-assign]
    with pytest.raises(ValueError, match="reserved"):
        registry.claim_active(row)


def test_upsert_empty_token_and_demote_missing(registry: SqliteShareRegistry):
    registry.upsert_active_metadata({"token": ""})
    assert registry.demote_to_cooldown("missing", reason="x") is False


def test_bad_capabilities_json(registry: SqliteShareRegistry):
    now = datetime.now(UTC)
    token = "bad-caps-slug"
    registry.claim_active(
        {
            "token": token,
            "project_workspace": "/tmp/ws",
            "review_version_id": "v1",
            "created_at": _iso(now),
            "last_used_at": _iso(now),
            "capabilities": ["play"],
        }
    )
    with registry._lock:
        registry._conn.execute(
            "UPDATE active_shares SET capabilities = ? WHERE token = ?",
            ("{not-json", token),
        )
    row = registry.get_active(token)
    assert row is not None
    assert row["capabilities"] == []


def test_generate_token_exhausted(registry: SqliteShareRegistry):
    with patch(
        "podcast_mcp.edits.share_registry.generate_slug",
        return_value="always-taken-slug",
    ):
        registry.claim_active(
            {
                "token": "always-taken-slug",
                "project_workspace": "/tmp/ws",
                "review_version_id": "v1",
                "created_at": _iso(datetime.now(UTC)),
                "last_used_at": _iso(datetime.now(UTC)),
                "capabilities": [],
            }
        )
        with pytest.raises(RuntimeError, match="could not allocate"):
            claim_with_mint_retry(_share_template(), registry=registry, max_attempts=3)


def test_reset_singleton(monkeypatch, tmp_path: Path):
    from podcast_mcp.edits import share_registry as sr

    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(tmp_path / "a.sqlite"))
    a = sr.get_share_registry()
    sr.reset_share_registry_for_tests()
    assert sr._registry_singleton is None
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(tmp_path / "b.sqlite"))
    b = sr.get_share_registry()
    assert a.db_path != b.db_path
    b.close()


def test_create_share_save_failure_releases(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from podcast_mcp.edits import review_shares as rs
    from podcast_mcp.edits.share_registry import get_share_registry

    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="FailSave")

    claimed: list[str] = []
    real_claim = get_share_registry().claim_active

    def _track_claim(share):
        claimed.append(str(share["token"]))
        return real_claim(share)

    monkeypatch.setattr(get_share_registry(), "claim_active", _track_claim)

    def _boom(*_a, **_k):
        raise OSError("disk full")

    monkeypatch.setattr(rs, "_save", _boom)
    with pytest.raises(OSError, match="disk full"):
        create_share(ws.project, review_version_id=ver["id"])
    assert claimed
    reg = get_share_registry()
    assert not reg.is_reserved(claimed[0])
    assert reg.get_active(claimed[0]) is None


def test_wal_journal_mode(registry: SqliteShareRegistry):
    import sqlite3

    conn = sqlite3.connect(registry.db_path)
    try:
        assert str(conn.execute("PRAGMA journal_mode").fetchone()[0]).lower() == "wal"
    finally:
        conn.close()


def test_second_connection_claim_raises(tmp_path: Path):
    path = tmp_path / "multi.sqlite"
    a = SqliteShareRegistry(path)
    b = SqliteShareRegistry(path)
    now = datetime.now(UTC)
    row = {
        "token": "shared-slug-token",
        "project_workspace": "/tmp/ws",
        "review_version_id": "v1",
        "created_at": _iso(now),
        "last_used_at": _iso(now),
        "capabilities": [],
    }
    a.claim_active(row)
    with pytest.raises(ValueError, match="reserved"):
        b.claim_active(row)
    a.close()
    b.close()


def test_demote_leaves_cooldown_not_active(registry: SqliteShareRegistry):
    now = datetime.now(UTC)
    token = "demote-tx-slug"
    registry.claim_active(
        {
            "token": token,
            "project_workspace": "/tmp/ws",
            "review_version_id": "v1",
            "created_at": _iso(now),
            "last_used_at": _iso(now),
            "capabilities": [],
        }
    )
    assert registry.demote_to_cooldown(token, reason="revoked", now=now) is True
    assert registry.get_active(token) is None
    assert registry.is_reserved(token, now=now)


def test_claim_with_mint_retry_on_collision(registry: SqliteShareRegistry):
    from podcast_mcp.edits.share_registry import claim_with_mint_retry

    now = datetime.now(UTC)
    registry.claim_active(
        {
            "token": "first-taken-slug",
            "project_workspace": "/tmp/ws",
            "review_version_id": "v1",
            "created_at": _iso(now),
            "last_used_at": _iso(now),
            "capabilities": [],
        }
    )
    seq = iter(["first-taken-slug", "second-free-slug"])

    def _fake_slug(_n: int = 3) -> str:
        return next(seq)

    with patch("podcast_mcp.edits.share_registry.generate_slug", side_effect=_fake_slug):
        row = claim_with_mint_retry(
            {
                "project_workspace": "/tmp/ws",
                "review_version_id": "v2",
                "created_at": _iso(now),
                "last_used_at": _iso(now),
                "capabilities": ["play"],
                "revoked": False,
            },
            registry=registry,
            max_attempts=4,
        )
    assert row["token"] == "second-free-slug"
    assert registry.get_active("second-free-slug") is not None


def test_backup_share_registry(registry: SqliteShareRegistry, tmp_path: Path):
    from podcast_mcp.edits.share_registry import backup_share_registry

    now = datetime.now(UTC)
    registry.claim_active(
        {
            "token": "backup-me-slug",
            "project_workspace": "/tmp/ws",
            "review_version_id": "v1",
            "created_at": _iso(now),
            "last_used_at": _iso(now),
            "capabilities": ["play"],
        }
    )
    dest = tmp_path / "copies" / "reg.bak.sqlite"
    out = backup_share_registry(dest, registry=registry)
    assert out == dest.resolve()
    assert dest.is_file()
    restored = SqliteShareRegistry(dest)
    assert restored.get_active("backup-me-slug") is not None
    restored.close()


def test_release_claim(registry: SqliteShareRegistry):
    now = datetime.now(UTC)
    token = "release-me-slug"
    registry.claim_active(
        {
            "token": token,
            "project_workspace": "/tmp/ws",
            "review_version_id": "v1",
            "created_at": _iso(now),
            "last_used_at": _iso(now),
            "capabilities": [],
        }
    )
    assert registry.release_claim(token) is True
    assert not registry.is_reserved(token)
    assert registry.release_claim(token) is False


def test_touch_share_and_register_paths(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    from podcast_mcp.edits.review_shares import (
        register_share_globally,
        resolve_share,
        touch_share_last_used,
    )

    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="Touch")
    row = create_share(ws.project, review_version_id=ver["id"])
    from podcast_mcp.edits.share_registry import get_share_registry

    # Age last_used so the next touch_share_last_used writes the sidecar.
    aged = _iso(datetime.now(UTC) - timedelta(hours=2))
    get_share_registry()._conn.execute(
        "UPDATE active_shares SET last_used_at = ? WHERE token = ?",
        (aged, row["token"]),
    )
    ts = touch_share_last_used(ws.project, row["token"])
    assert ts is not None
    # Throttled immediately after
    assert touch_share_last_used(ws.project, row["token"]) is None

    reg_path = get_share_registry().db_path
    register_share_globally({}, registry_path=reg_path)
    register_share_globally({**row, "revoked": True}, registry_path=reg_path)
    assert resolve_share(row["token"], registry_path=reg_path) is None

    # Claim via register when absent from active (not reserved)
    orphan = {
        "token": "orphan-register-slug",
        "project_workspace": str(ws.project.workspace_dir),
        "review_version_id": ver["id"],
        "created_at": _iso(datetime.now(UTC)),
        "last_used_at": _iso(datetime.now(UTC)),
        "capabilities": ["play"],
        "revoked": False,
    }
    register_share_globally(orphan, registry_path=reg_path)
    assert resolve_share("orphan-register-slug", registry_path=reg_path) is not None

    # Fresh create + upsert metadata path
    row2 = create_share(ws.project, review_version_id=ver["id"])
    register_share_globally(
        {**row2, "last_used_at": _iso(datetime.now(UTC))},
        registry_path=reg_path,
    )
    assert resolve_share(row2["token"], registry_path=reg_path) is not None


def test_resolve_share_exception(monkeypatch, tmp_path: Path):
    from podcast_mcp.edits.review_shares import resolve_share

    def _boom(_path=None):
        raise RuntimeError("db dead")

    monkeypatch.setattr("podcast_mcp.edits.review_shares.get_share_registry", _boom)
    assert resolve_share("x", registry_path=tmp_path / "x.sqlite") is None


def test_lookup_inactive_and_missing_workspace(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from podcast_mcp.edits.share_registry import get_share_registry
    from podcast_mcp.services.share import _mark_share_revoked

    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="Inact")
    row = create_share(ws.project, review_version_id=ver["id"])
    old = _iso(datetime.now(UTC) - timedelta(days=400))
    get_share_registry()._conn.execute(
        "UPDATE active_shares SET last_used_at = ?, created_at = ? WHERE token = ?",
        (old, old, row["token"]),
    )
    with pytest.raises(KeyError):
        lookup_share(row["token"])

    # Remint + lookup when workspace path missing → touch without ProjectWorkspace
    row3 = create_share(ws.project, review_version_id=ver["id"])
    get_share_registry()._conn.execute(
        "UPDATE active_shares SET project_workspace = ? WHERE token = ?",
        (str(tmp_workspace / "no-such-ws"), row3["token"]),
    )
    looked = lookup_share(row3["token"])
    assert looked["token"] == row3["token"]

    # _mark without workspace
    _mark_share_revoked(row3["token"], ws=None)
    with pytest.raises(KeyError):
        lookup_share(row3["token"])


def test_touch_missing_token_and_bad_last_used(registry: SqliteShareRegistry):
    assert registry.touch_last_used("nope") is None
    now = datetime.now(UTC)
    token = "bad-last-used"
    registry.claim_active(
        {
            "token": token,
            "project_workspace": "/tmp/ws",
            "review_version_id": "v1",
            "created_at": _iso(now),
            "last_used_at": "not-a-date",
            "capabilities": [],
        }
    )
    assert registry.demote_to_cooldown(token, reason="bad_ts", now=now) is True


def test_lookup_touch_exception_fallback(minimal_project, sample_wav, tmp_workspace, monkeypatch):

    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="TouchFail")
    share = ShareService(ws).create(review_version_id=ver["id"])

    def _boom(*_a, **_k):
        raise RuntimeError("touch boom")

    monkeypatch.setattr("podcast_mcp.services.share.touch_share_last_used", _boom)
    # Age so registry touch path in lookup still runs after exception
    from podcast_mcp.edits.share_registry import get_share_registry

    aged = _iso(datetime.now(UTC) - timedelta(hours=2))
    get_share_registry()._conn.execute(
        "UPDATE active_shares SET last_used_at = ? WHERE token = ?",
        (aged, share["token"]),
    )
    row = lookup_share(share["token"])
    assert row["token"] == share["token"]


def test_share_is_usable_revoked():
    now = datetime.now(UTC)
    assert not share_is_usable(
        {
            "revoked": True,
            "created_at": _iso(now),
            "last_used_at": _iso(now),
        },
        now=now,
    )


def test_sanitize_guest_view():
    from podcast_mcp.services.share import sanitize_guest_project_view

    view = sanitize_guest_project_view(
        {
            "project_path": "/secret",
            "meta": {"name": "Ep", "workspace_dir": "/ws"},
            "tracks": [
                "skip",
                {
                    "id": "h",
                    "media_path": "/raw.wav",
                    "proxy": {
                        "object_store_prefix": "p",
                        "object_store_uploaded_at": "t",
                        "hash": "h",
                    },
                },
            ],
            "transcript": {
                "utterances": [
                    "skip",
                    {"text": "hi", "words": [{"w": 1}]},
                ]
            },
            "render_status": {
                "tracks": {
                    "h": {"stem_path": "/s", "path": "/p", "ok": True},
                    "x": "raw",
                },
                "premix": {"path": "/premix.wav", "ok": True},
            },
        }
    )
    assert view["project_path"] == ""
    assert view["meta"] == {"name": "Ep", "hydration": {"transcript_words": False}}
    assert view["tracks"][0]["media_path"] is None
    assert "object_store_prefix" not in view["tracks"][0]["proxy"]
    assert "words" not in view["transcript"]["utterances"][0]
    assert "stem_path" not in view["render_status"]["tracks"]["h"]
    assert "path" not in view["render_status"]["premix"]


def test_revoke_object_store_cleanup_warning(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):

    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.load_object_store_config",
        lambda config_path=None: None,
    )
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="object storageWarn")
    share = ShareService(ws).create(review_version_id=ver["id"])

    def _boom(*_a, **_k):
        raise RuntimeError("object_store cleanup boom")

    monkeypatch.setattr("podcast_mcp.services.share.delete_object_store_object_if_unused", _boom)
    monkeypatch.setattr("podcast_mcp.services.proxy_media.delete_all_proxies_if_unused", _boom)
    out = ShareService(ws).revoke(share["token"])
    assert out["revoked"] is True


def test_failed_commit_rolls_back_release_claim(registry: SqliteShareRegistry):
    now = datetime.now(UTC)
    registry.claim_active(
        {
            "token": "commit-fail-token",
            "project_workspace": "/tmp/ws",
            "review_version_id": "v1",
            "created_at": _iso(now),
            "last_used_at": _iso(now),
            "capabilities": ["play"],
        }
    )
    real = registry._conn
    registry._conn = FailingConnection(real, "COMMIT")  # type: ignore[assignment]
    try:
        with pytest.raises(sqlite3.OperationalError):
            registry.release_claim("commit-fail-token")
    finally:
        registry._conn = real
    assert not real.in_transaction
    assert registry.get_active("commit-fail-token") is not None
    assert registry.release_claim("commit-fail-token") is True
