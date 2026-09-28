"""Foreign-process journal write helpers shared by the sync test modules (#695).

Each helper opens a *fresh* ``SyncStore`` (its own sqlite connection) on an existing
project's journal and appends one row, then closes it, mimicking a write from another
process: the in-process hub never learns about it directly.
"""

from __future__ import annotations

from uuid import uuid4

from podcast_mcp.models import EpisodeProject
from podcast_mcp.services.document_sync.service import (
    EXTERNAL_MUTATE,
    EXTERNAL_MUTATE_CLIENT_ID,
    _empty_journal_snapshot,
    _journal_snapshot,
    document_db_path,
)
from podcast_mcp.services.session_sync.log import SyncStore
from podcast_mcp.services.session_sync.service import sync_db_path
from podcast_mcp.services.session_sync.snapshot import apply_command, empty_snapshot


def _foreign_session_write(project: EpisodeProject, sec: float) -> dict:
    """Append a ``SetPlayhead`` row on a fresh sync.db connection, as another process would."""
    store = SyncStore(sync_db_path(project), enforce_command_ids=True)
    try:
        row, _snap, _idempotent = store.append_and_apply(
            command_id=uuid4().hex,
            client_id="agent-control",
            client_seq=None,
            role="agent",
            type="SetPlayhead",
            payload={"playhead_sec": sec},
            causation_id=None,
            apply_fn=apply_command,
            empty_snap_fn=empty_snapshot,
        )
        return row
    finally:
        store.close()


def _foreign_document_write(project: EpisodeProject) -> dict:
    """Append an ``ExternalMutate`` row on a fresh document.db connection."""
    store = SyncStore(document_db_path(project))
    try:
        row, _snap, _idempotent = store.append_and_apply(
            command_id=uuid4().hex,
            client_id=EXTERNAL_MUTATE_CLIENT_ID,
            client_seq=None,
            role="agent",
            type=EXTERNAL_MUTATE,
            payload={"projection": "shell"},
            causation_id=None,
            apply_fn=_journal_snapshot,
            empty_snap_fn=_empty_journal_snapshot,
        )
        return row
    finally:
        store.close()
