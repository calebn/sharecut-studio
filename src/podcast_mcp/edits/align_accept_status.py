"""Conversation-align accept gate — listen/nudge before later pipeline steps."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from podcast_mcp.edits.clips_ops import clips_for_track
from podcast_mcp.edits.conversation_align import (
    LOCKED_METHODS,
    UNCONFIRMED_HOLD,
    align_artifact_path,
    alignment_fingerprint,
    large_move_sec_from_defaults,
)
from podcast_mcp.edits.pipeline_unattended import is_unattended
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import EpisodeProject, TrackRole
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


def _align_artifact_or_error(project: EpisodeProject) -> tuple[dict[str, Any] | None, str | None]:
    """(payload, error). Missing -> (None, None); present but unreadable -> (None, message)."""
    path = align_artifact_path(project)
    if not path.is_file():
        return None, None
    try:
        return load_json_object(path), None
    except ValueError:
        rel = workspace_relpath(project, path)
        return None, f"Align artifact {rel} is unreadable; re-run align_tracks."


def load_align_artifact(project: EpisodeProject) -> dict[str, Any] | None:
    """Lenient read for status/brief (unreadable reads as absent; gates use the strict read)."""
    return _align_artifact_or_error(project)[0]


def align_threshold_sec(payload: dict[str, Any] | None, defaults: dict[str, Any] | None) -> float:
    """``large_move_sec`` the scorer ran with (artifact), else ``align.large_move_sec``."""
    if payload and payload.get("large_move_sec") is not None:
        return float(payload["large_move_sec"])
    return large_move_sec_from_defaults(defaults)


def _plan_move_sec(p: dict[str, Any]) -> float:
    """Signed move a plan row stands for: the scorer candidate for ``unconfirmed_hold``."""
    if p.get("method") == UNCONFIRMED_HOLD and p.get("candidate_offset_sec") is not None:
        return float(p["candidate_offset_sec"])
    return float(p.get("offset_sec") or 0.0)


def large_align_moves(plans: list[dict[str, Any]], *, threshold: float) -> list[dict[str, Any]]:
    """Unlocked plan rows whose move (or held candidate) exceeds ``threshold`` seconds."""
    skip = LOCKED_METHODS | {"reference"}
    return [p for p in plans if p.get("method") not in skip and abs(_plan_move_sec(p)) > threshold]


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

    artifact = align_artifact_path(project)
    payload = load_align_artifact(project)
    plans = list((payload or {}).get("plans") or [])
    threshold = align_threshold_sec(payload, defaults)

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
        "large_move_sec": threshold,
        "large_moves": large_align_moves(plans, threshold=threshold),
        "hint": None if clear or mode == "off" else GATE_HINT,
    }


def _accept_state(project: EpisodeProject) -> tuple[bool, str]:
    """(accepted by a person, phrase completing 'and the alignment ...' for QC messages)."""
    data = load_status(project)
    if data is None:
        return False, "was not accepted by a person (align status: missing)"
    status = data.get("status")
    if status == "waived" and data.get("source") == "unattended":
        return False, "was not accepted by a person (align status: waived by unattended)"
    if status_is_clear_payload(data, fingerprint=alignment_fingerprint(project)):
        return True, ""
    if status in ("done", "waived"):
        return False, f"accept is stale (alignment changed since `align {status}`)"
    return False, f"was not accepted by a person (align status: {status})"


def _drift_checkable(payload: dict[str, Any] | None) -> bool:
    return (
        payload is not None
        and not payload.get("skipped_reason")
        and bool(payload.get("reference_track_id"))
    )


def _unexplained_drift(
    project: EpisodeProject, payload: dict[str, Any], *, threshold: float
) -> tuple[dict[str, float], dict[str, float]]:
    """(max |relative drift| per non-reference dialogue track, tracks whose drift needs a person).

    A locked (hold/manual) clip is exempt while it still sits where align locked it
    (relative drift within ``threshold`` of ``-offset_sec``); moved after align, it counts.
    """
    ref_id = str(payload["reference_track_id"])
    rows = {(str(p.get("track_id")), str(p.get("clip_id"))): p for p in payload.get("plans") or []}
    st = SessionTimeline(project)
    tracks: dict[str, float] = {}
    flagged: dict[str, float] = {}
    for t in project.tracks:
        if t.role != TrackRole.DIALOGUE or t.id == ref_id:
            continue
        worst = 0.0
        for clip in clips_for_track(project, t.id):
            rel = st.clip_relative_drift(clip, ref_id)
            worst = max(worst, abs(rel))
            row = rows.get((t.id, clip.id))
            if (
                row is not None
                and row.get("method") in LOCKED_METHODS
                and abs(rel + float(row.get("offset_sec") or 0.0)) <= threshold
            ):
                continue
            if abs(rel) > threshold:
                flagged[t.id] = max(flagged.get(t.id, 0.0), abs(rel))
        tracks[t.id] = round(worst, 3)
    return tracks, flagged


def alignment_drift_report(
    project: EpisodeProject,
    *,
    defaults: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Per-clip relative drift vs the reference for export QC.

    Ripple cuts shift every track alike and cancel out. A clip sitting more than
    the align threshold off the reference clock is an issue when no person accepted
    the alignment (missing, pending, waived by unattended, or a stale accept). A locked
    clip is exempt only while it still sits where align locked it. An unaccepted
    ``unconfirmed_hold`` candidate above the threshold and an unreadable align artifact
    are issues too. All are warnings when ``align.accept.mode`` is ``off``.
    """
    payload, err = _align_artifact_or_error(project)
    threshold = align_threshold_sec(payload, defaults)
    mode = align_mode_from_defaults(defaults)
    if err or payload is None or not _drift_checkable(payload):
        errs = [err] if err else []
        return {
            "checked": False,
            "threshold_sec": threshold,
            "tracks": {},
            "issues": [] if mode == "off" else errs,
            "warnings": errs if mode == "off" else [],
        }
    ref_id = str(payload["reference_track_id"])
    accepted, reason = _accept_state(project)
    tracks, flagged = _unexplained_drift(project, payload, threshold=threshold)
    findings: list[str] = []
    if not accepted:
        findings = [
            f"Track '{tid}' sits {rel:.1f}s off the reference clock ('{ref_id}') and the "
            f"alignment {reason}. Listen with `play --compare`, fix with `move_clips`, then "
            "`podcast align done`, or re-run align_tracks."
            for tid, rel in flagged.items()
        ]
        findings += [
            f"Track '{p.get('track_id')}' clip '{p.get('clip_id')}' has an unconfirmed "
            f"{_plan_move_sec(p):+.1f}s align candidate held at 0 and the alignment {reason}. "
            "Listen with `play --compare`, nudge with `move_clips` if it is real, then "
            "`podcast align done`."
            for p in large_align_moves(list(payload.get("plans") or []), threshold=threshold)
            if p.get("method") == UNCONFIRMED_HOLD
        ]
    return {
        "checked": True,
        "threshold_sec": threshold,
        "accepted": accepted,
        "reference_track_id": ref_id,
        "tracks": tracks,
        "issues": [] if mode == "off" else findings,
        "warnings": findings if mode == "off" else [],
    }


