"""Read model of record sessions, open and ended, for the host Record stage."""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from pathlib import Path
from typing import Any

from podcast_mcp.models import EpisodeProject, workspace_artifacts_dir
from podcast_mcp.services.collaboration import SHARE_KIND_RECORD, list_shares, share_is_usable
from podcast_mcp.services.record.landing_math import record_source_prefix, session_landed_before
from podcast_mcp.services.record.service import RecordSessionService
from podcast_mcp.services.record.state import TakeState, recording_ms_at
from podcast_mcp.util.atomic_json import write_json_atomic

log = logging.getLogger(__name__)
_SUMMARIES_NAME = "record_session_summaries.json"
_summaries_lock = threading.Lock()

_SESSION_ID = re.compile(r"^rec-([0-9a-f]{12})-")


def _session_rows(project: EpisodeProject) -> dict[str, list[dict[str, Any]]]:
    rows: dict[str, list[dict[str, Any]]] = {}
    for row in list_shares(project):
        sid = str(row.get("session_id") or "")
        if sid and str(row.get("kind") or "") == SHARE_KIND_RECORD:
            rows.setdefault(sid, []).append(row)
    return rows


def _landed_ids(project: EpisodeProject) -> set[str]:
    ids = {row.session_id for row in project.editorial.record_sessions}
    for clip in project.clips:
        found = _SESSION_ID.match(clip.source_id or "")
        if found:
            ids.add(found.group(1))
    return ids


def _snapshot(project: EpisodeProject, session_id: str) -> tuple[dict[str, Any], dict[str, str]]:
    """The session's snapshot and track choices; empty when the store holds another session."""
    try:
        service = RecordSessionService(project, session_id=session_id)
        snap = service.snapshot()
        choices = service.track_choices()
    except Exception:
        return {}, {}
    return (snap, choices) if snap.get("session_id") == session_id else ({}, {})


def _landed_tracks(project: EpisodeProject, session_id: str, participant_id: str) -> set[str]:
    prefix = record_source_prefix(session_id)
    return {
        clip.track_id
        for clip in project.clips
        if (clip.source_id or "").startswith(prefix)
        and re.match(rf"\d+-{re.escape(participant_id)}-", (clip.source_id or "")[len(prefix) :])
    }


def _track_of(
    project: EpisodeProject, session_id: str, participant_id: str, fallback: str | None
) -> str | None:
    """Where the participant's landed clips are; the fallback only when none have landed.

    Clips can be moved after landing, so a track choice or a saved summary is never
    preferred over them. Clips on several tracks report None.
    """
    tracks = _landed_tracks(project, session_id, participant_id)
    if tracks:
        return next(iter(tracks)) if len(tracks) == 1 else None
    return fallback


def _summaries_path(workspace: Path) -> Path:
    return workspace_artifacts_dir(workspace) / _SUMMARIES_NAME


def _read_summaries(workspace: Path) -> dict[str, dict[str, Any]] | None:
    """The saved summaries; empty when there is no file, None when the file is unreadable."""
    path = _summaries_path(workspace)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    return {sid: row for sid, row in data.items() if isinstance(row, dict)}


def _load_summaries(workspace: Path) -> dict[str, dict[str, Any]]:
    return _read_summaries(workspace) or {}


def persist_session_summary(project: EpisodeProject, session_id: str) -> None:
    """Keep a session's takes and participants before the single-session store forgets them.

    Nothing is saved for a session the store holds no takes or participants for, nor while its
    take is still running (a later save, once it stops, has the whole take). The first
    summary wins, so a repeated call never replaces it. An unreadable sidecar is renamed aside,
    never overwritten. Never raises.
    """
    try:
        snap, choices = _snapshot(project, session_id)
        if not snap or not (snap.get("takes") or snap.get("participants")):
            return
        if snap.get("state") in ("recording", "paused"):
            return
        workspace = project.workspace_path()
        with _summaries_lock:
            rows = _read_summaries(workspace)
            if rows is None:
                path = _summaries_path(workspace)
                aside = path.with_name(f"{path.name}.corrupt-{time.time_ns()}")
                path.replace(aside)
                log.warning("unreadable record session summaries kept at %s", aside)
                rows = {}
            if session_id in rows:
                return
            rows[session_id] = {
                "session_id": session_id,
                "takes": _takes(snap),
                "participants": _participants(project, session_id, snap, choices),
            }
            write_json_atomic(_summaries_path(workspace), rows, ensure_ascii=False)
    except Exception:
        log.exception("could not persist the summary of record session %s", session_id)


def _takes(snap: dict[str, Any]) -> list[dict[str, int]]:
    out = []
    for raw in snap.get("takes") or []:
        take = TakeState.model_validate(raw)
        wall = take.stopped_wall_ms or int(snap.get("server_time_ns") or 0) // 1_000_000
        out.append(
            {"take_index": take.take_index, "recording_ms": recording_ms_at(take, wall_ms=wall)}
        )
    return out


def _participants(
    project: EpisodeProject, session_id: str, snap: dict[str, Any], choices: dict[str, str]
) -> list[dict[str, Any]]:
    return [
        {
            "participant_id": person["participant_id"],
            "display_name": person["display_name"],
            "role": person["role"],
            "track_id": _track_of(
                project, session_id, person["participant_id"], choices.get(person["participant_id"])
            ),
        }
        for person in snap.get("participants") or []
        if not person.get("removed")
    ]


def _ended_at(rows: list[dict[str, Any]]) -> str | None:
    stamps = [str(row["revoked_at"]) for row in rows if row.get("revoked_at")]
    return max(stamps) if stamps and not any(share_is_usable(row) for row in rows) else None


def list_record_sessions(project: EpisodeProject) -> list[dict[str, Any]]:
    """Every record session with a room or a landing, oldest to newest. Never writes.

    Ordered by the first link's creation time; a session with no link row sorts first, by number.
    """
    rows = _session_rows(project)
    landed_ids = _landed_ids(project)
    summaries = _load_summaries(project.workspace_path())
    numbers = {row.session_id: row for row in project.editorial.record_sessions}
    out: list[tuple[tuple[str, int], dict[str, Any]]] = []
    for sid in rows.keys() | landed_ids:
        snap, choices = _snapshot(project, sid)
        saved = summaries.get(sid) or {}
        takes = _takes(snap) if snap else list(saved.get("takes") or [])
        people = (
            _participants(project, sid, snap, choices)
            if snap
            else [
                {
                    **p,
                    "track_id": _track_of(project, sid, p["participant_id"], p.get("track_id")),
                }
                for p in saved.get("participants") or []
            ]
        )
        stored = numbers.get(sid)
        share_rows = rows.get(sid, [])
        target = stored.target_kind if stored else (snap.get("target") or {}).get("kind")
        item = {
            "session_id": sid,
            "number": stored.number if stored else None,
            "state": "open" if any(share_is_usable(row) for row in share_rows) else "ended",
            "target_kind": target,
            "takes": takes,
            "participants": people,
            "landed": sid in landed_ids or session_landed_before(project, sid),
            "ended_at": _ended_at(share_rows),
        }
        created = min((str(row.get("created_at") or "") for row in share_rows), default="")
        out.append(((created, stored.number if stored else 0), item))
    return [item for _key, item in sorted(out, key=lambda pair: (*pair[0], pair[1]["session_id"]))]
