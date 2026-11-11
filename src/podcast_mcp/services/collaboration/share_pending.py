"""Restorable revoke: park links for a window, restore them, then finalize their effects.

The registry owns the pending state (``pending_revokes``, see share_registry.py); this module
keeps the project sidecar and the irreversible effects (object-store and proxy deletes, a
room's session summary and land cleanup) in step with it. Finalize is at-least-once: a lease
in the registry lets one sweeper claim a due group, and a crashed sweeper's lease lapses.
See docs/share-tokens.md § Restorable.
"""

from __future__ import annotations

import logging
import threading
from collections import defaultdict
from collections.abc import Callable, Sequence
from datetime import UTC, datetime, timedelta
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
    SHARE_KIND_RECORD,
    _parse_iso,
    get_share_registry,
)
from podcast_mcp.services.media import (
    delete_all_proxies_if_unused,
    delete_object_store_object_if_unused,
)

log = logging.getLogger(__name__)

SWEEP_TIMER_GRACE_SEC = 1.0


def utc_now() -> datetime:
    return datetime.now(UTC)


def workspace_key(ws: ProjectWorkspace) -> str:
    return str(ws.project.workspace_path().resolve())


def start_sweep_timer(delay: float, sweep: Callable[[], None]) -> None:
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
    now: datetime,
) -> list[dict[str, Any]]:
    """Revoke at once but restorably. Returns the pending rows (empty if none was active)."""
    pending = get_share_registry().begin_pending_revoke(
        tokens, group_id=group_id, window=timedelta(seconds=window_sec), now=now
    )
    if pending:
        _flag_sidecar(ws, pending, revoked_at=now.isoformat())
    return pending


def _flag_sidecar(
    ws: ProjectWorkspace, pending: Sequence[dict[str, Any]], *, revoked_at: str
) -> None:
    until = {str(p["id"]): str(p["restorable_until"]) for p in pending}
    try:
        mark_shares_pending(ws.project.workspace_path(), until, revoked_at=revoked_at)
    except Exception:
        log.warning("could not flag pending revoke in the share sidecar", exc_info=True)


def restore(ws: ProjectWorkspace, group_id: str, *, now: datetime) -> list[dict[str, Any]]:
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
    moment = now or utc_now()
    reconcile(ws, now=moment)
    claimed = get_share_registry().claim_due(now=moment, project_workspace=workspace_key(ws))
    return _finalize_all(ws, claimed)


def finalize_now(ws: ProjectWorkspace, group_id: str, *, now: datetime | None = None) -> list[str]:
    """Finalize one pending group before its window ends. Returns its tokens (empty if none)."""
    claimed = get_share_registry().claim_due(
        now=now or utc_now(), project_workspace=workspace_key(ws), group_id=group_id, force=True
    )
    if claimed:
        _finalize_group(ws, group_id, claimed)
    return [str(row["token"]) for row in claimed]


def reconcile(ws: ProjectWorkspace, *, now: datetime) -> None:
    """Make the sidecar agree with the registry after a crash between the two writes."""
    key = workspace_key(ws)
    registry = get_share_registry()
    pending = registry.list_pending(key)
    sidecar = {str(row.get("id")): row for row in list_shares(ws.project)}
    _reflag_unmarked(ws, pending, sidecar, now)
    pending_ids = {str(p["id"]) for p in pending}
    stale = [
        str(live["id"])
        for live in registry.list_active_for_workspace(key)
        if str(live["id"]) not in pending_ids and _flagged_pending(sidecar.get(str(live["id"])))
    ]
    if stale:
        _settle_sidecar(ws, stale, restored=True)


def _flagged_pending(row: dict[str, Any] | None) -> bool:
    return row is not None and bool(row.get("revoked")) and bool(row.get("restorable_until"))


def _reflag_unmarked(
    ws: ProjectWorkspace,
    pending: Sequence[dict[str, Any]],
    sidecar: dict[str, dict[str, Any]],
    now: datetime,
) -> None:
    unmarked = [
        p
        for p in pending
        if str(p["id"]) in sidecar
        and not _leased(p, now)
        and sidecar[str(p["id"])].get("restorable_until") != p["restorable_until"]
    ]
    if unmarked:
        _flag_sidecar(ws, unmarked, revoked_at=str(unmarked[0]["revoked_at"]))


def _leased(row: dict[str, Any], now: datetime) -> bool:
    held = _parse_iso(row.get("finalize_lease_until"))
    return held is not None and held > now


def _finalize_all(ws: ProjectWorkspace, claimed: Sequence[dict[str, Any]]) -> int:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in claimed:
        groups[str(row["group_id"])].append(row)
    done = 0
    for group_id, rows in groups.items():
        try:
            _finalize_group(ws, group_id, rows)
            done += 1
        except Exception:
            log.exception("finalizing revoked share group %s failed; retrying later", group_id)
    return done


def _finalize_group(ws: ProjectWorkspace, group_id: str, rows: Sequence[dict[str, Any]]) -> None:
    _settle_sidecar(ws, [str(row["id"]) for row in rows], restored=False)
    reviews = [row for row in rows if row["kind"] != SHARE_KIND_RECORD]
    for row in reviews:
        _delete_review_media(ws, row)
    if reviews:
        _delete_proxies(ws)
    if len(reviews) != len(rows):
        _end_room(ws, group_id)
    get_share_registry().complete_finalize([str(row["token"]) for row in rows])


def _delete_review_media(ws: ProjectWorkspace, row: dict[str, Any]) -> None:
    snapshot = row["snapshot"]
    side = sidecar_share(ws.project.workspace_path(), str(row["id"])) or {}
    version_id = effective_review_version_id(ws.project, {**snapshot, **side})
    if not version_id:
        return
    try:
        delete_object_store_object_if_unused(ws, version_id)
    except Exception:
        log.warning(
            "object storage cleanup failed for review version %s", version_id, exc_info=True
        )


def _delete_proxies(ws: ProjectWorkspace) -> None:
    try:
        delete_all_proxies_if_unused(ws)
    except Exception:
        log.warning("Proxy object storage cleanup failed on share revoke", exc_info=True)


def _end_room(ws: ProjectWorkspace, session_id: str) -> None:
    from podcast_mcp.services.record import (
        persist_session_summary,
        purge_session_land_rollbacks,
        release_session_land_lock,
        remove_session_land_lock_file,
    )

    persist_session_summary(ws.project, session_id)
    purge_session_land_rollbacks(ws.project, session_id)
    release_session_land_lock(session_id)
    remove_session_land_lock_file(ws.project.workspace_path(), session_id)