def require_or_waive_unattended(
    project: EpisodeProject,
    *,
    defaults: dict[str, Any] | None = None,
    unattended: bool | None = None,
) -> str:
    """Pipeline gate: return summary, or raise if interactive + pending.

    Unattended runs auto-waive only when no plan move (or held candidate) and no
    unlocked clip's current drift exceeds the threshold, the same predicate export QC uses.
    """
    mode = align_mode_from_defaults(defaults)
    if mode == "off":
        return "skipped (align.accept.mode=off)"
    data = load_status(project)
    fp = alignment_fingerprint(project)
    if status_is_clear_payload(data, fingerprint=fp):
        return f"{(data or {}).get('status', 'done')} (fingerprint ok)"

    unattended_now = is_unattended(flag=unattended, defaults=defaults)
    if mode == "waive_unattended" and unattended_now:
        payload, err = _align_artifact_or_error(project)
        if err:
            raise AlignAcceptRequiredError(f"{err} {GATE_HINT}")
        threshold = align_threshold_sec(payload, defaults)
        large = large_align_moves(list((payload or {}).get("plans") or []), threshold=threshold)
        listing = [
            f"{p.get('track_id')} {_plan_move_sec(p):+.2f}s ({p.get('method')})" for p in large
        ]
        if payload is not None and _drift_checkable(payload):
            named = {str(p.get("track_id")) for p in large}
            _tracks, flagged = _unexplained_drift(project, payload, threshold=threshold)
            listing += [
                f"{tid} {rel:.2f}s off the reference"
                for tid, rel in flagged.items()
                if tid not in named
            ]
        if listing:
            raise AlignAcceptRequiredError(
                f"Unattended run will not auto-waive align move(s) above {threshold:.1f}s: "
                f"{', '.join(listing[:6])}. {GATE_HINT}"
            )
        mark_align_waived(project, reason="unattended pipeline", source="unattended")
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
