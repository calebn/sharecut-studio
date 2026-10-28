"""The idle warm of the host's approval checks (#1958)."""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from podcast_mcp.services.app import ProjectWorkspace

log = logging.getLogger(__name__)
_warming: set[str] = set()
_warming_lock = threading.Lock()


def warm_pending_checks(ws: ProjectWorkspace) -> int:
    """Check the pending cuts now, as the host's Approve all will, so that approval reuses them.

    Nothing is saved. Uses the interactive intent the host approves with, which is part of
    the check; returns how many cuts were checked, 0 while the verdict cache is off (#1958).
    """
    from podcast_mcp.edits.cut_application import precompute_verdicts
    from podcast_mcp.edits.decisions import list_edit_decisions
    from podcast_mcp.models import CutIntent

    ids = [e.id for e in list_edit_decisions(ws.project, applied=False, review_required=True)]
    return precompute_verdicts(
        ws.project,
        ids,
        defaults=ws.effective_config(),
        application_intent=CutIntent.HUMAN_BOUNDARIES,
        yield_to_approval=True,
    )


def warm_in_background(project_path: Path) -> None:
    """Check the pending cuts in the background so the host's Approve all reuses the checks.

    One thread per project at a time, at a lower CPU priority, off the caller: the checks run
    on a copy and save nothing, they stop when an approval starts, and an approval that starts
    meanwhile simply checks for itself. Does nothing while the verdict cache is off.
    """
    from podcast_mcp.edits import verdict_cache

    if not verdict_cache.enabled():
        return
    key = str(project_path)
    with _warming_lock:
        if key in _warming:
            return
        _warming.add(key)

    def run() -> None:
        from podcast_mcp.services.app import ProjectWorkspace
        from podcast_mcp.services.document.edit import EditService
        from podcast_mcp.util.process import low_priority

        try:
            with low_priority():
                EditService(ProjectWorkspace.open(project_path)).warm_approval_checks()
        except Exception:  # advisory: an approval checks for itself
            log.warning("could not warm the approval checks", exc_info=True)
        finally:
            with _warming_lock:
                _warming.discard(key)

    threading.Thread(target=run, name="approval-check-warm", daemon=True).start()
