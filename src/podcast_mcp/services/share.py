"""Review share orchestration - coolname tokens + CommentService for guests."""

from __future__ import annotations

import logging
import os
import threading
import uuid
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from podcast_mcp.edits.comments import comments_for_view
from podcast_mcp.edits.review_shares import (
    create_share,
    drop_share,
    list_room_shares,
    list_shares,
    register_share_globally,
    resolve_share,
    revoke_share,
    touch_share_last_used,
)
from podcast_mcp.edits.review_versions import get_version, version_audio_path
from podcast_mcp.edits.share_capabilities import (
    CAP_EDIT,
    CAP_MCP,
    CAP_PLAY,
    CAP_SUGGEST,
    CAP_VIEW,
    docs_role_for_capabilities,
    guest_mode,
    has_capability,
    normalize_capabilities,
    resolve_share_capabilities,
)
from podcast_mcp.edits.share_registry import (
    RECORD_REVIEW_VERSION_SENTINEL,
    SHARE_KIND_RECORD,
    SHARE_KIND_REVIEW,
    get_share_registry,
    share_hard_expired,
    share_is_usable,
)
from podcast_mcp.project_io import EPISODE_PROJECT_FILENAME
from podcast_mcp.services.comment import CommentService
from podcast_mcp.services.document_sync.projection_types import parse_view_projection
from podcast_mcp.services.document_sync.service import (
    document_server_seq,
    notify_comments_changed,
)
from podcast_mcp.services.review_media import (
    delete_object_store_object_if_unused,
    review_guest_audio_path,
    upload_review_version_to_object_store,
)
from podcast_mcp.services.workspace import ProjectWorkspace

log = logging.getLogger(__name__)

# Guest DAW audio kinds - never raw (host media paths) or arbitrary kinds.
_DAW_AUDIO_KINDS = frozenset({"premix", "stem", "processed", "review"})
_PENDING_PREVIEW_MODES = frozenset({"current", "suggested", "ab"})
_PENDING_PREVIEW_IMAGE_KINDS = frozenset({"wave", "spec"})
_AUDITION_IMAGE_KINDS = frozenset({"wave", "spec"})
_GUEST_VISUAL_ERROR = "diagnostics failed"
_DEFAULT_SHARE_ORIGIN = "http://127.0.0.1:8765"
_create_for_host_lock = threading.Lock()


def _latest_review_version_id(versions: Sequence[dict[str, Any]]) -> str | None:
    dated = [v for v in versions if v.get("id")]
    if not dated:
        return None

    def sort_key(v: dict[str, Any]) -> str:
        return str(v.get("created_at") or v.get("published_at") or "")

    return str(max(dated, key=sort_key)["id"])


def present_share(
    row: dict[str, Any],
    *,
    public_base_url: str | None = None,
    version_label: str | None = None,
) -> dict[str, Any]:
    """Add host-facing url / role fields to a sidecar or create row."""
    base = (public_base_url or _DEFAULT_SHARE_ORIGIN).rstrip("/")
    token = str(row.get("token") or "")
    caps = row.get("capabilities")
    cap_list = caps if isinstance(caps, list) else None
    kind = str(row.get("kind") or SHARE_KIND_REVIEW)
    prefix = "rec" if kind == SHARE_KIND_RECORD else "r"
    presented = {
        **row,
        "url": f"{base}/{prefix}/{token}" if token else None,
        "kind": kind,
        "record_role": row.get("role") if kind == SHARE_KIND_RECORD else None,
        "session_id": row.get("session_id") if kind == SHARE_KIND_RECORD else None,
        "guest_mode": guest_mode(cap_list) if kind == SHARE_KIND_REVIEW else None,
        "docs_role": (docs_role_for_capabilities(cap_list) if kind == SHARE_KIND_REVIEW else None),
        "mcp_url": (
            f"{base}/mcp/{token}/mcp"
            if (kind == SHARE_KIND_REVIEW and token and has_capability(cap_list, CAP_MCP))
            else None
        ),
        "usable": share_is_usable(row),
    }
    presented.pop("project_workspace", None)
    if version_label is not None:
        presented["review_version_label"] = version_label
    return presented


