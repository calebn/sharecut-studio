"""Restorable revoke: park links for a window, restore them, then finalize their effects.

The registry owns the pending state (``pending_revokes``, see share_registry.py); this module
keeps the project sidecar and the irreversible effects (object-store and proxy deletes, a
room's session summary and land cleanup) in step with it. A lease in the registry lets one
sweeper claim a due group, and a crashed sweeper's lease lapses. A failure of the sidecar settle
or the room end leaves the row for a retry; the object-store and proxy deletes are best-effort
and are not retried. See docs/share-tokens.md § Restorable revoke.
"""

from __future__ import annotations

import logging
import math
import threading
from collections import defaultdict
from collections.abc import Callable, Iterable, Sequence
from datetime import datetime, timedelta
from typing import Any

from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.review_shares import (
    effective_review_version_id,
    list_shares,
    mark_shares_pending,
    settle_shares_pending,
    sidecar_share,
)
from podcast_mcp.services.collaboration.share_registry import (
    MAX_RESTORABLE_WINDOW,
    SHARE_KIND_RECORD,
    PendingRevoke,
    get_share_registry,
    lease_held,
    utc_now,
)
from podcast_mcp.services.media import (
    delete_all_proxies_if_unused,
    delete_object_store_object_if_unused,
)

log = logging.getLogger(__name__)

SWEEP_TIMER_GRACE_SEC = 1.0


def workspace_key(ws: ProjectWorkspace) -> str:
    return str(ws.project.workspace_path().resolve())


def clamp_window(seconds: float) -> float:
    if math.isnan(seconds):
        return 0.0
    return min(max(seconds, 0.0), MAX_RESTORABLE_WINDOW.total_seconds())


def group_of(ws: ProjectWorkspace, token: str) -> str | None:
    for row in get_share_registry().list_pending(workspace_key(ws)):
        if row["token"] == token:
            return row["group_id"]
    return None


def has_pending(ws: ProjectWorkspace, group_id: str) -> bool:
    """True while a record room of this id is parked (a review link's group never matches)."""
    return any(
        row["group_id"] == group_id and row["kind"] == SHARE_KIND_RECORD
        for row in get_share_registry().list_pending(workspace_key(ws))
    )


def start_sweep_timer(delay: float, sweep: Callable[[], object]) -> None:
    """Best-effort latency helper: a daemon timer that sweeps once the window has closed.

    Correctness never depends on it; every list, mint, restore and host start sweeps too.
    """
    timer = threading.Timer(delay, sweep)
    timer.daemon = True
    timer.start()


def park(
    ws: ProjectWorkspace,
    tokens: Sequence[str],
    *,
    group_id: str,
    window_sec: float,
    now: datetime | None = None,
) -> list[PendingRevoke]:
    pending = get_share_registry().begin_pending_revoke(
        tokens,
        project_workspace=workspace_key(ws),
        group_id=group_id,
        window=timedelta(seconds=clamp_window(window_sec)),
        now=now,
    )
    if pending:
        _flag_sidecar(ws, pending, now or utc_now())
    return pending


def _flag_sidecar(ws: ProjectWorkspace, pending: Sequence[PendingRevoke], moment: datetime) -> None:
    until = {str(p["id"]): str(p["restorable_until"]) for p in pending}
    key = workspace_key(ws)

    def still_pending() -> list[str]:
        return [
            str(p["id"])
            for p in get_share_registry().list_pending(key)
            if not lease_held(p, moment)
        ]

    try:
        mark_shares_pending(
            ws.project.workspace_path(),
            until,
            revoked_at=str(pending[0]["revoked_at"]),
            still_pending=still_pending,
        )
    except Exception:
        log.warning("could not flag pending revoke in the share sidecar", exc_info=True)


def restore(
    ws: ProjectWorkspace, group_id: str, *, now: datetime | None = None
) -> list[dict[str, Any]]:
    """Put a pending group back. ``[]`` when nothing is pending; refusals raise."""
    snapshots = get_share_registry().restore_group(
        group_id, project_workspace=workspace_key(ws), now=now
    )
    if snapshots:
        _settle_sidecar(ws, [str(s["id"]) for s in snapshots], restored=True)
    return snapshots


def _settle_sidecar(ws: ProjectWorkspace, share_ids: Sequence[str], *, restored: bool) -> None:
    try:
        settle_shares_pending(ws.project.workspace_path(), share_ids, restored=restored)
    except Exception:
        log.warning("could not settle pending revoke in the share sidecar", exc_info=True)


