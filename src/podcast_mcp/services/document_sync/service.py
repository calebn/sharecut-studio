"""Document sync authority - typed commands → services → log → fanout."""

from __future__ import annotations

import copy
import json
import logging
import threading
from pathlib import Path
from typing import Any

from podcast_mcp.edits.comments import comments_for_view
from podcast_mcp.models import EpisodeProject, SavedDocumentCommand
from podcast_mcp.project_store import commit_landed
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.errors import DocumentSequenceConflictError
from podcast_mcp.services.document_sync.handlers import apply_command
from podcast_mcp.services.document_sync.projection_types import (
    ViewProjection,
    parse_view_projection,
)
from podcast_mcp.services.history import HISTORY_RERENDER_ERRORS, HistoryService
from podcast_mcp.services.session_sync.hub import get_hub
from podcast_mcp.services.session_sync.log import SyncStore
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.util.project_state import project_file_revision, project_state_lock

log = logging.getLogger(__name__)

_STORE_CACHE: dict[str, SyncStore] = {}
_STORE_LOCK = threading.Lock()


def document_db_path(project: EpisodeProject) -> Path:
    return project.artifacts_dir() / "session" / "document.db"


def document_hub_key(project: EpisodeProject) -> str:
    return f"document:{project.workspace_path()}"


def document_submit_lock(project: EpisodeProject) -> threading.RLock:
    """Return the in-process read lock for document snapshots.

    ``document_snapshot``, ``dump_projection_locked`` and ``publish_document_changed``
    acquire it so hello WS / comments GET cannot tear ``server_seq`` vs history
    against a concurrent ``submit``. Writers use ``ProjectWorkspace.transaction()``,
    which also excludes other processes. The lock is reentrant.
    """
    return project_state_lock(project)


def _store_for(project: EpisodeProject) -> SyncStore:
    """Cached document.db store. Write to it only through ``DocumentSyncService.submit`` (project lock first)."""
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


def _edit_key(command_type: str, payload: dict[str, Any]) -> str:
    """What a command does: type + payload without the ``result`` the journal stores."""
    body = {key: value for key, value in payload.items() if key != "result"}
    return json.dumps(
        {"type": command_type, "payload": body}, sort_keys=True, separators=(",", ":")
    )


def _same_edit(row: dict[str, Any], command: DocumentCommand) -> bool:
    return _edit_key(str(row["type"]), dict(row["payload"])) == _edit_key(
        command.type, command.payload
    )


def existing_document_command(store: SyncStore, command: DocumentCommand) -> dict[str, Any] | None:
    """The journal row a retry of ``command`` names, or None for a new edit (#377).

    Explicit ``client_seq``: the row at ``(client_id, client_seq)`` is a retry when it has
    the same ``command_id`` or (older clients mint a new id per attempt) the same type and
    payload; any other edit there raises ``DocumentSequenceConflictError``. A ``command_id``
    already journaled under another sequence must come from the same ``client_id`` and name
    the same edit.
    """
    if command.client_seq is not None:
        row = store.find_by_client_seq(command.client_id, command.client_seq)
        if row is not None:
            if row["command_id"] != command.command_id and not _same_edit(row, command):
                raise DocumentSequenceConflictError(
                    f"client_seq {command.client_seq} of {command.client_id!r} already names a "
                    "different edit; send a new edit with a new client_seq"
                )
            return row
    row = store.find_by_command_id(command.command_id)
    if row is not None and (row["client_id"] != command.client_id or not _same_edit(row, command)):
        # Scoped to the sender: another client's command_id never returns its row (or result).
        raise DocumentSequenceConflictError("command_id already names a different edit")
    return row


def _journal_server_seq(store: SyncStore) -> int:
    return int((store.get_snapshot() or {}).get("server_seq") or 0)


def _journal_snapshot(_snap: dict[str, Any] | None, appended: dict[str, Any]) -> dict[str, Any]:
    return {
        "server_seq": int(appended["server_seq"]),
        "last_command_id": appended["command_id"],
        "last_type": appended["type"],
    }


def _empty_journal_snapshot() -> dict[str, Any]:
    return {"server_seq": 0}