class ShareService:
    def __init__(self, ws: ProjectWorkspace) -> None:
        self.ws = ws

    def create(
        self,
        *,
        review_version_id: str,
        public_base_url: str | None = None,
        capabilities: list[str] | None = None,
        expires_at: str | None = None,
        general_access: str = "link",
        require_sign_in: bool = False,
    ) -> dict[str, Any]:
        from podcast_mcp.services.share_auth.access import normalize_general_access
        from podcast_mcp.util.share_accounts import require_share_accounts_for_restricted

        ga = normalize_general_access(general_access)
        require_share_accounts_for_restricted(
            general_access=ga,
            require_sign_in=require_sign_in,
        )

        row = create_share(
            self.ws.project,
            review_version_id=review_version_id,
            capabilities=normalize_capabilities(capabilities),
            expires_at=expires_at,
            general_access=ga,
            require_sign_in=require_sign_in,
        )
        register_share_globally(row)
        try:
            upload_review_version_to_object_store(self.ws, review_version_id)
        except Exception:
            log.warning(
                "object storage upload failed for review version %s; guests will stream locally",
                review_version_id,
                exc_info=True,
            )
        if has_capability(row.get("capabilities"), CAP_VIEW):
            try:
                from podcast_mcp.services.proxy_media import ensure_and_upload_all_proxies

                ensure_and_upload_all_proxies(self.ws)
            except Exception:
                log.warning(
                    "Proxy ensure/upload failed for share; guests may fall back to WAV",
                    exc_info=True,
                )
        ver = get_version(self.ws.project, review_version_id)
        return present_share(
            row,
            public_base_url=public_base_url,
            version_label=ver.label,
        )

    def list(self) -> list[dict[str, Any]]:
        return list_shares(self.ws.project)

    def list_presented(self, *, public_base_url: str | None = None) -> Sequence[dict[str, Any]]:
        from podcast_mcp.edits.review_versions import list_versions

        labels = {v.id: v.label for v in list_versions(self.ws.project)}
        presented: list[dict[str, Any]] = []
        for row in list_shares(self.ws.project):
            kind = str(row.get("kind") or SHARE_KIND_REVIEW)
            label = (
                labels.get(str(row.get("review_version_id") or ""))
                if kind == SHARE_KIND_REVIEW
                else None
            )
            presented.append(
                present_share(
                    row,
                    public_base_url=public_base_url,
                    version_label=label,
                )
            )
        return presented

    def create_for_host(
        self,
        *,
        role: str = "commenter",
        with_mcp: bool = False,
        review_version_id: str | None = None,
        public_base_url: str | None = None,
    ) -> dict[str, Any]:
        """Mint a link share from a Docs-like role; publish a mix when none exists."""
        from podcast_mcp.edits.share_capabilities import resolve_share_capabilities
        from podcast_mcp.services.review import ReviewService

        caps = resolve_share_capabilities(role=role, with_mcp=with_mcp)
        with _create_for_host_lock:
            if not review_version_id:
                self.ws.reload()
            version_id = review_version_id or self.ws.project.review.active_version_id
            if not version_id:
                versions = ReviewService(self.ws).list_versions()
                version_id = _latest_review_version_id(versions)
            if not version_id:
                published = ReviewService(self.ws).publish(label="Share mix")
                version_id = str(published["id"])
            return self.create(
                review_version_id=str(version_id),
                public_base_url=public_base_url,
                capabilities=caps,
            )

    def create_record_token(
        self,
        *,
        role: str,
        session_id: str,
        public_base_url: str | None = None,
        expires_at: str | None = None,
        require_room: bool = True,
    ) -> dict[str, Any]:
        """Mint one kind=record token. No object storage upload, proxies, or mix version."""
        if require_room and not list_room_shares(self.ws.project, session_id):
            raise KeyError(f"record room not found: {session_id}")
        caps = resolve_share_capabilities(role=role, kind=SHARE_KIND_RECORD)
        row = create_share(
            self.ws.project,
            review_version_id=RECORD_REVIEW_VERSION_SENTINEL,
            capabilities=caps,
            expires_at=expires_at,
            kind=SHARE_KIND_RECORD,
            role=role,
            session_id=session_id,
        )
        register_share_globally(row)
        return present_share(row, public_base_url=public_base_url)

    def create_record_room(
        self,
        *,
        public_base_url: str | None = None,
        expires_at: str | None = None,
    ) -> dict[str, Any]:
        """Mint one room: session_id + guest token + producer token."""
        from podcast_mcp.services.record.service import (
            assert_no_open_take,
            begin_record_session,
        )

        assert_no_open_take(self.ws.project)
        session_id = uuid.uuid4().hex[:12]
        try:
            guest = self.create_record_token(
                role="guest",
                session_id=session_id,
                public_base_url=public_base_url,
                expires_at=expires_at,
                require_room=False,
            )
            producer = self.create_record_token(
                role="producer",
                session_id=session_id,
                public_base_url=public_base_url,
                expires_at=expires_at,
            )
            begin_record_session(self.ws.project, session_id)
            return {"session_id": session_id, "guest": guest, "producer": producer}
        except Exception:
            self._rollback_room(session_id)
            raise

    def _rollback_room(self, session_id: str) -> None:
        for row in list_room_shares(self.ws.project, session_id):
            token = str(row.get("token") or "")
            if not token:
                continue
            try:
                drop_share(self.ws.project, token)
            except Exception:
                log.exception("failed to roll back record token %s", token)

    def revoke_room(self, session_id: str) -> dict[str, Any]:
        """Revoke every token in the room. KeyError if none exist."""
        rows = list_room_shares(self.ws.project, session_id)
        if not rows:
            raise KeyError(f"record room not found: {session_id}")
        revoked: list[str] = []
        for row in rows:
            token = str(row.get("token") or "")
            if not token or row.get("revoked"):
                continue
            try:
                self.revoke(token)
                revoked.append(token)
            except Exception:
                log.exception("failed to revoke record token %s", token)
        if not revoked:
            raise KeyError(f"record room not found: {session_id}")
        from podcast_mcp.services.record.landing import (
            purge_session_land_rollbacks,
            release_session_land_lock,
            remove_session_land_lock_file,
        )

        # Purge first: it takes the land lock, which the release and file removal drop.
        purge_session_land_rollbacks(self.ws.project, session_id)
        release_session_land_lock(session_id)
        remove_session_land_lock_file(self.ws.project.workspace_path(), session_id)
        return {"session_id": session_id, "revoked": revoked}

    def revoke(self, token: str) -> dict[str, Any]:
        version_id: str | None = None
        kind = SHARE_KIND_REVIEW
        for row in list_shares(self.ws.project):
            if row.get("token") == token:
                kind = str(row.get("kind") or SHARE_KIND_REVIEW)
                version_id = str(row.get("review_version_id") or "") or None
                break
        ok = revoke_share(self.ws.project, token)
        if not ok:
            raise KeyError(f"share not found: {token}")
        if version_id and kind != SHARE_KIND_RECORD:
            try:
                delete_object_store_object_if_unused(self.ws, version_id)
            except Exception:
                log.warning(
                    "object storage cleanup failed for review version %s",
                    version_id,
                    exc_info=True,
                )
        if kind != SHARE_KIND_RECORD:
            try:
                from podcast_mcp.services.proxy_media import delete_all_proxies_if_unused

                delete_all_proxies_if_unused(self.ws)
            except Exception:
                log.warning("Proxy object storage cleanup failed on share revoke", exc_info=True)
        return {"revoked": True, "token": token}