def sweep(ws: ProjectWorkspace, *, now: datetime | None = None) -> int:
    """Heal crash states, then finalize every due group of this workspace. Returns groups done."""
    reconcile(ws, now=now or utc_now())
    claimed = get_share_registry().claim_due(now=now, project_workspace=workspace_key(ws))
    return _finalize_all(ws, claimed)


def finalize_now(ws: ProjectWorkspace, group_id: str, *, now: datetime | None = None) -> list[str]:
    """Finalize a pending group before its window ends. A failed effect stays leased for a sweep."""
    claimed = get_share_registry().claim_due(
        now=now, project_workspace=workspace_key(ws), group_id=group_id, force=True
    )
    if claimed:
        try:
            _finalize_group(ws, group_id, claimed)
        except Exception:
            log.exception(
                "finalizing revoked shares %s failed; a sweep retries", [r["id"] for r in claimed]
            )
    return [str(row["token"]) for row in claimed]


def reconcile(ws: ProjectWorkspace, *, now: datetime) -> None:
    """Make the sidecar agree with the registry after a crash between the two writes."""
    key = workspace_key(ws)
    registry = get_share_registry()
    sidecar = {str(row.get("id")): row for row in list_shares(ws.project)}
    pending = registry.list_pending(key)
    active_ids = {str(row["id"]) for row in registry.list_active_for_workspace(key)}
    _reflag_unmarked(ws, pending, sidecar, now)
    pending_ids = {str(p["id"]) for p in pending}
    flagged = [
        share_id
        for share_id, row in sidecar.items()
        if row.get("restorable_until") and share_id not in pending_ids
    ]
    back = [share_id for share_id in flagged if share_id in active_ids]
    ended = [share_id for share_id in flagged if share_id not in active_ids]
    if back:
        _settle_sidecar(ws, back, restored=True)
    if ended:
        _settle_sidecar(ws, ended, restored=False)


def _reflag_unmarked(
    ws: ProjectWorkspace,
    pending: Sequence[PendingRevoke],
    sidecar: dict[str, dict[str, Any]],
    now: datetime,
) -> None:
    unmarked = [
        p
        for p in pending
        if str(p["id"]) in sidecar
        and not lease_held(p, now)
        and sidecar[str(p["id"])].get("restorable_until") != p["restorable_until"]
    ]
    if unmarked:
        _flag_sidecar(ws, unmarked, now)


def _finalize_all(ws: ProjectWorkspace, claimed: Sequence[PendingRevoke]) -> int:
    groups: dict[str, list[PendingRevoke]] = defaultdict(list)
    for row in claimed:
        groups[str(row["group_id"])].append(row)
    done = 0
    for group_id, rows in groups.items():
        try:
            _finalize_group(ws, group_id, rows)
            done += 1
        except Exception:
            log.exception(
                "finalizing revoked shares %s failed; retrying later", [r["id"] for r in rows]
            )
    return done


def _finalize_group(ws: ProjectWorkspace, group_id: str, rows: Sequence[PendingRevoke]) -> None:
    settle_shares_pending(
        ws.project.workspace_path(), [str(row["id"]) for row in rows], restored=False
    )
    reviews = [row for row in rows if row["kind"] != SHARE_KIND_RECORD]
    if reviews:
        delete_review_effects(ws, [_review_version_id(ws, row) for row in reviews])
    if any(row["kind"] == SHARE_KIND_RECORD for row in rows):
        end_room(ws, group_id)
    get_share_registry().complete_finalize([str(row["token"]) for row in rows])


def _review_version_id(ws: ProjectWorkspace, row: PendingRevoke) -> str:
    side = sidecar_share(ws.project.workspace_path(), str(row["id"])) or {}
    return effective_review_version_id(ws.project, {**row["snapshot"], **side})


def delete_review_effects(ws: ProjectWorkspace, version_ids: Iterable[str]) -> None:
    for version_id in filter(None, version_ids):
        try:
            delete_object_store_object_if_unused(ws, version_id)
        except Exception:
            log.warning(
                "object storage cleanup failed for review version %s", version_id, exc_info=True
            )
    try:
        delete_all_proxies_if_unused(ws)
    except Exception:
        log.warning("Proxy object storage cleanup failed on share revoke", exc_info=True)


def end_room(ws: ProjectWorkspace, session_id: str) -> None:
    from podcast_mcp.services.record import (
        persist_session_summary,
        purge_session_land_rollbacks,
        release_session_land_lock,
        remove_session_land_lock_file,
    )

    persist_session_summary(ws.project, session_id)
    # Purge first: it takes the land lock, which the release and file removal drop.
    purge_session_land_rollbacks(ws.project, session_id)
    release_session_land_lock(session_id)
    remove_session_land_lock_file(ws.project.workspace_path(), session_id)
