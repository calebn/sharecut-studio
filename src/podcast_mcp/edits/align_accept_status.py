"""Conversation-align accept gate — listen/nudge before later pipeline steps."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from podcast_mcp.edits.conversation_align import alignment_fingerprint
from podcast_mcp.edits.pipeline_unattended import is_unattended
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.atomic_json import load_json_object, write_json_atomic
from podcast_mcp.util.workspace_paths import workspace_relpath

STATUS_FILENAME = "align_accept_status.json"
AlignStatusValue = Literal["pending", "done", "waived"]
AlignMode = Literal["require", "waive_unattended", "off"]
AlignSource = Literal["agent", "user", "cli", "mcp", "unattended", "align"]

GATE_HINT = (
    "Conversation alignment needs review before stems/reconcile. "
    "Use podcast-align-audio: play --compare, nudge clips if needed, then "
    "`podcast align done` / `align_done_tool`, "
    "or `podcast align waive --reason ...` / `align_waive_tool`."
)


class AlignAcceptRequiredError(RuntimeError):
    """Raised when align accept is still pending/stale."""


def status_path(project: EpisodeProject) -> Path:
    return project.artifacts_dir() / STATUS_FILENAME


def align_mode_from_defaults(defaults: dict[str, Any] | None) -> AlignMode:
    cfg = (defaults or {}).get("align", {}).get("accept") or {}
    mode = str(cfg.get("mode", "waive_unattended")).strip().lower()
    if mode in ("require", "waive_unattended", "off"):
        return mode  # type: ignore[return-value]
    return "waive_unattended"


def load_status(project: EpisodeProject) -> dict[str, Any] | None:
    return load_json_object(status_path(project))


def _write_status(project: EpisodeProject, payload: dict[str, Any]) -> Path:
    return write_json_atomic(status_path(project), payload)


def write_status(
    project: EpisodeProject,
    *,
    status: AlignStatusValue,
    source: AlignSource,
    notes: str | None = None,
    fingerprint: str | None = None,
) -> dict[str, Any]:
    fp = fingerprint if fingerprint is not None else alignment_fingerprint(project)
    payload: dict[str, Any] = {
        "status": status,
        "updated_at": datetime.now(UTC).isoformat(),
        "source": source,
        "notes": notes or "",
        "align_fingerprint": fp,
    }
    _write_status(project, payload)
    return payload


def mark_align_pending(
    project: EpisodeProject,
    *,
    source: AlignSource = "align",
    notes: str | None = None,
) -> dict[str, Any]:
    return write_status(
        project,
        status="pending",
        source=source,
        notes=notes or "reset after align_tracks",
    )


def mark_align_done(
    project: EpisodeProject,
    *,
    source: AlignSource = "agent",
    notes: str | None = None,
) -> dict[str, Any]:
    return write_status(project, status="done", source=source, notes=notes)


def mark_align_waived(
    project: EpisodeProject,
    *,
    reason: str,
    source: AlignSource = "user",
) -> dict[str, Any]:
    reason = (reason or "").strip()
    if not reason:
        raise ValueError("align waive requires a non-empty reason")
    return write_status(project, status="waived", source=source, notes=reason)


def status_is_clear_payload(
    data: dict[str, Any] | None,
    *,
    fingerprint: str,
) -> bool:
    if not data:
        return False
    status = data.get("status")
    if status not in ("done", "waived"):
        return False
    return data.get("align_fingerprint") == fingerprint


def status_is_clear(project: EpisodeProject) -> bool:
    return status_is_clear_payload(
        load_status(project),
        fingerprint=alignment_fingerprint(project),
    )


def align_status_report(
    project: EpisodeProject,
    *,
    defaults: dict[str, Any] | None = None,
) -> dict[str, Any]:
    mode = align_mode_from_defaults(defaults)
    fp = alignment_fingerprint(project)
    data = load_status(project)
    stored_fp = (data or {}).get("align_fingerprint")
    status = (data or {}).get("status") or "pending"
    fingerprint_match = bool(data) and stored_fp == fp
    clear = status_is_clear_payload(data, fingerprint=fp)
    if data and status in ("done", "waived") and not fingerprint_match:
        effective = "pending"
        stale = True
    else:
        effective = status if data else "pending"
        stale = False

    artifact = project.artifacts_dir() / "alignment" / "conversation_align.json"
    plans: list[Any] = []
    if artifact.is_file():
        try:
            payload = load_json_object(artifact)
            plans = list((payload or {}).get("plans") or [])
        except ValueError:
            plans = []

    return {
        "status": effective,
        "stored_status": (data or {}).get("status"),
        "clear": clear,
        "stale": stale,
        "mode": mode,
        "fingerprint": fp,
        "stored_fingerprint": stored_fp,
        "fingerprint_match": fingerprint_match,
        "source": (data or {}).get("source"),
        "notes": (data or {}).get("notes") or "",
        "updated_at": (data or {}).get("updated_at"),
        "path": workspace_relpath(project, status_path(project)),
        "align_artifact": (workspace_relpath(project, artifact) if artifact.is_file() else None),
        "plans": plans,
        "hint": None if clear or mode == "off" else GATE_HINT,
    }


def require_or_waive_unattended(
    project: EpisodeProject,
    *,
    defaults: dict[str, Any] | None = None,
    unattended: bool | None = None,
) -> str:
    """Pipeline gate: return summary, or raise if interactive + pending."""
    mode = align_mode_from_defaults(defaults)
    if mode == "off":
        return "skipped (align.accept.mode=off)"
    data = load_status(project)
    fp = alignment_fingerprint(project)
    if status_is_clear_payload(data, fingerprint=fp):
        return f"{(data or {}).get('status', 'done')} (fingerprint ok)"

    unattended_now = is_unattended(flag=unattended, defaults=defaults)
    if mode == "waive_unattended" and unattended_now:
        mark_align_waived(
            project,
            reason="unattended pipeline",
            source="unattended",
        )
        return "waived (unattended)"

    raise AlignAcceptRequiredError(GATE_HINT)


def build_align_brief(
    project: EpisodeProject,
    *,
    defaults: dict[str, Any] | None = None,
) -> dict[str, Any]:
    report = align_status_report(project, defaults=defaults)
    meta = project.meta.ingest_alignment or {}
    return {
        "status": report,
        "ingest_alignment": {
            k: {
                "session_start_in_file_sec": v.session_start_in_file_sec,
                "content_align_sec": v.content_align_sec,
                "align_method": v.align_method,
            }
            for k, v in meta.items()
        },
        "clips": [
            {
                "id": c.id,
                "track_id": c.track_id,
                "source_start": c.source_start,
                "source_end": c.source_end,
                "timeline_start": c.timeline_start,
                "source_id": c.source_id,
            }
            for c in project.clips
        ],
        "play_compare_hint": ("podcast play --project … --compare --start 0 --end 90"),
    }