def lookup_share(token: str, *, kind: str | None = None) -> dict[str, Any]:
    """Resolve a usable active share; demote expired/inactive; touch last_used.

    When *kind* is set, a mismatch raises the same KeyError as a missing token
    so prefix↔kind checks leak nothing.
    """
    reg = get_share_registry()
    row = resolve_share(token)
    if row is None or row.get("revoked"):
        raise KeyError("invalid or revoked share token")
    row_kind = str(row.get("kind") or SHARE_KIND_REVIEW)
    if kind is not None and row_kind != kind:
        raise KeyError("invalid or revoked share token")
    if not share_is_usable(row):
        reason = "expired" if share_hard_expired(row) else "inactive"
        reg.demote_to_cooldown(token, reason=reason)
        raise KeyError("invalid or revoked share token")
    workspace = Path(str(row.get("project_workspace") or ""))
    candidate = workspace / EPISODE_PROJECT_FILENAME
    if candidate.is_file():
        try:
            ws = ProjectWorkspace.open(candidate)
            touch_share_last_used(ws.project, token)
            from podcast_mcp.edits.review_shares import list_shares

            for side in list_shares(ws.project):
                if side.get("token") == token:
                    # Sidecar holds general_access / require_sign_in.
                    row = {**row, **side}
                    break
        except Exception:
            log.debug("share last_used touch failed for %s", token, exc_info=True)
            reg.touch_last_used(token)
    else:
        reg.touch_last_used(token)
    row.setdefault("general_access", "link")
    row.setdefault("require_sign_in", False)
    return row


def _mark_share_revoked(token: str, *, ws: ProjectWorkspace | None = None) -> None:
    """Mark a share revoked in the project sidecar (if known) and demote registry."""
    if ws is not None:
        revoke_share(ws.project, token)
        return
    entry = resolve_share(token)
    if entry is not None:
        entry["revoked"] = True
        register_share_globally(entry)


def workspace_from_share_row(row: dict[str, Any]) -> ProjectWorkspace:
    workspace = Path(str(row.get("project_workspace") or ""))
    candidate = workspace / EPISODE_PROJECT_FILENAME
    if not candidate.is_file():
        raise FileNotFoundError("episode project missing for share")
    return ProjectWorkspace.open(candidate)


def share_episode_name(row: dict[str, Any]) -> str:
    try:
        return str(workspace_from_share_row(row).project.meta.name or "")
    except Exception:
        return ""


def open_share_workspace(
    token: str, *, kind: str = SHARE_KIND_REVIEW
) -> tuple[dict[str, Any], ProjectWorkspace]:
    """Open the episode for a share token.

    Defaults to ``kind="review"`` so review-only helpers (audio, DAW, comments,
    MCP, proxies) never accept a record token. Record callers pass
    ``kind=SHARE_KIND_RECORD``; the empty review-version sentinel skips the
    mix-version check.
    """
    row = lookup_share(token, kind=kind)
    ws = workspace_from_share_row(row)
    vid = str(row.get("review_version_id") or "")
    if vid:
        try:
            get_version(ws.project, vid)
        except KeyError:
            # Version deleted/reset after share was minted - revoke so guests
            # stop polling and host logs stay quiet.
            log.warning(
                "Auto-revoking share: review version %s missing from %s",
                vid,
                row.get("project_workspace"),
            )
            _mark_share_revoked(token, ws=ws)
            raise KeyError("invalid or revoked share token") from None
    return row, ws


def require_share_cap(
    token: str, cap: str, *, kind: str = SHARE_KIND_REVIEW
) -> tuple[dict[str, Any], ProjectWorkspace]:
    """Lookup share workspace and require *cap* (raises PermissionError)."""
    row, ws = open_share_workspace(token, kind=kind)
    if not has_capability(row.get("capabilities"), cap):
        raise PermissionError(f"share does not allow {cap}")
    return row, ws


def _sanitize_guest_tracks(tracks: Any) -> list[dict[str, Any]]:
    tracks_out: list[dict[str, Any]] = []
    for track in tracks or []:
        if not isinstance(track, dict):
            continue
        td = dict(track)
        # Keep source presence after removing the private host media path.
        td["has_source_audio"] = bool(td.get("has_source_audio") or td.get("media_path"))
        td["media_path"] = None
        proxy = td.get("proxy")
        if isinstance(proxy, dict):
            px = dict(proxy)
            px.pop("object_store_prefix", None)
            px.pop("object_store_uploaded_at", None)
            td["proxy"] = px
        tracks_out.append(td)
    return tracks_out


def _sanitize_guest_render_status(rs: Any) -> Any:
    if not isinstance(rs, dict):
        return rs
    rs_out = dict(rs)
    tracks_rs = rs_out.get("tracks")
    if isinstance(tracks_rs, dict):
        cleaned_tracks: dict[str, Any] = {}
        for tid, info in tracks_rs.items():
            if isinstance(info, dict):
                row = dict(info)
                row.pop("stem_path", None)
                row.pop("path", None)
                cleaned_tracks[tid] = row
            else:
                cleaned_tracks[tid] = info
        rs_out["tracks"] = cleaned_tracks
    premix = rs_out.get("premix")
    if isinstance(premix, dict):
        premix_out = dict(premix)
        premix_out.pop("path", None)
        rs_out["premix"] = premix_out
    return rs_out