def journal_saved_command(store: SyncStore, project: EpisodeProject) -> dict[str, Any] | None:
    """Reconcile a command a crash saved to the project without its journal row (#575).

    The row keeps the saved command's own client_id/role/causation_id (whichever client
    submits next triggers it) and its ts_ns is the recovery time; payload.result is None.

    Returns the recovered journal row, or ``None`` when there is nothing to
    reconcile (no saved command, the journal has moved past its
    ``base_server_seq``, or it is already journaled).

    Call it under the project lock and outside ``store.write_transaction()``:
    ``append_and_apply`` then commits the recovered row on its own, before the next
    command's apply reads ``_journal_server_seq`` for its ``base_server_seq``. A later
    rollback of that command's transaction then cannot take the recovered row with it.
    """
    saved = project.document_sync.last_command
    if saved is None:
        return None
    server_seq = _journal_server_seq(store)
    if server_seq != saved.base_server_seq:
        if store.find_by_command_id(saved.command_id) is None:
            log.warning(
                "Skipped saved document command %s: it is not in the journal, which stands "
                "at server_seq %d instead of its base_server_seq %d (document.db reset, "
                "restored or deleted since it was saved) (#575)",
                saved.command_id,
                server_seq,
                saved.base_server_seq,
            )
        return None
    if store.find_by_command_id(saved.command_id) is not None:
        return None
    row, _snap, claimed = store.append_and_apply(
        command_id=saved.command_id,
        client_id=saved.client_id,
        client_seq=saved.client_seq,
        role=saved.role,
        type=saved.type,
        payload={**saved.payload, "result": None},
        causation_id=saved.causation_id,
        apply_fn=_journal_snapshot,
        empty_snap_fn=_empty_journal_snapshot,
    )
    if claimed:
        return None
    log.warning(
        "Journaled a command saved without its journal row after a crash (#575): %s",
        saved.command_id,
    )
    return row


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
            server_seq = _journal_server_seq(self.store)
            hist = HistoryService(self.ws).list_entries()
            proj = parse_view_projection(str(projection), default=ViewProjection.SHELL)
            api_snap: dict[str, Any] = {
                "server_seq": server_seq,
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
        from podcast_mcp.services.document_sync.projections import projection_for_command

        if command.type == "SetEnvelope":
            from podcast_mcp.services.document_sync.payloads import validate_payload

            # Normalize first so a retry compares the stored payload.
            command.payload = validate_payload(command.type, command.payload)
        snap_proj = projection_for_command(command.type).value
        # One cross-process step (#213, #377): the project lock, then the document.db write
        # lock (never the reverse). First, a command a crash saved to the project without
        # its journal row is journaled and committed on its own (``journal_saved_command``,
        # #575), so the base_server_seq saved with this command is a committed value and a
        # rollback of this command's transaction cannot take the recovered row with it.
        # Then one write transaction runs the retry check, the apply, and the journal row +
        # snapshot. The write lock is taken before the apply, so a busy journal or a handler
        # error fails the command before the project changes. The apply's commit also saves
        # the command as ``document_sync.last_command``, so after a crash or an I/O failure
        # of the journal INSERT or COMMIT after the apply, the next submit journals it
        # first. Undo/redo with rerender holds both locks for its render. This is the only
        # document.db writer and it takes the project lock first, so another writer waits on
        # the project lock (30 s, then filelock.Timeout), not on sqlite's busy timeout; a
        # busy sqlite lock that escapes anyway maps to the same 503 / project_busy in the
        # routes.
        with self.ws.transaction():
            self.project = self.ws.project
            journal_saved_command(store, self.project)
            with store.write_transaction():
                existing = existing_document_command(store, command)
                if existing is not None:
                    return {
                        "ok": True,
                        "type": "Applied",
                        "command": existing,
                        "snapshot": self.document_snapshot(projection=snap_proj),
                        "server_seq": existing["server_seq"],
                        "idempotent": True,
                    }

                result_payload = self._apply_saving_command(
                    command,
                    store,
                    capabilities=capabilities,
                    structural_mode=structural_mode,
                )
                row, _snap, claimed = store.append_and_apply(
                    command_id=command.command_id,
                    client_id=command.client_id,
                    client_seq=command.client_seq,
                    role=command.role,
                    type=command.type,
                    payload={**command.payload, "result": result_payload},
                    causation_id=command.causation_id,
                    apply_fn=_journal_snapshot,
                    empty_snap_fn=_empty_journal_snapshot,
                )
                if claimed:
                    # Unreachable while the write lock is held from the check; kept as a
                    # guard.
                    raise RuntimeError(
                        "document journal row was claimed outside the project transaction"
                    )
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
                # Publish under the locks so in-process subscribers see Applied in
                # server_seq order. publish only schedules
                # (test_hub_publish_only_schedules_delivery).
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
            # publish only schedules (test_hub_publish_only_schedules_delivery).
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
        except HISTORY_RERENDER_ERRORS as exc:
            # A history move with rerender=true is saved before these are raised. A 409
            # carries the "re-render the preview, do not repeat the move" advice and keeps
            # the client from replaying the move.
            from podcast_mcp.services.document_sync.errors import DocumentConflictError

            raise DocumentConflictError(str(exc)) from exc

    def _apply_saving_command(
        self,
        command: DocumentCommand,
        store: SyncStore,
        *,
        capabilities: list[str] | None = None,
        structural_mode: str | None = None,
    ) -> dict[str, Any]:
        """Apply ``command``, saving it as ``document_sync.last_command`` on the same commit.

        A crash between this commit and the journal INSERT/COMMIT leaves the saved
        command for ``journal_saved_command`` to reconcile on the next submit (#575).
        """
        project = self.ws.project
        previous = project.document_sync.last_command
        revision = project_file_revision(project)
        project.document_sync.last_command = SavedDocumentCommand(
            command_id=command.command_id,
            client_id=command.client_id,
            client_seq=command.client_seq,
            role=command.role,
            type=command.type,
            payload=copy.deepcopy(command.payload),
            causation_id=command.causation_id,
            base_server_seq=_journal_server_seq(store),
        )
        try:
            result = self._apply(
                command,
                capabilities=capabilities,
                structural_mode=structural_mode,
            )
        except BaseException:
            # A failed history render calls discard_changes; re-read the (possibly
            # reverted) in-memory project before deciding whether the commit landed.
            self.project = self.ws.project
            landed = commit_landed(self.project, revision)
            if landed is not True:
                # Never keep a record whose apply may not have landed: the next submit
                # would journal an edit that never applied.
                self.project.document_sync.last_command = previous
            if landed is None:
                # Unknown: the saved file holds the record only if the commit landed.
                # discard_changes forgets the file signature first, so even if this
                # re-read fails the next transaction() adopts the saved file.
                try:
                    self.ws.discard_changes()
                except Exception:
                    log.warning(
                        "Could not re-read the project after a failed document command",
                        exc_info=True,
                    )
                self.project = self.ws.project
            raise
        # Invariant: the handler commits the same in-memory ``self.ws.project`` this record
        # was set on (ws.mutate / run_mutation / ProjectStore.commit, ws.save,
        # record_and_commit, HistoryManager undo/redo, save_merged). A handler that commits a
        # copy or replaces ``ws.project`` would drop the record without an error. Log it:
        # raising here would fail an edit that is already saved and skip its journal row.
        kept = self.ws.project.document_sync.last_command
        if kept is None or kept.command_id != command.command_id:
            log.error(
                "Document command %s was applied without its document_sync.last_command "
                "record; a crash before its journal row cannot be recovered (#575)",
                command.command_id,
            )
        return result


def notify_document_changed(project_path: str | Path) -> None:
    """Best-effort document fanout after MCP/CLI (or REST) project mutations."""
    try:
        DocumentSyncService.open(project_path).publish_document_changed()
    except OSError:
        return


def document_server_seq(project_path: str | Path) -> int:
    """Materialized document log seq, or 0 if the store is missing."""
    try:
        return _journal_server_seq(DocumentSyncService.open(project_path).store)
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
