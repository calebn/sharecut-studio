"""Document sync authority - typed commands → services → log → fanout."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

from podcast_mcp.edits.comments import comments_for_view
from podcast_mcp.models import EpisodeProject
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.handlers import apply_command
from podcast_mcp.services.document_sync.projection_types import (
    ViewProjection,
    parse_view_projection,
)
from podcast_mcp.services.history import HistoryService
from podcast_mcp.services.session_sync.hub import get_hub
from podcast_mcp.services.session_sync.log import SyncStore
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.util.project_state import project_state_lock

_STORE_CACHE: dict[str, SyncStore] = {}
_STORE_LOCK = threading.Lock()


def document_db_path(project: EpisodeProject) -> Path:
    return project.artifacts_dir() / "session" / "document.db"


def document_hub_key(project: EpisodeProject) -> str:
    return f"document:{project.workspace_path()}"


def document_submit_lock(project: EpisodeProject) -> threading.RLock:
    """Return the per-workspace lock for document mutations and related saves.

    ``document_snapshot`` acquires this lock so hello WS / comments GET cannot
    tear ``server_seq`` vs history against a concurrent ``submit``. Services
    that reload and save the same project outside document commands must use it
    too, so they cannot overwrite a document mutation with a stale workspace.
    The lock is reentrant for callers such as ``submit`` that take snapshots.
    """
    return project_state_lock(project)


def _store_for(project: EpisodeProject) -> SyncStore:
    key = str(document_db_path(project).resolve())
    with _STORE_LOCK:
        store = _STORE_CACHE.get(key)
        if store is not None:
            return store
        store = SyncStore(document_db_path(project))
        _STORE_CACHE[key] = store
        return store


def dump_projection_locked(
    ws: ProjectWorkspace,
    *,
    projection: str,
    audience: str = "host",
) -> dict[str, Any]:
    """Dump a ProjectView slice under the document submit lock."""
    from typing import Literal

    from podcast_mcp.gui.assembler import dump_project_projection

    guest_or_host: Literal["host", "guest"] = "guest" if audience == "guest" else "host"
    with document_submit_lock(ws.project):
        ws.reload()
        return dump_project_projection(ws, projection=projection, audience=guest_or_host)


def _history_wire(hist: dict[str, Any]) -> dict[str, Any]:
    """History tab payload: undo flags + groups only (no flat entries/params)."""
    return {
        "cursor": hist["cursor"],
        "can_undo": hist["can_undo"],
        "can_redo": hist["can_redo"],
        "groups": hist["groups"],
    }


class DocumentSyncService:
    """Submit → handler registry → append document log → fanout Applied."""

    def __init__(self, ws: ProjectWorkspace) -> None:
        self.ws = ws
        self.project = ws.project
        self._project_key = document_hub_key(ws.project)

    @classmethod
    def open(cls, project_path: str | Path) -> DocumentSyncService:
        return cls(ProjectWorkspace.open(project_path))

    @property
    def store(self) -> SyncStore:
        return _store_for(self.project)

    def document_snapshot(self, *, projection: str = "shell") -> dict[str, Any]:
        """Comments + history groups + projected ProjectView / patch for peer DAW merge."""
        from podcast_mcp.gui.assembler import dump_project_projection

        with document_submit_lock(self.project):
            self.project = self.ws.reload()
            snap = self.store.get_snapshot() or {"server_seq": 0}
            hist = HistoryService(self.ws).list_entries()
            proj = parse_view_projection(str(projection), default=ViewProjection.SHELL)
            api_snap: dict[str, Any] = {
                "server_seq": int(snap.get("server_seq") or 0),
                "comments": comments_for_view(self.project),
                "active_version_id": self.project.review.active_version_id,
                "history": _history_wire(hist),
            }
            if proj is ViewProjection.COMMENTS:
                return api_snap
            dumped = dump_project_projection(self.ws, projection=proj, history=hist)
            if proj in (ViewProjection.FULL, ViewProjection.SHELL):
                api_snap["project"] = dumped
                return api_snap
            if proj is ViewProjection.DETAIL and isinstance(dumped.get("history"), dict):
                dumped = {**dumped, "history": _history_wire(hist)}
            api_snap["patch"] = dumped
            return api_snap

    def comments_snapshot(self) -> dict[str, Any]:
        """Comments + history groups without a ProjectView dump."""
        return self.document_snapshot(projection="comments")

    def submit(
        self,
        command: DocumentCommand,
        *,
        capabilities: list[str] | None = None,
        structural_mode: str | None = None,
    ) -> dict[str, Any]:
        if capabilities is not None:
            from podcast_mcp.services.document_sync.capabilities import (
                authorize_document_command,
            )

            authorize_document_command(capabilities, command.type)

        store = self.store
        event: dict[str, Any] | None = None
        with document_submit_lock(self.project):
            existing = store.find_by_client_seq(command.client_id, command.client_seq)
            if existing is None:
                existing = store.find_by_command_id(command.command_id)
            from podcast_mcp.services.document_sync.projections import (
                projection_for_command,
            )

            snap_proj = projection_for_command(command.type).value
            if existing is not None:
                return {
                    "ok": True,
                    "type": "Applied",
                    "command": existing,
                    "snapshot": self.document_snapshot(projection=snap_proj),
                    "server_seq": existing["server_seq"],
                    "idempotent": True,
                }

            # Apply on the saved project: another request may have committed
            # since this service opened it, and committing a stale copy would
            # drop that change.
            self.project = self.ws.reload()
            if command.type == "SetEnvelope":
                from podcast_mcp.services.document_sync.payloads import validate_payload

                command.payload = validate_payload(command.type, command.payload)
            result_payload = self._apply(
                command,
                capabilities=capabilities,
                structural_mode=structural_mode,
            )
            row = store.append_command(
                command_id=command.command_id,
                client_id=command.client_id,
                client_seq=command.client_seq,
                role=command.role,
                type=command.type,
                payload={**command.payload, "result": result_payload},
                causation_id=command.causation_id,
            )
            snap_data = {
                "server_seq": int(row["server_seq"]),
                "last_command_id": command.command_id,
                "last_type": command.type,
            }
            store.put_snapshot(int(row["server_seq"]), snap_data)
            try:
                api_snap = self.document_snapshot(projection=snap_proj)
            except Exception:
                try:
                    api_snap = self.document_snapshot(projection="shell")
                except Exception:
                    api_snap = {"server_seq": int(row["server_seq"]), "resync": True}
            event = {
                "type": "Applied",
                "plane": "document",
                "command": row,
                "snapshot": api_snap,
                "server_seq": row["server_seq"],
            }
        get_hub().publish(self._project_key, event)
        return {"ok": True, **event}

    def publish_document_changed(self, *, projection: str = "shell") -> dict[str, Any]:
        """Fanout a document snapshot after an out-of-band project mutate."""
        with document_submit_lock(self.project):
            api_snap = self.document_snapshot(projection=projection)
            event = {
                "type": "Applied",
                "plane": "document",
                "command": {"type": "ExternalMutate"},
                "snapshot": api_snap,
                "server_seq": api_snap.get("server_seq", 0),
            }
        get_hub().publish(self._project_key, event)
        return event

    def _apply(
        self,
        command: DocumentCommand,
        *,
        capabilities: list[str] | None = None,
        structural_mode: str | None = None,
    ) -> dict[str, Any]:
        from podcast_mcp.services.document_sync.policy import (
            STRUCTURAL_COMMANDS,
            resolve_structural_mode,
        )

        payload = dict(command.payload)
        if command.type in STRUCTURAL_COMMANDS:
            mode = resolve_structural_mode(capabilities, structural_mode)
            payload["_structural_mode"] = mode.value
        try:
            return apply_command(self.ws, command.type, payload)
        except KeyError as exc:
            from podcast_mcp.services.document_sync.errors import DocumentConflictError

            raise DocumentConflictError(str(exc) or "target not found") from exc
        except ValueError as exc:
            msg = str(exc).lower()
            if "not found" in msg or "unknown clip" in msg or "missing" in msg:
                from podcast_mcp.services.document_sync.errors import (
                    DocumentConflictError,
                )

                raise DocumentConflictError(str(exc)) from exc
            raise


def notify_document_changed(project_path: str | Path) -> None:
    """Best-effort document fanout after MCP/CLI (or REST) project mutations."""
    try:
        DocumentSyncService.open(project_path).publish_document_changed()
    except OSError:
        return


def document_server_seq(project_path: str | Path) -> int:
    """Materialized document log seq, or 0 if the store is missing."""
    try:
        snap = DocumentSyncService.open(project_path).store.get_snapshot() or {}
        return int(snap.get("server_seq") or 0)
    except OSError:
        return 0


def notify_comments_changed(project_path: str | Path) -> None:
    """Best-effort document fanout after REST CommentService mutations."""
    try:
        DocumentSyncService.open(project_path).publish_document_changed(projection="comments")
    except OSError:
        return


def after_agent_mutation(project_path: str | Path | ProjectWorkspace) -> None:
    """Notify open Sharecut Studio tabs after an agent/CLI mutation (not document submit)."""
    path = project_path.path if isinstance(project_path, ProjectWorkspace) else project_path
    notify_document_changed(path)