_GUEST_IMPACT_STUB: dict[str, Any] = {
    "pending_review_count": 0,
    "total_removed_sec": 0.0,
    "by_track_sec": {},
}

_GUEST_EMPTY_HISTORY: dict[str, Any] = {
    "cursor": 0,
    "can_undo": False,
    "can_redo": False,
    "entries": [],
    "groups": [],
}


def _guest_view_is_full(view: dict[str, Any]) -> bool:
    """True for a complete ProjectView; false for patch slices (TRACKS/CLIPS/FX/…)."""
    return "project_path" in view


def sanitize_guest_project_view(view: dict[str, Any]) -> dict[str, Any]:
    """Strip host filesystem paths from a ProjectView-shaped dict for guests.

    Size (words[]) is handled by named projections. This keeps **privacy** only.
    TRACKS/DETAIL/CLIPS/FX/ENVELOPES patches sanitize existing keys and do not
    inject full-view stubs.
    """
    from podcast_mcp.gui.mapper import omit_transcript_words

    out = dict(view)
    full = _guest_view_is_full(view)
    if full or "project_path" in out:
        out["project_path"] = ""
    if full or "meta" in out:
        meta = dict(out.get("meta") or {})
        meta.pop("workspace_dir", None)
        guest_meta: dict[str, Any] = {"name": meta.get("name")}
        if "hydration" in meta:
            guest_meta["hydration"] = meta["hydration"]
        out["meta"] = guest_meta
    if "tracks" in out:
        out["tracks"] = _sanitize_guest_tracks(out.get("tracks"))
    # History can embed local paths in labels/params - omit for guests.
    if "history" in out:
        out["history"] = dict(_GUEST_EMPTY_HISTORY)
    # Guest Sharecut Studio keeps a zeroed impact stub so StatusBar/ImpactPanel stay safe.
    if full or "edit_impact" in out:
        out["edit_impact"] = dict(_GUEST_IMPACT_STUB)
    if full or "social_clips" in out:
        out["social_clips"] = []
    if isinstance(out.get("transcript"), dict):
        out["transcript"] = omit_transcript_words(out["transcript"])
        meta = dict(out.get("meta") or {})
        hydra = dict(meta.get("hydration") or {})
        hydra["transcript_words"] = False
        meta["hydration"] = hydra
        out["meta"] = meta
    if "render_status" in out:
        out["render_status"] = _sanitize_guest_render_status(out.get("render_status"))
    return _drop_absolute_path_strings(out)


def sanitize_guest_document_event(event: dict[str, Any]) -> dict[str, Any]:
    """Sanitize a document-plane hub event for share guests.

    Drops host filesystem paths from ``snapshot.project`` / ``snapshot.patch``
    and reduces ``command`` to ``{"type": ...}`` only. ``snapshot.history``
    (groups and entries) is omitted — labels/params can embed local paths.
    """
    out = dict(event)
    cmd = out.get("command")
    if isinstance(cmd, dict):
        out["command"] = {"type": cmd.get("type")}
    snap = out.get("snapshot")
    if isinstance(snap, dict):
        snap = dict(snap)
        if isinstance(snap.get("project"), dict):
            snap["project"] = sanitize_guest_project_view(snap["project"])
        if isinstance(snap.get("patch"), dict):
            snap["patch"] = sanitize_guest_project_view(snap["patch"])
        snap.pop("history", None)
        out["snapshot"] = snap
    return _drop_absolute_path_strings(out)


def sanitize_guest_session_snapshot(snap: dict[str, Any]) -> dict[str, Any]:
    """Belt-and-suspenders: never send host wav paths on the guest session plane."""
    out = dict(snap)
    out["wav"] = None
    out.pop("compare_segments", None)
    out["compare_segments"] = None
    return _drop_absolute_path_strings(out)


def sanitize_guest_session_event(event: dict[str, Any]) -> dict[str, Any]:
    out = dict(event)
    snap = out.get("snapshot")
    if isinstance(snap, dict):
        out["snapshot"] = sanitize_guest_session_snapshot(snap)
    # Some fanout events put fields at the top level.
    if "wav" in out:
        out["wav"] = None
    if "compare_segments" in out:
        out["compare_segments"] = None
    return _drop_absolute_path_strings(out)


def _looks_like_abs_fs_path(value: str) -> bool:
    s = value.strip()
    if not s:
        return False
    if s.startswith("/") and not s.startswith("//"):
        # Share-relative URLs like /api/review/... are OK.
        return not (
            s.startswith("/api/")
            or s.startswith("/r/")
            or s.startswith("/rec/")
            or s.startswith("/assets/")
        )
    return len(s) >= 3 and s[1] == ":" and s[2] in ("\\", "/")


def drop_absolute_path_strings(obj: Any) -> Any:
    """Fail-closed scan: drop string values that look like absolute filesystem paths."""
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for k, v in obj.items():
            if isinstance(v, str) and _looks_like_abs_fs_path(v):
                log.debug("Stripped absolute path from guest payload key %s", k)
                out[k] = None
            else:
                out[k] = drop_absolute_path_strings(v)
        return out
    if isinstance(obj, list):
        return [drop_absolute_path_strings(x) for x in obj]
    return obj


_drop_absolute_path_strings = drop_absolute_path_strings


