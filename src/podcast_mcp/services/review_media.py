"""Review-share media: local MP3 + optional object storage upload / presign."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from podcast_mcp.edits.review_shares import list_shares
from podcast_mcp.edits.review_versions import (
    encode_version_mp3,
    get_version,
    version_audio_path,
    version_mp3_path,
)
from podcast_mcp.models import EpisodeProject
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.util.object_store import (
    ObjectStoreClient,
    ObjectStoreConfig,
    load_object_store_config,
    resolve_object_store_client,
)

log = logging.getLogger(__name__)

_PRESIGN_MAX_SEC = 24 * 3600
_PRESIGN_MIN_SEC = 3600


def _object_store_client(
    object_store: ObjectStoreConfig | ObjectStoreClient | None,
) -> ObjectStoreClient | None:
    return resolve_object_store_client(
        object_store,
        config_loader=load_object_store_config,
        client_factory=ObjectStoreClient,
    )


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def review_guest_audio_path(project: EpisodeProject, version_id: str) -> Path:
    """Prefer frozen mix.mp3 for guest ReviewApp; fall back to mix.wav."""
    mp3 = version_mp3_path(project, version_id)
    if mp3 is not None:
        return mp3
    return version_audio_path(project, version_id)


def media_type_for_path(path: Path) -> str:
    if path.suffix.lower() == ".mp3":
        return "audio/mpeg"
    return "audio/wav"


def object_store_key_for_version(project: EpisodeProject, version_id: str) -> str:
    ver = get_version(project, version_id)
    digest = (ver.sha256 or version_id)[:64]
    return f"review/{version_id}/{digest}.mp3"


def presign_ttl_seconds(expires_at: str | None) -> int:
    """Clamp share-aware TTL between 1h and 24h."""
    if not expires_at:
        return _PRESIGN_MAX_SEC
    try:
        exp = datetime.fromisoformat(str(expires_at).replace("Z", "+00:00"))
    except ValueError:
        return _PRESIGN_MAX_SEC
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=UTC)
    remaining = int((exp - datetime.now(UTC)).total_seconds())
    if remaining <= 0:
        return _PRESIGN_MIN_SEC
    return max(_PRESIGN_MIN_SEC, min(_PRESIGN_MAX_SEC, remaining))


def ensure_version_mp3(ws: ProjectWorkspace, version_id: str) -> Path:
    """Encode mix.mp3 when missing and persist ``mp3_relpath``."""
    existing = version_mp3_path(ws.project, version_id)
    if existing is not None:
        return existing

    def mutate(p: EpisodeProject) -> dict[str, Any]:
        path = encode_version_mp3(p, version_id)
        return {"mp3_relpath": get_version(p, version_id).mp3_relpath, "path": str(path)}

    result = ws.mutate(
        "before encode review mp3",
        "after encode review mp3",
        mutate,
    )
    return Path(result["path"])


def upload_review_version_to_object_store(
    ws: ProjectWorkspace,
    version_id: str,
    *,
    object_store: ObjectStoreConfig | ObjectStoreClient | None = None,
) -> str | None:
    """Upload mix.mp3 to object storage when configured; persist object key on the version.

    Returns the object key, or None when object storage is not configured.
    """
    client = _object_store_client(object_store)
    if client is None:
        return None

    mp3 = ensure_version_mp3(ws, version_id)
    ver = get_version(ws.project, version_id)
    key = ver.object_store_key or object_store_key_for_version(ws.project, version_id)
    if ver.object_store_key and ver.object_store_uploaded_at:
        # Already uploaded for this version - skip re-upload.
        return ver.object_store_key

    client.upload_file(mp3, key, content_type="audio/mpeg")
    uploaded_at = _now_iso()

    def mutate(p: EpisodeProject) -> dict[str, Any]:
        v = get_version(p, version_id)
        v.object_store_key = key
        v.object_store_uploaded_at = uploaded_at
        return {"object_store_key": key, "object_store_uploaded_at": uploaded_at}

    ws.mutate(
        "before object store upload review mp3",
        "after object store upload review mp3",
        mutate,
    )
    return key


def presigned_review_audio_url(
    project: EpisodeProject,
    version_id: str,
    *,
    expires_at: str | None = None,
    object_store: ObjectStoreConfig | ObjectStoreClient | None = None,
) -> str | None:
    """Return a short-lived GET URL when the version has an object-store key."""
    ver = get_version(project, version_id)
    if not ver.object_store_key:
        return None
    client = _object_store_client(object_store)
    if client is None:
        return None
    ttl = presign_ttl_seconds(expires_at)
    return client.presigned_get_url(ver.object_store_key, expires_in=ttl)


def delete_object_store_object_if_unused(
    ws: ProjectWorkspace,
    version_id: str,
    *,
    object_store: ObjectStoreConfig | ObjectStoreClient | None = None,
) -> bool:
    """Delete an object-store object when no active shares reference the version."""
    ver = get_version(ws.project, version_id)
    key = ver.object_store_key
    if not key:
        return False
    active = [
        row
        for row in list_shares(ws.project)
        if row.get("review_version_id") == version_id and not row.get("revoked")
    ]
    if active:
        return False

    client = _object_store_client(object_store)
    if client is None:
        return False

    try:
        client.delete_object(key)
    except Exception:
        log.warning("Failed to delete object storage object %s", key, exc_info=True)
        return False

    def mutate(p: EpisodeProject) -> dict[str, Any]:
        v = get_version(p, version_id)
        v.object_store_key = None
        v.object_store_uploaded_at = None
        return {"cleared": True}

    try:
        ws.mutate(
            "before clear object store review key",
            "after clear object store review key",
            mutate,
        )
    except Exception:
        log.warning("Cleared object storage object but failed to update project", exc_info=True)
    return True
