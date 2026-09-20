"""Sqlite store for share identity (users, ACL, sessions, magic links, passkeys)."""

from __future__ import annotations

import contextlib
import hashlib
import os
import sqlite3
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from podcast_mcp.services.share_auth.passwords import hash_password, verify_password

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  display_name TEXT,
  password_hash TEXT,
  google_sub TEXT,
  github_sub TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(email)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub
  ON users(google_sub) WHERE google_sub IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_sub
  ON users(github_sub) WHERE github_sub IS NOT NULL;

CREATE TABLE IF NOT EXISTS share_acl (
  share_token TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  invited_email TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (share_token, user_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_share_acl_token ON share_acl(share_token);
CREATE INDEX IF NOT EXISTS idx_share_acl_email ON share_acl(invited_email);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS magic_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  share_token TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_credentials (
  token_hash TEXT PRIMARY KEY,
  share_token TEXT NOT NULL,
  user_id TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_agent_share ON agent_credentials(share_token);

CREATE TABLE IF NOT EXISTS passkeys (
  credential_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  public_key_b64 TEXT NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge TEXT PRIMARY KEY,
  user_id TEXT,
  purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
"""


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat()


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def default_identity_db_path() -> Path:
    override = os.environ.get("PODCAST_SHARE_IDENTITY", "").strip()
    if override:
        return Path(override).expanduser()
    return Path.home() / ".podcast_mcp" / "share_identity.sqlite"


class ShareIdentityStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or default_identity_db_path()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with contextlib.suppress(OSError):  # pragma: no cover - platform may refuse chmod
            self.path.parent.chmod(0o700)
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._conn.executescript(_SCHEMA)
        self._conn.commit()
        with contextlib.suppress(OSError):  # pragma: no cover - platform may refuse chmod
            self.path.chmod(0o600)

    def close(self) -> None:
        self._conn.close()

    def _user_row(self, row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        return {
            "id": row["id"],
            "email": row["email"],
            "email_verified": bool(row["email_verified"]),
            "display_name": row["display_name"],
            "has_password": bool(row["password_hash"]),
            "google_sub": row["google_sub"],
            "github_sub": row["github_sub"],
            "created_at": row["created_at"],
        }

    def get_user(self, user_id: str) -> dict[str, Any] | None:
        cur = self._conn.execute("SELECT * FROM users WHERE id = ?", (user_id,))
        return self._user_row(cur.fetchone())

    def get_user_by_email(self, email: str) -> dict[str, Any] | None:
        cur = self._conn.execute(
            "SELECT * FROM users WHERE email = ? COLLATE NOCASE",
            (email.strip().lower(),),
        )
        return self._user_row(cur.fetchone())

    def upsert_user_from_oidc(
        self,
        *,
        provider: str,
        subject: str,
        email: str,
        email_verified: bool = True,
        display_name: str | None = None,
    ) -> dict[str, Any]:
        """Merge by verified email; attach Google/GitHub subject to one users row."""
        email_n = email.strip().lower()
        if not email_n:
            raise ValueError("email required")
        if provider not in {"google", "github"}:
            raise ValueError(f"unsupported provider {provider!r}")
        # Column names are fixed per provider (never user input).
        if provider == "google":
            select_by_sub = "SELECT * FROM users WHERE google_sub = ?"
            update_sub = (
                "UPDATE users SET google_sub = ?, email_verified = 1, "
                "display_name = COALESCE(?, display_name) WHERE id = ?"
            )
            insert_user = (
                "INSERT INTO users (id, email, email_verified, display_name, "
                "google_sub, created_at) VALUES (?, ?, ?, ?, ?, ?)"
            )
        else:
            select_by_sub = "SELECT * FROM users WHERE github_sub = ?"
            update_sub = (
                "UPDATE users SET github_sub = ?, email_verified = 1, "
                "display_name = COALESCE(?, display_name) WHERE id = ?"
            )
            insert_user = (
                "INSERT INTO users (id, email, email_verified, display_name, "
                "github_sub, created_at) VALUES (?, ?, ?, ?, ?, ?)"
            )
        cur = self._conn.execute(select_by_sub, (subject,))
        by_sub = cur.fetchone()
        by_email = None
        if email_verified:
            by_email_row = self._conn.execute(
                "SELECT * FROM users WHERE email = ? COLLATE NOCASE", (email_n,)
            ).fetchone()
            by_email = by_email_row

        now = _iso(_now())
        if by_sub is not None:
            uid = by_sub["id"]
            self._conn.execute(
                "UPDATE users SET email = ?, email_verified = ?, display_name = COALESCE(?, display_name) WHERE id = ?",
                (email_n, 1 if email_verified else by_sub["email_verified"], display_name, uid),
            )
        elif by_email is not None and email_verified:
            uid = by_email["id"]
            self._conn.execute(
                update_sub,
                (subject, display_name, uid),
            )
        else:
            uid = uuid.uuid4().hex
            self._conn.execute(
                insert_user,
                (uid, email_n, 1 if email_verified else 0, display_name, subject, now),
            )
        self._conn.commit()
        user = self.get_user(uid)
        assert user is not None
        return user

    def create_or_get_email_user(
        self,
        email: str,
        *,
        password: str | None = None,
        email_verified: bool = False,
        display_name: str | None = None,
    ) -> dict[str, Any]:
        email_n = email.strip().lower()
        existing = self.get_user_by_email(email_n)
        if existing:
            if password:
                self.set_password(existing["id"], password)
                refreshed = self.get_user(existing["id"])
                assert refreshed is not None
                return refreshed
            return existing
        uid = uuid.uuid4().hex
        pw = hash_password(password) if password else None
        self._conn.execute(
            "INSERT INTO users (id, email, email_verified, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (uid, email_n, 1 if email_verified else 0, display_name, pw, _iso(_now())),
        )
        self._conn.commit()
        user = self.get_user(uid)
        assert user is not None
        return user

    def set_password(self, user_id: str, password: str) -> None:
        self._conn.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (hash_password(password), user_id),
        )
        self._conn.commit()

    def verify_email_password(self, email: str, password: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM users WHERE email = ? COLLATE NOCASE",
            (email.strip().lower(),),
        ).fetchone()
        if row is None or not row["password_hash"]:
            return None
        if not verify_password(password, row["password_hash"]):
            return None
        return self._user_row(row)

    def mark_email_verified(self, user_id: str) -> None:
        self._conn.execute("UPDATE users SET email_verified = 1 WHERE id = ?", (user_id,))
        self._conn.commit()

    def invite_to_share(
        self,
        share_token: str,
        *,
        email: str,
        role: str = "commenter",
    ) -> dict[str, Any]:
        email_n = email.strip().lower()
        user = self.create_or_get_email_user(email_n)
        now = _iso(_now())
        self._conn.execute(
            """
            INSERT INTO share_acl (share_token, user_id, role, invited_email, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(share_token, user_id) DO UPDATE SET role = excluded.role
            """,
            (share_token, user["id"], role.strip().lower(), email_n, now),
        )
        self._conn.commit()
        return {
            "share_token": share_token,
            "user_id": user["id"],
            "email": email_n,
            "role": role.strip().lower(),
        }

    def revoke_acl(
        self, share_token: str, *, email: str | None = None, user_id: str | None = None
    ) -> bool:
        if user_id:
            cur = self._conn.execute(
                "DELETE FROM share_acl WHERE share_token = ? AND user_id = ?",
                (share_token, user_id),
            )
        elif email:
            cur = self._conn.execute(
                "DELETE FROM share_acl WHERE share_token = ? AND invited_email = ? COLLATE NOCASE",
                (share_token, email.strip().lower()),
            )
        else:
            raise ValueError("email or user_id required")
        self._conn.commit()
        return cur.rowcount > 0

    def acl_allows(self, share_token: str, user_id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM share_acl WHERE share_token = ? AND user_id = ?",
            (share_token, user_id),
        ).fetchone()
        return dict(row) if row else None

    def create_session(self, user_id: str, *, ttl_hours: int = 24 * 14) -> str:
        raw = secrets_token()
        expires = _now() + timedelta(hours=ttl_hours)
        self._conn.execute(
            "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
            (_hash_token(raw), user_id, _iso(expires), _iso(_now())),
        )
        self._conn.commit()
        return raw

    def resolve_session(self, raw_token: str | None) -> dict[str, Any] | None:
        if not raw_token:
            return None
        row = self._conn.execute(
            "SELECT user_id, expires_at FROM sessions WHERE token_hash = ?",
            (_hash_token(raw_token),),
        ).fetchone()
        if row is None:
            return None
        if _parse_iso(row["expires_at"]) < _now():
            self._conn.execute(
                "DELETE FROM sessions WHERE token_hash = ?", (_hash_token(raw_token),)
            )
            self._conn.commit()
            return None
        return self.get_user(row["user_id"])

    def revoke_session(self, raw_token: str) -> None:
        self._conn.execute("DELETE FROM sessions WHERE token_hash = ?", (_hash_token(raw_token),))
        self._conn.commit()

    def create_magic_link(
        self, email: str, *, share_token: str | None = None, ttl_minutes: int = 30
    ) -> str:
        raw = secrets_token()
        expires = _now() + timedelta(minutes=ttl_minutes)
        self._conn.execute(
            "INSERT INTO magic_links (token_hash, email, share_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
            (
                _hash_token(raw),
                email.strip().lower(),
                share_token,
                _iso(expires),
                _iso(_now()),
            ),
        )
        self._conn.commit()
        return raw

    def consume_magic_link(self, raw_token: str) -> dict[str, Any] | None:
        th = _hash_token(raw_token)
        row = self._conn.execute("SELECT * FROM magic_links WHERE token_hash = ?", (th,)).fetchone()
        if row is None:
            return None
        self._conn.execute("DELETE FROM magic_links WHERE token_hash = ?", (th,))
        self._conn.commit()
        if _parse_iso(row["expires_at"]) < _now():
            return None
        user = self.create_or_get_email_user(row["email"], email_verified=True)
        self.mark_email_verified(user["id"])
        return {
            "user": self.get_user(user["id"]),
            "share_token": row["share_token"],
        }

    def mint_agent_credential(
        self,
        share_token: str,
        user_id: str,
        *,
        ttl_hours: int | None = 24 * 30,
    ) -> str:
        raw = "pmcp_agent_" + secrets_token()
        expires = None if ttl_hours is None else _iso(_now() + timedelta(hours=ttl_hours))
        self._conn.execute(
            "INSERT INTO agent_credentials (token_hash, share_token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
            (_hash_token(raw), share_token, user_id, expires, _iso(_now())),
        )
        self._conn.commit()
        return raw

    def resolve_agent_credential(self, raw_token: str | None) -> dict[str, Any] | None:
        if not raw_token or not raw_token.startswith("pmcp_agent_"):
            return None
        row = self._conn.execute(
            "SELECT * FROM agent_credentials WHERE token_hash = ?",
            (_hash_token(raw_token),),
        ).fetchone()
        if row is None:
            return None
        if row["expires_at"] and _parse_iso(row["expires_at"]) < _now():
            return None
        user = self.get_user(row["user_id"])
        if user is None:  # pragma: no cover - orphaned agent row
            return None
        return {
            "share_token": row["share_token"],
            "user": user,
        }

    def store_passkey(
        self,
        *,
        user_id: str,
        credential_id: str,
        public_key_b64: str,
        sign_count: int = 0,
        transports: str | None = None,
    ) -> None:
        self._conn.execute(
            """
            INSERT INTO passkeys (credential_id, user_id, public_key_b64, sign_count, transports, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(credential_id) DO UPDATE SET
              public_key_b64 = excluded.public_key_b64,
              sign_count = excluded.sign_count
            """,
            (credential_id, user_id, public_key_b64, sign_count, transports, _iso(_now())),
        )
        self._conn.commit()

    def list_passkeys(self, user_id: str) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT credential_id, user_id, public_key_b64, sign_count, transports, created_at FROM passkeys WHERE user_id = ?",
            (user_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def get_passkey(self, credential_id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM passkeys WHERE credential_id = ?", (credential_id,)
        ).fetchone()
        return dict(row) if row else None

    def update_passkey_sign_count(self, credential_id: str, sign_count: int) -> None:
        self._conn.execute(
            "UPDATE passkeys SET sign_count = ? WHERE credential_id = ?",
            (sign_count, credential_id),
        )
        self._conn.commit()

    def put_webauthn_challenge(
        self, challenge: str, *, purpose: str, user_id: str | None = None, ttl_minutes: int = 10
    ) -> None:
        self._conn.execute(
            "INSERT OR REPLACE INTO webauthn_challenges (challenge, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)",
            (challenge, user_id, purpose, _iso(_now() + timedelta(minutes=ttl_minutes))),
        )
        self._conn.commit()

    def take_webauthn_challenge(self, challenge: str, *, purpose: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM webauthn_challenges WHERE challenge = ? AND purpose = ?",
            (challenge, purpose),
        ).fetchone()
        if row is None:
            return None
        self._conn.execute("DELETE FROM webauthn_challenges WHERE challenge = ?", (challenge,))
        self._conn.commit()
        if _parse_iso(row["expires_at"]) < _now():
            return None
        return dict(row)


def secrets_token() -> str:
    import secrets

    return secrets.token_urlsafe(32)


def _parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


_STORE: ShareIdentityStore | None = None


def get_identity_store(path: Path | None = None) -> ShareIdentityStore:
    global _STORE
    if path is not None:
        return ShareIdentityStore(path)
    if _STORE is None:
        _STORE = ShareIdentityStore()
    return _STORE


def reset_identity_store_for_tests() -> None:
    global _STORE
    if _STORE is not None:
        _STORE.close()
    _STORE = None