_GUEST_RENDER_PATH_KEYS = frozenset(
    {
        "path",
        "premix_path",
        "stem_paths",
        "project_path",
        "workspace_dir",
    }
)


def sanitize_guest_render_preview(info: dict[str, Any]) -> dict[str, Any]:
    """Drop host-local filesystem paths from a render_preview result."""
    return {k: v for k, v in info.items() if k not in _GUEST_RENDER_PATH_KEYS}


def share_project_view(token: str) -> dict[str, Any]:
    row, ws = open_share_workspace(token)
    project = ws.project
    vid = row["review_version_id"]
    ver = get_version(project, vid)
    ver_dump = ver.model_dump()
    ver_dump.pop("object_store_key", None)
    ver_dump.pop("object_store_uploaded_at", None)
    duration = project.timeline.duration_sec or 0.0
    caps = list(row.get("capabilities") or [])
    return {
        "mode": "review",
        "guest_mode": guest_mode(caps),
        "token": token,
        "meta": {"name": project.meta.name},
        "timeline_duration_sec": float(duration),
        "review_version": ver_dump,
        "comments": comments_for_view(project),
        "tracks": [],
        "capabilities": caps,
    }


def share_daw_project_view(token: str, *, phase: str | None = None) -> dict[str, Any]:
    """Sharecut Studio ProjectView for guests with the ``view`` capability."""
    from podcast_mcp.services.document_sync.service import dump_projection_locked

    _row, ws = require_share_cap(token, CAP_VIEW)
    projection = parse_view_projection(phase)
    dumped = dump_projection_locked(ws, projection=projection.value, audience="guest")
    return sanitize_guest_project_view(dumped)


def share_daw_meta(token: str) -> dict[str, Any]:
    """Poll meta for guest Sharecut Studio (mtime/size + document seq; no filesystem path)."""
    _row, ws = require_share_cap(token, CAP_VIEW)
    stat = ws.path.stat()
    return {
        "mtime_ns": stat.st_mtime_ns,
        "size": stat.st_size,
        "server_seq": document_server_seq(ws.path),
    }


_GUEST_WAVEFORM_REFS = ("track:", "source:")


def share_daw_waveform_status(token: str) -> dict[str, Any]:
    """Raw-media pyramid status for guests (``view``); stems are host-only.

    Like the host route, this queues missing pyramids: it is the only builder for
    media that predates the eager hooks. The build pool dedupes by (slug, key), so
    a guest can cause at most one build per missing ref.
    """
    from podcast_mcp.services.waveform import waveform_status

    _row, ws = require_share_cap(token, CAP_VIEW)
    return waveform_status(ws.path, "raw")


def share_daw_waveform_tiles(
    token: str, *, ref: str, key: str, level: int, start: int, count: int
) -> bytes:
    """Pyramid data tiles for guests (``view``): raw refs only, live keys only.

    There is deliberately no guest PCM window: raw samples never go to guests.
    """
    from podcast_mcp.services.waveform import live_key, media_index, tile_bytes

    _row, ws = require_share_cap(token, CAP_VIEW)
    if not ref.startswith(_GUEST_WAVEFORM_REFS):
        raise ValueError("guests may only read track: and source: waveforms")
    entry = media_index(ws.path).refs.get(ref)
    if entry is None or live_key(entry) != key:
        raise KeyError("waveform not found")
    return tile_bytes(ws.path, ref, key, level, start, count)


def share_daw_waveform_snap(
    token: str,
    *,
    track_id: str,
    start: float,
    end: float,
    timeline: bool = False,
    focus: float | None = None,
) -> dict[str, Any]:
    from podcast_mcp.services.edit import EditService

    row, ws = require_share_cap(token, CAP_VIEW)
    caps = row.get("capabilities")
    if not has_capability(caps, CAP_SUGGEST) and not has_capability(caps, CAP_EDIT):
        raise PermissionError("share does not allow waveform snap ticks")
    return EditService(ws).waveform_snap_window(
        track_id=track_id,
        start=start,
        end=end,
        timeline=timeline,
        focus=focus,
    )


def share_proxy_manifest(token: str) -> dict[str, Any]:
    """Per-track proxy chunk URLs for guest Sharecut Studio (object storage or local fallback)."""
    from podcast_mcp.engines.play_audit import proxy_render_hash
    from podcast_mcp.services.proxy_media import (
        ensure_track_proxy,
        presigned_proxy_urls,
    )
    from podcast_mcp.util.tracks import dialogue_track_ids

    row, ws = require_share_cap(token, CAP_VIEW)
    if not has_capability(row.get("capabilities"), CAP_PLAY):
        raise PermissionError("share does not allow play")
    expires_at = row.get("expires_at")
    tracks_out: dict[str, Any] = {}
    for tid in dialogue_track_ids(ws.project):
        track = ws.project.track_by_id(tid)
        if track is None:
            continue
        need = track.proxy is None or track.proxy.hash != proxy_render_hash(ws.project, tid)
        if need:
            try:
                ensure_track_proxy(ws, tid)
            except Exception:
                log.warning("Lazy proxy ensure failed for %s", tid, exc_info=True)
                continue
            track = ws.project.track_by_id(tid)
        if track is None or track.proxy is None:
            continue
        proxy = track.proxy
        urls = presigned_proxy_urls(ws.project, tid, expires_at=expires_at)
        if urls is None:
            urls = [
                f"/api/review/{token}/daw/proxy/{tid}/{proxy.hash}/{i}"
                for i in range(proxy.chunk_count)
            ]
        tracks_out[tid] = {
            "hash": proxy.hash,
            "chunk_sec": proxy.chunk_sec,
            "overlap_ms": proxy.overlap_ms,
            "chunk_count": proxy.chunk_count,
            "duration_sec": proxy.duration_sec,
            "urls": urls,
        }
    return {"tracks": tracks_out}


