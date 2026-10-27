"""Recently opened episodes on this machine: the Home list (#2295).

A small JSON most-recently-used list next to the other per-install config
(``PODCAST_CONFIG_DIR``, default ``~/.config/podcast_mcp``). It holds only
``{path, opened_at}`` entries, newest first, deduplicated by resolved path and
capped at :data:`RECENT_LIMIT`. The list is a convenience: a missing, unreadable
or corrupt file reads as empty, and a failed write never fails the open or create
that triggered it. Project state stays in the project file.

:func:`recent_project_cards` turns each entry into the card Home draws from a cheap
read of the project file (JSON only, no model validation, no media), so a long
list stays fast.
"""

from __future__ import annotations

import json
import logging
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from podcast_mcp import settings
from podcast_mcp.util.atomic_file import atomic_write

log = logging.getLogger(__name__)

RECENT_FILENAME = "recent_projects.json"
RECENT_LIMIT = 20

_LOCK = threading.Lock()


@dataclass(frozen=True)
class RecentEntry:
    path: str
    opened_at: str


def config_dir() -> Path:
    """Per-install config directory; ``PODCAST_CONFIG_DIR`` moves it (tests do)."""
    override = settings.text("PODCAST_CONFIG_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".config" / "podcast_mcp"


def recent_projects_path() -> Path:
    return config_dir() / RECENT_FILENAME


def _parse(raw: object) -> list[RecentEntry]:
    items = raw.get("projects") if isinstance(raw, dict) else None
    if not isinstance(items, list):
        return []
    entries: list[RecentEntry] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        path, opened_at = item.get("path"), item.get("opened_at")
        if not isinstance(path, str) or not path or path in seen:
            continue
        seen.add(path)
        entries.append(RecentEntry(path, opened_at if isinstance(opened_at, str) else ""))
    return entries[:RECENT_LIMIT]


def read_recent() -> list[RecentEntry]:
    """The saved list, newest first. Empty when the file is missing or corrupt."""
    try:
        raw = json.loads(recent_projects_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return _parse(raw)


def _write(entries: list[RecentEntry]) -> None:
    body = json.dumps(
        {"version": 1, "projects": [{"path": e.path, "opened_at": e.opened_at} for e in entries]},
        indent=2,
    )
    atomic_write(recent_projects_path(), lambda fh: fh.write(body.encode("utf-8")))


def record_recent(project_path: Path | str, *, now: datetime | None = None) -> None:
    """Move *project_path* to the front of the list. Never raises."""
    try:
        resolved = str(Path(project_path).expanduser().resolve())
        stamp = (now or datetime.now(UTC)).isoformat(timespec="seconds")
        with _LOCK:
            kept = [e for e in read_recent() if e.path != resolved]
            _write([RecentEntry(resolved, stamp), *kept][:RECENT_LIMIT])
    except OSError:
        log.warning("Cannot save the recent projects list at %s", recent_projects_path())


def forget_recent(project_path: Path | str) -> bool:
    """Drop one entry (Find replaced it, or the person removed it). True when it was listed."""
    try:
        resolved = str(Path(project_path).expanduser().resolve())
        with _LOCK:
            entries = read_recent()
            kept = [e for e in entries if e.path != resolved]
            if len(kept) == len(entries):
                return False
            _write(kept)
            return True
    except OSError:
        log.warning("Cannot save the recent projects list at %s", recent_projects_path())
        return False


def _stage_chip(
    *,
    tracks: int,
    running: bool,
    percent: int | None,
    failed: bool,
    pending: int,
    delivered_on: datetime | None,
) -> tuple[str, dict[str, str]]:
    """The stage a project opens on and its chip: the client's landing rule, in one place.

    Mirrors ``landingStage`` in ``gui/web/src/state/stageRoutes.ts``: nothing to edit or a
    running job lands on Prepare, undecided suggestions on Review, then Deliver once a master
    exists, otherwise Edit.
    """
    if running:
        text = "Processing" if percent is None else f"Processing {percent}%"
        return "prepare", {"text": text, "state": "running"}
    if failed:
        return "prepare", {"text": "Needs attention", "state": "failed"}
    if tracks == 0:
        return "prepare", {"text": "Not started", "state": "not-yet"}
    if pending > 0:
        return "review", {"text": f"Review {pending}", "state": "needs-you"}
    if delivered_on is not None:
        label = f"Delivered {delivered_on.day} {delivered_on:%b}"
        return "deliver", {"text": label, "state": "done"}
    return "edit", {"text": "Edited", "state": "done"}


def _count_pending(decisions: object) -> int:
    if not isinstance(decisions, list):
        return 0
    return sum(
        1
        for d in decisions
        if isinstance(d, dict)
        and d.get("type") in ("remove", "mute")
        and not d.get("applied")
        and d.get("review_required")
    )


def _count_media_tracks(tracks: object) -> int:
    if not isinstance(tracks, list):
        return 0
    return sum(1 for t in tracks if isinstance(t, dict) and t.get("media"))


def _delivered_on(render: Mapping[str, Any], project_file: Path) -> datetime | None:
    artifacts = render.get("artifacts")
    mastered = artifacts.get("mastered") if isinstance(artifacts, dict) else None
    if not mastered:
        return None
    try:
        stamp = (project_file.parent / str(mastered)).stat().st_mtime
    except OSError:
        stamp = project_file.stat().st_mtime
    return datetime.fromtimestamp(stamp).astimezone()


def _job_progress(jobs: Any, project_file: Path) -> tuple[bool, int | None]:
    """Whether a job runs on this project, and its percent when it reports a total."""
    if jobs is None:
        return False, None
    try:
        status = jobs.status(str(project_file))
    except Exception:  # a job-table fault must not hide the list
        log.exception("Cannot read job status for %s", project_file)
        return False, None
    if not status.get("running"):
        return False, None
    job = status.get("job") or {}
    total, current = job.get("total"), job.get("current")
    if isinstance(total, int) and total > 0 and isinstance(current, int):
        return True, max(0, min(100, round(100 * current / total)))
    return True, None


def _card(entry: RecentEntry, jobs: Any) -> dict[str, Any]:
    project_file = Path(entry.path)
    base: dict[str, Any] = {
        "path": entry.path,
        "name": project_file.parent.name or entry.path,
        "opened_at": entry.opened_at,
        "duration_sec": None,
        "edited_at": None,
        "peaks": [],
    }
    try:
        stat = project_file.stat()
    except OSError:
        return {
            **base,
            "stage": "edit",
            "chip": {"text": "Folder moved", "state": "needs-you"},
            "folder_missing": True,
        }
    base["edited_at"] = datetime.fromtimestamp(stat.st_mtime, UTC).isoformat(timespec="seconds")
    try:
        data = json.loads(project_file.read_text(encoding="utf-8"))
        meta = data.get("meta") or {}
        timeline = data.get("timeline") or {}
        render = data.get("render") or {}
        runs = render.get("pipeline_runs") or []
        steps = runs[-1].get("steps") if runs and isinstance(runs[-1], dict) else None
        last = steps[-1] if isinstance(steps, list) and steps else None
        failed = isinstance(last, dict) and last.get("status") in ("error", "failed")
        duration = timeline.get("duration_sec")
        running, percent = _job_progress(jobs, project_file)
        stage, chip = _stage_chip(
            tracks=_count_media_tracks(timeline.get("tracks")),
            running=running,
            percent=percent,
            failed=failed,
            pending=_count_pending((data.get("editorial") or {}).get("edit_decisions")),
            delivered_on=_delivered_on(render, project_file),
        )
    except (OSError, ValueError, AttributeError, TypeError):
        return {
            **base,
            "stage": "edit",
            "chip": {"text": "Needs attention", "state": "failed"},
            "folder_missing": False,
        }
    name = meta.get("name") if isinstance(meta, dict) else None
    return {
        **base,
        "name": name.strip() if isinstance(name, str) and name.strip() else base["name"],
        "duration_sec": float(duration) if isinstance(duration, int | float) else None,
        "stage": stage,
        "chip": chip,
        "folder_missing": False,
    }


def recent_project_cards(jobs: Any = None) -> list[dict[str, Any]]:
    """Card data for Home, newest first. *jobs* is the host job manager when one is running."""
    return [_card(entry, jobs) for entry in read_recent()]


def default_workspace_dir(name: str) -> Path:
    """``<workspace root>/<name>``, numbered " 2", " 3"... when that folder is taken."""
    root = settings.text("PODCAST_WORKSPACE_ROOT")
    base = Path(root).expanduser() if root else Path.home() / "ShareCut"
    clean = "".join(c for c in name if c not in '/\\:*?"<>|\0').strip(" .") or "episode"
    candidate = base / clean
    n = 2
    while candidate.exists():
        candidate = base / f"{clean} {n}"
        n += 1
    return candidate
