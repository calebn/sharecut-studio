"""Recently opened episodes on this machine: the Home list (#2295).

A small JSON most-recently-used list next to the other per-install config
(``PODCAST_CONFIG_DIR``, default ``~/.config/podcast_mcp``). It holds only
``{path, opened_at}`` entries, newest first, deduplicated by resolved path and
capped at :data:`RECENT_LIMIT`. The list is a convenience: a missing, unreadable
or corrupt file reads as empty, an entry whose path JSON cannot carry is dropped, and a
failed write never fails the open or create that triggered it. Project state stays in the project file.

:func:`recent_project_cards` turns each entry into the card Home draws from a cheap
read of the project file (JSON only, no model validation, no media). The parsed summary
is cached per file by its revision stamp plus ctime, so a list that has not changed since
the last read parses nothing; only the job state and the delivered date
are looked up per request. The list is read-modify-written under a process lock only: two
processes that record at once can drop each other's entry, but the file is never left half
written.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from podcast_mcp import settings
from podcast_mcp.util.atomic_file import atomic_write
from podcast_mcp.util.coded_error import CodedError
from podcast_mcp.util.fingerprint import file_stamp

log = logging.getLogger(__name__)

RECENT_FILENAME = "recent_projects.json"
RECENT_LIMIT = 20

_WINDOWS_RESERVED = frozenset(
    {
        "CON",
        "PRN",
        "AUX",
        "NUL",
        *(f"COM{n}" for n in range(1, 10)),
        *(f"LPT{n}" for n in range(1, 10)),
    }
)
_LONE_SURROGATE = re.compile("[\ud800-\udfff]")
_LOCK = threading.Lock()
_RESERVE_LOCK = threading.Lock()
_SUMMARIES: dict[str, tuple[tuple[int, int, int, int, int], _Summary | None]] = {}
_SUMMARIES_LOCK = threading.Lock()


@dataclass(frozen=True)
class RecentEntry:
    path: str
    opened_at: str


@dataclass(frozen=True)
class _Summary:
    """What one project file contributes to its card; running and percent are not in it."""

    name: str | None
    duration_sec: float | None
    tracks: int
    failed: bool
    pending: int
    mastered: str | None


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
        if resolved != _clean(resolved):
            return
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
    except (OSError, ValueError):
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
    """The stage a card opens on and its chip: the Home rule, decided here.

    A card carries this stage into the open, so it wins over ``landingStage`` in
    ``gui/web/src/state/stageRoutes.ts`` (which opens a project from anywhere else and also
    honors the last stage the person used). A running job or a failed run lands on Prepare,
    nothing to edit is Prepare, undecided suggestions are Review, a master on disk is Deliver,
    otherwise Edit. Deliver and failed are deliberate: the chip names where the work stands.
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


def _delivered_on(mastered: str | None, project_file: Path) -> datetime | None:
    if not mastered:
        return None
    parent = project_file.parent
    try:
        target = (parent / mastered).resolve()
        if target.is_relative_to(parent.resolve()):
            if not target.is_file():
                return None
            stamp = target.stat().st_mtime
        else:
            stamp = project_file.stat().st_mtime
    except (OSError, ValueError):
        try:
            stamp = project_file.stat().st_mtime
        except OSError:
            return None
    return datetime.fromtimestamp(stamp).astimezone()


def _job_progress(jobs: Any, project_file: Path) -> tuple[bool, int | None]:
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


def _summarize(project_file: Path) -> _Summary:
    data = json.loads(project_file.read_text(encoding="utf-8"))
    meta = data.get("meta") or {}
    timeline = data.get("timeline") or {}
    render = data.get("render") or {}
    runs = render.get("pipeline_runs") or []
    last_run = runs[-1] if isinstance(runs, list) and runs else None
    steps = last_run.get("steps") if isinstance(last_run, dict) else None
    last = steps[-1] if isinstance(steps, list) and steps else None
    artifacts = render.get("artifacts")
    mastered = artifacts.get("mastered") if isinstance(artifacts, dict) else None
    duration = timeline.get("duration_sec")
    name = meta.get("name") if isinstance(meta, dict) else None
    return _Summary(
        name=name.strip() if isinstance(name, str) and name.strip() else None,
        duration_sec=_finite(duration),
        tracks=_count_media_tracks(timeline.get("tracks")),
        failed=isinstance(last, dict) and last.get("status") in ("error", "failed"),
        pending=_count_pending((data.get("editorial") or {}).get("edit_decisions")),
        mastered=str(mastered) if mastered else None,
    )