def share_proxy_chunk_path(
    token: str,
    track_id: str,
    chunk_idx: int,
    *,
    proxy_hash: str | None = None,
) -> Path:
    from podcast_mcp.services.proxy_media import (
        ensure_track_proxy,
        local_proxy_chunk_path,
    )

    row, ws = require_share_cap(token, CAP_VIEW)
    if not has_capability(row.get("capabilities"), CAP_PLAY):
        raise PermissionError("share does not allow play")
    ensure_track_proxy(ws, track_id)
    return local_proxy_chunk_path(ws, track_id, chunk_idx, expected_hash=proxy_hash)


def share_daw_audio_path(
    token: str,
    *,
    kind: str = "premix",
    track_id: str | None = None,
) -> Path:
    """Resolve guest DAW audio. Whitelists kinds; never rerenders."""
    from podcast_mcp.gui.audio import resolve_viewer_audio

    kind_norm = (kind or "premix").strip().lower()
    if kind_norm not in _DAW_AUDIO_KINDS:
        raise PermissionError("share does not allow this audio kind")
    row, ws = require_share_cap(token, CAP_PLAY)
    if kind_norm == "review":
        return version_audio_path(ws.project, row["review_version_id"])
    if kind_norm in ("stem", "processed") and track_id:
        known = {t.id for t in ws.project.tracks}
        if track_id not in known:
            raise KeyError("track not found")
    return resolve_viewer_audio(
        ws,
        kind=kind_norm,
        track_id=track_id,
        rerender=False,
    )


def _require_pending_preview_caps(token: str) -> tuple[dict[str, Any], ProjectWorkspace]:
    row, ws = require_share_cap(token, CAP_PLAY)
    if not has_capability(row.get("capabilities"), CAP_VIEW):
        raise PermissionError("share does not allow view")
    return row, ws


def _normalize_pending_preview_mode(mode: str | None) -> str:
    kind = (mode or "suggested").strip().lower()
    if kind not in _PENDING_PREVIEW_MODES:
        raise ValueError("mode must be current, suggested, or ab")
    return kind


def _pending_preview_audio_url(token: str, edit_id: str, mode: str) -> str:
    from urllib.parse import urlencode

    qs = urlencode({"edit_id": edit_id, "mode": mode})
    return f"/api/review/{token}/daw/pending-preview?{qs}"


def _pending_preview_image_url(token: str, edit_id: str, mode: str, kind: str) -> str:
    from urllib.parse import urlencode

    qs = urlencode({"edit_id": edit_id, "mode": mode, "kind": kind})
    return f"/api/review/{token}/daw/pending-preview-image?{qs}"


def _pending_preview_png_path(wav: Path, kind: str) -> Path:
    return wav.with_name(f"{wav.stem}_{kind}.png")


def _render_pending_preview_png(wav: Path, kind: str) -> Path:
    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    png = _pending_preview_png_path(wav, kind)
    if png.is_file():
        return png
    tmp = png.with_name(f"{png.stem}.{os.getpid()}.partial.png")
    eng = FFmpegEngine()
    published = False
    try:
        if kind == "wave":
            eng.render_showwavespic(wav, tmp)
        else:
            eng.render_spectrogram(wav, tmp)
        os.replace(tmp, png)
        published = True
    finally:
        if not published:
            tmp.unlink(missing_ok=True)
    return png


def share_pending_preview_wav_cached(
    token: str,
    *,
    edit_id: str,
    mode: str = "suggested",
) -> Path | None:
    """Return cached listen-first WAV if present. Requires ``play`` + ``view``."""
    from podcast_mcp.services.play import PlayService

    kind = _normalize_pending_preview_mode(mode)
    _, ws = _require_pending_preview_caps(token)
    return PlayService(ws).pending_preview_cached_wav(edit_id, mode=kind)


def share_pending_preview_wav(
    token: str,
    *,
    edit_id: str,
    mode: str = "suggested",
) -> Path:
    """Concat Current / Suggested / A/B WAV for a pending session remove.

    Uses ``PlayService.play_pending_preview`` with ``dry_run=True`` and
    ``rerender=False``. Never plays host speakers. Requires ``play`` + ``view``.
    """
    from podcast_mcp.services.play import PlayService

    kind = _normalize_pending_preview_mode(mode)
    _, ws = _require_pending_preview_caps(token)
    premix = ws.project.artifacts_dir() / "premix.wav"
    if not premix.is_file():
        raise FileNotFoundError("premix.wav not found")
    result = PlayService(ws).play_pending_preview(
        edit_id,
        mode=kind,
        dry_run=True,
        rerender=False,
    )
    return result.wav_path


def share_pending_preview_image_cached(
    token: str,
    *,
    edit_id: str,
    mode: str = "suggested",
    kind: str = "wave",
) -> Path | None:
    image_kind = (kind or "wave").strip().lower()
    if image_kind not in _PENDING_PREVIEW_IMAGE_KINDS:
        raise ValueError("kind must be wave or spec")
    wav = share_pending_preview_wav_cached(token, edit_id=edit_id, mode=mode)
    if wav is None:
        return None
    png = _pending_preview_png_path(wav, image_kind)
    return png if png.is_file() else None


