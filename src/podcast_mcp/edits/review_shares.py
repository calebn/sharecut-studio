"""Review share tokens (project sidecar JSON + host sqlite uniqueness registry).

Public ``/r/{token}`` IDs are coolname slugs. Uniqueness across **active** and
**cooldown** pools is enforced by ``share_registry`` (see docs/share-tokens.md).
"""

from __future__ import annotations

import json
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from podcast_mcp.edits.share_capabilities import (
    RECORD_ROLE_PRESETS,
    normalize_capabilities,
    record_capabilities_for_role,
)
from podcast_mcp.edits.share_registry import (
    RECORD_REVIEW_VERSION_SENTINEL,
    SHARE_KIND_REVIEW,
    SHARE_KINDS,
    SHARE_TOKEN_IS_GLOBALLY_UNIQUE,
    _parse_iso,
    claim_with_mint_retry,
    get_share_registry,
    share_is_usable,
)
from podcast_mcp.models import EpisodeProject

_SHARES_NAME = "shares.json"
_sidecar_lock = threading.Lock()


def shares_path(project: EpisodeProject) -> Path:
    return project.artifacts_dir() / "review" / _SHARES_NAME


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _load(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(data, list):
        return []
    return [row for row in data if isinstance(row, dict)]


def _save(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(rows, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def create_share(
    project: EpisodeProject,
    *,
    review_version_id: str,
    capabilities: list[str] | None = None,
    expires_at: str | None = None,
    general_access: str = "link",
    require_sign_in: bool = False,
    kind: str = SHARE_KIND_REVIEW,
    role: str | None = None,
    session_id: str | None = None,
) -> dict[str, Any]:
    from podcast_mcp.edits.review_versions import get_version
    from podcast_mcp.services.share_auth.access import normalize_general_access

    assert SHARE_TOKEN_IS_GLOBALLY_UNIQUE  # documented contract
    if kind not in SHARE_KINDS:
        raise ValueError(f"unknown share kind {kind!r}")
    if expires_at is not None and _parse_iso(expires_at) is None:
        raise ValueError(f"expires_at must be ISO 8601, got {expires_at!r}")
    ga = normalize_general_access(general_access)
    if kind == SHARE_KIND_REVIEW:
        get_version(project, review_version_id)
        caps_out = normalize_capabilities(capabilities)
    else:
        if review_version_id != RECORD_REVIEW_VERSION_SENTINEL:
            raise ValueError("record shares must use an empty review_version_id")
        record_role = str(role or "").strip().lower()
        if record_role not in RECORD_ROLE_PRESETS:
            raise ValueError("record shares require role guest or producer")
        if not session_id:
            raise ValueError("record shares require session_id")
        if ga != "link" or require_sign_in:
            raise ValueError("record links do not support restricted access yet")
        role = record_role
        caps_out = record_capabilities_for_role(role)
    created = _now_iso()
    reg = get_share_registry()
    # Mint + claim with retry on reservation races; UNIQUE before sidecar write.
    row = claim_with_mint_retry(
        {
            "id": uuid.uuid4().hex[:12],
            "project_workspace": str(Path(project.workspace_dir).resolve()),
            "review_version_id": review_version_id,
            "created_at": created,
            "last_used_at": created,
            "expires_at": expires_at,
            "capabilities": caps_out,
            "general_access": ga,
            "require_sign_in": bool(require_sign_in),
            "revoked": False,
            "kind": kind,
            "role": role,
            "session_id": session_id,
        },
        registry=reg,
    )
    token = str(row["token"])
    try:
        path = shares_path(project)
        with _sidecar_lock:
            rows = _load(path)
            rows.append(row)
            _save(path, rows)
    except Exception:
        # Release without 365d cooldown - flaky disk must not burn coolnames.
        reg.release_claim(token)
        raise
    return row


def list_shares(project: EpisodeProject) -> list[dict[str, Any]]:
    return _load(shares_path(project))


def list_room_shares(project: EpisodeProject, session_id: str) -> list[dict[str, Any]]:
    """Return sidecar rows for a record room (any revoked state)."""
    sid = str(session_id or "")
    if not sid:
        return []
    return [row for row in list_shares(project) if str(row.get("session_id") or "") == sid]


def list_usable_shares(project: EpisodeProject) -> list[dict[str, Any]]:
    """Shares that guests may still use (not revoked / expired / inactive)."""
    return [row for row in list_shares(project) if share_is_usable(row)]


def revoke_share(project: EpisodeProject, token: str) -> bool:
    path = shares_path(project)
    with _sidecar_lock:
        rows = _load(path)
        found = False
        for row in rows:
            if row.get("token") == token:
                row["revoked"] = True
                found = True
        if found:
            _save(path, rows)
    if found:
        get_share_registry().demote_to_cooldown(token, reason="revoked")
    return found


def drop_share(project: EpisodeProject, token: str) -> bool:
    """Remove a sidecar row and release the registry claim (no cooldown)."""
    path = shares_path(project)
    found = False
    with _sidecar_lock:
        rows = _load(path)
        kept = [row for row in rows if row.get("token") != token]
        found = len(kept) != len(rows)
        if found:
            _save(path, kept)
    released = get_share_registry().release_claim(token)
    return found or released


def touch_share_last_used(project: EpisodeProject, token: str) -> str | None:
    """Persist last_used_at on sidecar + registry when throttle allows."""
    ts = get_share_registry().touch_last_used(token)
    if ts is None:
        return None
    path = shares_path(project)
    with _sidecar_lock:
        rows = _load(path)
        changed = False
        for row in rows:
            if row.get("token") == token:
                row["last_used_at"] = ts
                changed = True
        if changed:
            _save(path, rows)
    return ts


def resolve_share(
    token: str,
    *,
    registry_path: Path | None = None,
) -> dict[str, Any] | None:
    """Resolve token via the host sqlite share registry (active pool only).

    *registry_path* defaults to the process registry (see ``get_share_registry``).
    """
    try:
        return get_share_registry(registry_path).get_active(token)
    except Exception:
        return None


def register_share_globally(
    row: dict[str, Any],
    *,
    registry_path: Path | None = None,
) -> None:
    """Upsert an active registry row (or demote when revoked).

    Kept for ShareService call sites. New creates already ``claim_active`` inside
    ``create_share``; this syncs revoke / re-register paths.
    """
    reg = get_share_registry(registry_path)
    token = str(row.get("token") or "")
    if not token:
        return
    if row.get("revoked"):
        reg.demote_to_cooldown(token, reason="revoked")
        return
    existing = reg.get_active(token)
    if existing is None:
        if not reg.is_reserved(token):
            reg.claim_active(row)
        return
    reg.upsert_active_metadata(row)