def _finite(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    try:
        number = float(value)
    except OverflowError:
        return None
    return number if math.isfinite(number) else None


def _summary_for(project_file: Path, stat: os.stat_result) -> _Summary | None:
    key = str(project_file)
    stamp = file_stamp(stat)
    signature = (*stamp.revision, stamp.ctime_ns)  # utime cannot set ctime, so inode reuse shows
    with _SUMMARIES_LOCK:
        cached = _SUMMARIES.get(key)
    if cached is not None and cached[0] == signature:
        return cached[1]
    try:
        summary: _Summary | None = _summarize(project_file)
    except OSError:
        log.warning("Cannot read %s for the recent list", project_file, exc_info=True)
        return None
    except Exception:  # one bad project file must not fail the whole list
        log.warning("Cannot summarize %s for the recent list", project_file, exc_info=True)
        summary = None
    with _SUMMARIES_LOCK:
        _SUMMARIES[key] = (signature, summary)
    return summary


def _prune_summaries(entries: list[RecentEntry]) -> None:
    keep = {e.path for e in entries}
    with _SUMMARIES_LOCK:
        for stale in [k for k in _SUMMARIES if k not in keep]:
            del _SUMMARIES[stale]


def _attention_card(base: dict[str, Any]) -> dict[str, Any]:
    return {
        **base,
        "stage": "edit",
        "chip": {"text": "Needs attention", "state": "failed"},
        "folder_missing": False,
    }


def _clean(text: str) -> str:
    return _LONE_SURROGATE.sub("\ufffd", text)


def _card(entry: RecentEntry, jobs: Any) -> dict[str, Any]:
    project_file = Path(entry.path)
    base: dict[str, Any] = {
        "path": entry.path,
        "name": _clean(project_file.parent.name or entry.path),
        "opened_at": _clean(entry.opened_at),
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
    try:
        base["edited_at"] = datetime.fromtimestamp(stat.st_mtime, UTC).isoformat(timespec="seconds")
        summary = _summary_for(project_file, stat)
        if summary is None:
            return _attention_card(base)
        running, percent = _job_progress(jobs, project_file)
        stage, chip = _stage_chip(
            tracks=summary.tracks,
            running=running,
            percent=percent,
            failed=summary.failed,
            pending=summary.pending,
            delivered_on=_delivered_on(summary.mastered, project_file),
        )
    except Exception:  # one card must never fail the list
        log.exception("Cannot build the recent card for %s", entry.path)
        return _attention_card(base)
    return {
        **base,
        "name": _clean(summary.name) if summary.name else base["name"],
        "duration_sec": summary.duration_sec,
        "stage": stage,
        "chip": chip,
        "folder_missing": False,
    }


def recent_project_cards(jobs: Any = None) -> list[dict[str, Any]]:
    """Card data for Home, newest first. *jobs* is the host job manager when one is running."""
    with _LOCK:
        entries = read_recent()
        kept = [e for e in entries if e.path == _clean(e.path)]
        if len(kept) != len(entries):
            try:
                _write(kept)
            except OSError:
                log.warning("Cannot save the recent projects list at %s", recent_projects_path())
    entries = kept
    _prune_summaries(entries)
    return [_card(entry, jobs) for entry in entries]


def default_workspace_dir(name: str) -> Path:
    """Reserve ``<workspace root>/<name>``, numbered " 2", " 3"... when that folder is taken.

    The folder is created here (``mkdir`` without ``exist_ok``), so two creates in flight
    cannot be handed the same one. A name Windows reserves for a device (``con``, ``nul.wav``,
    ``com1``) is refused with ``project_name_reserved``, never renamed.
    """
    root = settings.text("PODCAST_WORKSPACE_ROOT")
    base = (Path(root).expanduser() if root else Path.home() / "ShareCut").resolve()
    clean = "".join(c for c in name if c not in '/\\:*?"<>|\0').strip(" .") or "episode"
    word = clean.split(".", 1)[0]
    if word.upper() in _WINDOWS_RESERVED:
        # The reserved word, not the name: the rest of the name may hold a lone surrogate.
        raise CodedError(
            f'Windows can\'t use "{word}" as a folder name. Choose another episode name.',
            code="project_name_reserved",
        )
    with _RESERVE_LOCK:
        base.mkdir(parents=True, exist_ok=True)
        n = 1
        while True:
            candidate = base / (clean if n == 1 else f"{clean} {n}")
            try:
                os.mkdir(candidate)
            except FileExistsError:
                n += 1
                continue
            return candidate