def share_pending_preview_image(
    token: str,
    *,
    edit_id: str,
    mode: str = "suggested",
    kind: str = "wave",
) -> Path:
    """Waveform or spectrogram PNG of the listen-first extract. Requires ``play`` + ``view``."""
    image_kind = (kind or "wave").strip().lower()
    if image_kind not in _PENDING_PREVIEW_IMAGE_KINDS:
        raise ValueError("kind must be wave or spec")
    wav = share_pending_preview_wav(token, edit_id=edit_id, mode=mode)
    return _render_pending_preview_png(wav, image_kind)


def share_pending_preview_info(
    token: str,
    *,
    edit_id: str,
    mode: str = "suggested",
    visual: bool = False,
) -> dict[str, Any]:
    """Guest-safe JSON for MCP: relative share URLs only (no host paths)."""
    from podcast_mcp.edits.pending_preview import resolve_pending_preview

    kind = _normalize_pending_preview_mode(mode)
    _, ws = _require_pending_preview_caps(token)
    window = resolve_pending_preview(ws.project, edit_id)
    share_pending_preview_wav(token, edit_id=edit_id, mode=kind)
    out: dict[str, Any] = {
        "audio_path": _pending_preview_audio_url(token, edit_id, kind),
        "edit_id": edit_id,
        "mode": kind,
        "play_start": window.play_start,
        "play_end": window.play_end,
        "timeline_start": window.timeline_start,
        "timeline_end": window.timeline_end,
        "can_skip": window.can_skip,
        "skip_reason": window.skip_reason,
        "note": (
            "Stream via the share HTTP URLs (or relay public origin). "
            "Remote MCP does not play audio on the host machine."
        ),
    }
    if visual:
        share_pending_preview_image(token, edit_id=edit_id, mode=kind, kind="wave")
        share_pending_preview_image(token, edit_id=edit_id, mode=kind, kind="spec")
        out["wave_path"] = _pending_preview_image_url(token, edit_id, kind, "wave")
        out["spec_path"] = _pending_preview_image_url(token, edit_id, kind, "spec")
    return out


def _audition_context_image_url(
    token: str,
    start: float,
    end: float,
    track_id: str,
    kind: str,
) -> str:
    from urllib.parse import urlencode

    qs = urlencode(
        {
            "start": start,
            "end": end,
            "track_id": track_id,
            "kind": kind,
        }
    )
    return f"/api/review/{token}/daw/audition-context-image?{qs}"


def _audition_window_suffix(start: float, end: float) -> str:
    return f"_{round(start * 1000.0)}_{round(end * 1000.0)}"


def _audition_png_path(
    project: Any,
    track_id: str,
    start: float,
    end: float,
    kind: str,
) -> Path:
    suffix = _audition_window_suffix(start, end)
    name = f"waveform{suffix}.png" if kind == "wave" else f"spectrogram{suffix}.png"
    return project.artifacts_dir() / "diagnostics" / track_id / name


def _require_under_artifacts(project: Any, path: Path) -> Path:
    artifacts = project.artifacts_dir().resolve()
    resolved = path.resolve()
    if artifacts not in resolved.parents and resolved != artifacts:
        raise PermissionError("diagnostic image is outside the workspace")
    return resolved


def share_audition_context_cached(
    token: str,
    *,
    start: float,
    end: float,
) -> bool:
    """True when diagnostic PNGs for the window already exist."""
    _, ws = _require_pending_preview_caps(token)
    from podcast_mcp.util.tracks import dialogue_track_ids

    tids = dialogue_track_ids(ws.project)
    if not tids:
        return True
    return all(
        _audition_png_path(ws.project, tid, start, end, "wave").is_file()
        and _audition_png_path(ws.project, tid, start, end, "spec").is_file()
        for tid in tids
    )


def share_audition_context_image_cached(
    token: str,
    *,
    start: float,
    end: float,
    track_id: str,
    kind: str = "wave",
) -> Path | None:
    image_kind = (kind or "wave").strip().lower()
    if image_kind not in _AUDITION_IMAGE_KINDS:
        raise ValueError("kind must be wave or spec")
    _, ws = _require_pending_preview_caps(token)
    dest = _audition_png_path(ws.project, track_id, start, end, image_kind)
    return dest if dest.is_file() else None


def share_audition_context_info(
    token: str,
    *,
    start: float,
    end: float,
    visual: bool = True,
) -> dict[str, Any]:
    """Guest-safe windowed hear context: captions + relative PNG URLs."""
    from podcast_mcp.edits.audition_context import build_audition_context
    from podcast_mcp.util.tracks import dialogue_track_ids

    _, ws = _require_pending_preview_caps(token)
    ctx = build_audition_context(ws.project, start, end, detail="summary")
    out: dict[str, Any] = {
        "timeline_start": ctx.get("timeline_start"),
        "timeline_end": ctx.get("timeline_end"),
        "mid_sec": ctx.get("mid_sec"),
        "detail": "visual" if visual else ctx.get("detail"),
        "tracks": ctx.get("tracks") or [],
        "clip_skew": ctx.get("clip_skew"),
        "comments": ctx.get("comments"),
        "edits": ctx.get("edits"),
        "render_status": ctx.get("render_status"),
        "warnings": ctx.get("warnings") or [],
        "summary": ctx.get("summary"),
        "note": (
            "Stream PNGs via the share HTTP URLs (or relay public origin). "
            "Remote MCP does not play audio on the host machine."
        ),
    }
    if not visual:
        return out
    visuals_out: list[dict[str, Any]] = []
    for tid in dialogue_track_ids(ws.project):
        entry: dict[str, Any] = {"track_id": tid}
        try:
            share_audition_context_image(token, start=start, end=end, track_id=tid, kind="wave")
            share_audition_context_image(token, start=start, end=end, track_id=tid, kind="spec")
            entry["wave_path"] = _audition_context_image_url(token, start, end, tid, "wave")
            entry["spec_path"] = _audition_context_image_url(token, start, end, tid, "spec")
        except Exception:
            entry["error"] = _GUEST_VISUAL_ERROR
        visuals_out.append(entry)
    out["visuals"] = visuals_out
    return out


