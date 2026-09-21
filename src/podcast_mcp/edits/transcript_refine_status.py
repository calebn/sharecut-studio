"""Transcript refine status artifact - hard agent gate after precorrect."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from podcast_mcp.edits.pipeline_unattended import is_unattended
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.atomic_json import load_json_object, write_json_atomic
from podcast_mcp.util.workspace_paths import workspace_relpath

STATUS_FILENAME = "transcript_refine_status.json"
RefineStatusValue = Literal["pending", "done", "waived"]
RefineMode = Literal["require", "waive_unattended", "off"]
RefineSource = Literal["agent", "user", "cli", "mcp", "unattended", "precorrect"]

GATE_HINT = (
    "Transcript refine is required before focus/tighten/NL edits. "
    "Run podcast-transcript-refine (whole-episode pass), then "
    "`podcast transcript refine-done` / `transcript_refine_done_tool`, "
    "or `podcast transcript refine-waive --reason ...` / `transcript_refine_waive_tool`."
)


class TranscriptRefineRequiredError(RuntimeError):
    """Raised when narrative edits run while refine status is pending/stale."""


def status_path(project: EpisodeProject) -> Path:
    return project.artifacts_dir() / STATUS_FILENAME


def precorrect_fingerprint(project: EpisodeProject) -> str:
    parts: list[str] = []
    for tr in sorted(project.transcripts, key=lambda t: t.track_id):
        for i, w in enumerate(tr.words or []):
            suppressed = bool(getattr(w, "suppressed", False))
            parts.append(f"{tr.track_id}:{i}:{w.text}:{suppressed}")
    raw = "|".join(parts)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def refine_mode_from_defaults(defaults: dict[str, Any] | None) -> RefineMode:
    cfg = (defaults or {}).get("analysis", {}).get("transcript_refine") or {}
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
    status: RefineStatusValue,
    source: RefineSource,
    notes: str | None = None,
    fingerprint: str | None = None,
) -> dict[str, Any]:
    fp = fingerprint if fingerprint is not None else precorrect_fingerprint(project)
    payload: dict[str, Any] = {
        "status": status,
        "updated_at": datetime.now(UTC).isoformat(),
        "source": source,
        "notes": notes or "",
        "precorrect_fingerprint": fp,
    }
    _write_status(project, payload)
    return payload


def mark_refine_pending(
    project: EpisodeProject,
    *,
    source: RefineSource = "precorrect",
    notes: str | None = None,
) -> dict[str, Any]:
    return write_status(
        project,
        status="pending",
        source=source,
        notes=notes or "reset after precorrect apply",
    )


def mark_refine_done(
    project: EpisodeProject,
    *,
    source: RefineSource = "agent",
    notes: str | None = None,
) -> dict[str, Any]:
    return write_status(project, status="done", source=source, notes=notes)


def mark_refine_waived(
    project: EpisodeProject,
    *,
    reason: str,
    source: RefineSource = "user",
) -> dict[str, Any]:
    reason = (reason or "").strip()
    if not reason:
        raise ValueError("refine waive requires a non-empty reason")
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
    return data.get("precorrect_fingerprint") == fingerprint


def status_is_clear(project: EpisodeProject) -> bool:
    return status_is_clear_payload(
        load_status(project),
        fingerprint=precorrect_fingerprint(project),
    )


def refine_status_report(
    project: EpisodeProject,
    *,
    defaults: dict[str, Any] | None = None,
) -> dict[str, Any]:
    mode = refine_mode_from_defaults(defaults)
    fp = precorrect_fingerprint(project)
    data = load_status(project)
    stored_fp = (data or {}).get("precorrect_fingerprint")
    status = (data or {}).get("status") or "pending"
    fingerprint_match = bool(data) and stored_fp == fp
    clear = status_is_clear_payload(data, fingerprint=fp)
    if data and status in ("done", "waived") and not fingerprint_match:
        effective = "pending"
        stale = True
    else:
        effective = status if data else "pending"
        stale = False
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
        "hint": None if clear or mode == "off" else GATE_HINT,
    }


def refresh_unattended_waiver(project: EpisodeProject) -> bool:
    """Refresh a stale waiver created by an unattended pipeline run.

    The full pipeline performs a second reconciliation after the refine gate,
    which can change suppression flags included in the precorrect fingerprint.
    Only that pipeline-owned waiver may follow those changes automatically;
    explicit pending, done, and user/agent waivers must remain stale so they
    still require an intentional refine decision.
    """
    data = load_status(project)
    fingerprint = precorrect_fingerprint(project)
    if not data:
        return False
    if data.get("status") != "waived" or data.get("source") != "unattended":
        return False
    if data.get("precorrect_fingerprint") == fingerprint:
        return False

    write_status(
        project,
        status="waived",
        source="unattended",
        notes=str(data.get("notes") or "unattended pipeline"),
        fingerprint=fingerprint,
    )
    return True


def assert_refine_clear(
    project: EpisodeProject,
    *,
    defaults: dict[str, Any] | None = None,
) -> None:
    mode = refine_mode_from_defaults(defaults)
    if mode == "off":
        return
    if status_is_clear(project):
        return
    raise TranscriptRefineRequiredError(GATE_HINT)


def require_or_waive_unattended(
    project: EpisodeProject,
    *,
    defaults: dict[str, Any] | None = None,
    unattended: bool | None = None,
) -> str:
    """Pipeline gate: return summary, or raise if interactive + pending."""
    mode = refine_mode_from_defaults(defaults)
    if mode == "off":
        return "skipped (analysis.transcript_refine.mode=off)"
    data = load_status(project)
    fp = precorrect_fingerprint(project)
    if status_is_clear_payload(data, fingerprint=fp):
        return f"{(data or {}).get('status', 'done')} (fingerprint ok)"

    unattended_now = is_unattended(flag=unattended, defaults=defaults)
    if mode == "waive_unattended" and unattended_now:
        mark_refine_waived(
            project,
            reason="unattended pipeline",
            source="unattended",
        )
        return "waived (unattended)"

    raise TranscriptRefineRequiredError(GATE_HINT)


def build_refine_brief(
    project: EpisodeProject,
    *,
    defaults: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from podcast_mcp.transcript_context import load_transcript_context

    report_path = project.artifacts_dir() / "transcript_precorrect_report.json"
    deferred: list[Any] = []
    garble: list[Any] = []
    if report_path.is_file():
        try:
            report = load_json_object(report_path) or {}
            deferred = list(report.get("deferred_queue") or [])
            garble = list(report.get("garble_hits") or [])
        except ValueError:
            pass

    ctx = load_transcript_context(project.workspace_path())
    low_conf = 0
    for tr in project.transcripts:
        for w in tr.words or []:
            if getattr(w, "suppressed", False):
                continue
            conf = getattr(w, "confidence", None)
            if conf is not None and float(conf) < 0.5:
                low_conf += 1

    combined = project.transcripts_dir() / "combined.json"
    return {
        "status": refine_status_report(project, defaults=defaults),
        "show_title": ctx.show_title,
        "guest_names": list(ctx.guest_names),
        "terms": list(ctx.terms)[:50],
        "deferred_queue_count": len(deferred),
        "deferred_queue_sample": deferred[:10],
        "garble_hits_count": len(garble),
        "garble_hits_sample": garble[:10],
        "low_confidence_open_words": low_conf,
        "combined_transcript_path": str(combined) if combined.is_file() else None,
        "precorrect_report_path": str(report_path) if report_path.is_file() else None,
        "track_ids": [t.track_id for t in project.transcripts],
        "word_counts": {t.track_id: len(t.words or []) for t in project.transcripts},
    }