def share_audition_context_image(
    token: str,
    *,
    start: float,
    end: float,
    track_id: str,
    kind: str = "wave",
) -> Path:
    """Waveform or spectrogram PNG for a timeline window. Requires ``play`` + ``view``."""
    from podcast_mcp.edits.audio_quality import track_diagnostics_audio_path
    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    image_kind = (kind or "wave").strip().lower()
    if image_kind not in _AUDITION_IMAGE_KINDS:
        raise ValueError("kind must be wave or spec")
    _, ws = _require_pending_preview_caps(token)
    known = {t.id for t in ws.project.tracks}
    if track_id not in known:
        raise KeyError("track not found")
    dest = _audition_png_path(ws.project, track_id, start, end, image_kind)
    dest.parent.mkdir(parents=True, exist_ok=True)
    _require_under_artifacts(ws.project, dest)
    if dest.is_file():
        return dest.resolve()
    src = track_diagnostics_audio_path(ws.project, track_id)
    tmp = dest.with_name(f"{dest.stem}.{os.getpid()}.partial.png")
    duration = end - start
    eng = FFmpegEngine()
    published = False
    try:
        if image_kind == "wave":
            eng.render_showwavespic(src, tmp, start_sec=start, duration_sec=duration)
        else:
            eng.render_spectrogram(src, tmp, start_sec=start, duration_sec=duration)
        os.replace(tmp, dest)
        published = True
    finally:
        if not published:
            tmp.unlink(missing_ok=True)
    resolved = _require_under_artifacts(ws.project, dest)
    if not resolved.is_file():
        raise FileNotFoundError("diagnostic image not found")
    return resolved


def share_upload_media(
    token: str,
    *,
    filename: str,
    data: bytes,
    upload_id: str | None = None,
    chunk_index: int = 0,
    total_chunks: int = 1,
) -> dict[str, Any]:
    """Chunked upload into host ``raw/`` (requires ``edit``)."""
    from podcast_mcp.services.media_store import write_upload_chunk

    _row, ws = require_share_cap(token, CAP_EDIT)
    return write_upload_chunk(
        ws.project.workspace_path(),
        filename=filename,
        data=data,
        upload_id=upload_id,
        chunk_index=chunk_index,
        total_chunks=total_chunks,
    )


def share_audio_path(token: str) -> Path:
    row, ws = open_share_workspace(token)
    if not has_capability(row.get("capabilities"), CAP_PLAY):
        raise PermissionError("share does not allow playback")
    return review_guest_audio_path(ws.project, row["review_version_id"])


def resolve_share_audio_redirect(token: str) -> str | None:
    """Ensure object storage upload (lazy) and return a presigned URL when available."""
    from podcast_mcp.services.review_media import (
        presigned_review_audio_url,
        upload_review_version_to_object_store,
    )

    row, ws = open_share_workspace(token)
    if not has_capability(row.get("capabilities"), CAP_PLAY):
        raise PermissionError("share does not allow playback")
    vid = str(row["review_version_id"])
    try:
        upload_review_version_to_object_store(ws, vid)
    except Exception:
        log.warning(
            "Lazy object storage upload failed for review version %s",
            vid,
            exc_info=True,
        )
    return presigned_review_audio_url(
        ws.project,
        vid,
        expires_at=row.get("expires_at"),
    )


def share_add_comment(
    token: str,
    *,
    body: str,
    author: str,
    timeline_start: float,
    timeline_end: float | None = None,
    edit_decision_id: str | None = None,
    track_ids: list[str] | None = None,
) -> dict[str, Any]:
    row, ws = open_share_workspace(token)
    if not has_capability(row.get("capabilities"), "comment"):
        raise PermissionError("share does not allow comments")
    ws.project.review.active_version_id = row["review_version_id"]
    comment = CommentService(ws).add(
        body=body,
        author=author,
        timeline_start=timeline_start,
        timeline_end=timeline_end,
        edit_decision_id=edit_decision_id,
        track_ids=track_ids,
    )
    notify_comments_changed(ws.path)
    return comment


def share_add_reply(
    token: str,
    comment_id: str,
    *,
    body: str,
    author: str,
) -> dict[str, Any]:
    row, ws = open_share_workspace(token)
    if not has_capability(row.get("capabilities"), "reply"):
        raise PermissionError("share does not allow replies")
    result = CommentService(ws).add_reply(comment_id, body=body, author=author)
    notify_comments_changed(ws.path)
    return result


def share_set_action_done(
    token: str,
    comment_id: str,
    action_id: str,
    *,
    done: bool = True,
    by: str = "guest",
) -> dict[str, Any]:
    """Toggle a comment action item (requires ``action`` capability)."""
    from podcast_mcp.edits.share_capabilities import CAP_ACTION

    row, ws = open_share_workspace(token)
    if not has_capability(row.get("capabilities"), CAP_ACTION):
        raise PermissionError("share does not allow action items")
    result = CommentService(ws).set_action_done(
        comment_id,
        action_id,
        done=done,
        by=by,
    )
    notify_comments_changed(ws.path)
    return result


def share_allows_mcp(token: str) -> bool:
    row = lookup_share(token, kind=SHARE_KIND_REVIEW)
    return has_capability(row.get("capabilities"), "mcp")
