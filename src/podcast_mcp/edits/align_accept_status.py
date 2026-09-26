"""Conversation-align accept gate — listen/nudge before later pipeline steps."""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from podcast_mcp.edits.clips_ops import clips_for_track
from podcast_mcp.edits.conversation_align import (
    LOCKED_METHODS,
    REFERENCE_METHOD,
    UNCONFIRMED_HOLD,
    align_artifact_path,
    alignment_fingerprint,
    clip_drift_rows,
    large_move_sec_from_defaults,
)
from podcast_mcp.edits.pipeline_unattended import is_unattended
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import Clip, EpisodeProject, TrackRole
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
    accepted_drift: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    fp = fingerprint if fingerprint is not None else alignment_fingerprint(project)
    payload: dict[str, Any] = {
        "status": status,
        "updated_at": datetime.now(UTC).isoformat(),
        "source": source,
        "notes": notes or "",
        "align_fingerprint": fp,
    }
    if accepted_drift is not None:
        payload["accepted_drift"] = accepted_drift
    if status in ("done", "waived"):
        artifact = load_align_artifact(project)
        if artifact is not None:
            payload["accepted_plan_digest"] = _plan_digest(artifact)
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
    return write_status(
        project,
        status="done",
        source=source,
        notes=notes,
        accepted_drift=_current_drift_rows(project),
    )


def mark_align_waived(
    project: EpisodeProject,
    *,
    reason: str,
    source: AlignSource = "user",
) -> dict[str, Any]:
    reason = (reason or "").strip()
    if not reason:
        raise ValueError("align waive requires a non-empty reason")
    return write_status(
        project,
        status="waived",
        source=source,
        notes=reason,
        accepted_drift=None if source == "unattended" else _current_drift_rows(project),
    )


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
    data = load_status(project)
    return status_is_clear_payload(data, fingerprint=alignment_fingerprint(project)) and (
        _accept_covers_current_artifact(project, data)
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


def _plan_digest(payload: dict[str, Any]) -> str:
    """Identity of the candidate set accepted by a person, independent of clip edits."""
    plans = payload.get("plans") or []
    encoded = json.dumps(plans, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _accept_covers_current_artifact(project: EpisodeProject, data: dict[str, Any] | None) -> bool:
    artifact, err = _align_artifact_or_error(project)
    if err:
        return False
    digest = (data or {}).get("accepted_plan_digest")
    if artifact is None:
        return digest is None  # old status written when no artifact existed
    return digest == _plan_digest(artifact)


def large_align_moves(plans: list[dict[str, Any]], *, threshold: float) -> list[dict[str, Any]]:
    """Unlocked plan rows whose move (or held candidate) exceeds ``threshold`` seconds."""
    skip = LOCKED_METHODS | {REFERENCE_METHOD}
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
    clear = status_is_clear_payload(data, fingerprint=fp) and _accept_covers_current_artifact(
        project, data
    )
    if data and status in ("done", "waived") and not clear:
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


@dataclass(frozen=True)
class _AcceptState:
    """Whether a person accepted the current alignment (export QC)."""

    accepted: bool  # a person's accept matches the current fingerprint
    reason: str  # completes "and the alignment ..." when not accepted
    person_rows: list[dict[str, Any]] | None  # clip drift a person accepted (even stale)


def _accept_state(project: EpisodeProject) -> _AcceptState:
    data = load_status(project)
    if data is None:
        return _AcceptState(False, "was not accepted by a person (align status: missing)", None)
    status = data.get("status")
    if status == "waived" and data.get("source") == "unattended":
        return _AcceptState(
            False, "was not accepted by a person (align status: waived by unattended)", None
        )
    if status not in ("done", "waived"):
        return _AcceptState(False, f"was not accepted by a person (align status: {status})", None)
    rows = list(data.get("accepted_drift") or [])
    if status_is_clear_payload(data, fingerprint=alignment_fingerprint(project)) and (
        _accept_covers_current_artifact(project, data)
    ):
        return _AcceptState(True, "", rows)
    return _AcceptState(False, f"accept is stale (alignment changed since `align {status}`)", rows)


def _drift_checkable(payload: dict[str, Any] | None) -> bool:
    return (
        payload is not None
        and not payload.get("skipped_reason")
        and bool(payload.get("reference_track_id"))
    )


def _current_drift_rows(project: EpisodeProject) -> list[dict[str, Any]]:
    """Per-clip relative drift now, recorded when a person accepts (empty when uncheckable)."""
    payload = load_align_artifact(project)
    if payload is None or not _drift_checkable(payload):
        return []
    return clip_drift_rows(project, str(payload["reference_track_id"]))


def _placement_rows(
    by_id: dict[str, list[dict[str, Any]]],
    by_source: dict[str, list[dict[str, Any]]],
    clip: Clip,
    current_clip_ids: set[str],
) -> list[dict[str, Any]]:
    """Rows for ``clip``: its own id, or verified source/split inheritance."""
    out = list(by_id.get(clip.id, []))
    if out:
        return out
    candidates = (
        by_source.get(clip.source_id, []) if clip.source_id is not None else by_source.get("", [])
    )
    for r in candidates:
        if r.get("clip_id") == clip.id:
            continue
        if r.get("source_start") is None or r.get("source_end") is None:
            continue
        overlap = min(float(r["source_end"]), clip.source_end) - max(
            float(r["source_start"]), clip.source_start
        )
        split_piece = (
            clip.source_id is None
            and float(r["source_start"]) <= clip.source_start
            and clip.source_end <= float(r["source_end"])
            and (
                float(r["source_start"]) < clip.source_start
                or clip.source_end < float(r["source_end"])
            )
        )
        if overlap > 1e-6 and (
            clip.source_id is not None
            or (
                split_piece
                and isinstance(r.get("clip_id"), str)
                and r["clip_id"] not in current_clip_ids
            )
        ):
            out.append(r)
    if clip.source_id is None and len({str(r.get("clip_id")) for r in out}) != 1:
        return []
    return out


def _index_placement_rows(
    rows: list[dict[str, Any]],
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, list[dict[str, Any]]]]:
    by_id: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_source: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_id[str(row.get("clip_id"))].append(row)
        source = row.get("source_id")
        if isinstance(source, str) or source is None:
            by_source[source or ""].append(row)
    return by_id, by_source


def _still_placed(row: dict[str, Any], rel: float, threshold: float) -> bool:
    """True while ``rel`` is within ``threshold`` of the relative drift the row recorded."""
    if row.get("rel_drift_sec") is not None:
        expected = float(row["rel_drift_sec"])
    else:  # artifact written before rel_drift_sec: the lock's offset
        expected = -float(row.get("offset_sec") or 0.0)
    return abs(rel - expected) <= threshold


def _unexplained_drift(
    project: EpisodeProject,
    payload: dict[str, Any],
    *,
    threshold: float,
    accepted_rows: list[dict[str, Any]],
    accepted: bool = False,
) -> tuple[dict[str, float], dict[str, float]]:
    """(max |relative drift| per non-reference dialogue track, tracks whose drift needs a person).

    A clip is exempt while it, or the clip it was split from, still sits where align
    locked it (hold/manual) or where a person accepted it (``accepted_rows``): its
    relative drift within ``threshold`` of the recorded one. Moved since, it counts.
    """
    ref_id = str(payload["reference_track_id"])
    locked = [p for p in payload.get("plans") or [] if p.get("method") in LOCKED_METHODS]
    st = SessionTimeline(project)
    tracks: dict[str, float] = {}
    flagged: dict[str, float] = {}
    for t in project.tracks:
        if t.role != TrackRole.DIALOGUE or t.id == ref_id:
            continue
        rows = [r for r in (*locked, *accepted_rows) if str(r.get("track_id")) == t.id]
        by_id, by_source = _index_placement_rows(rows) if not accepted else ({}, {})
        clips = clips_for_track(project, t.id)
        current_clip_ids = {clip.id for clip in clips}
        worst = 0.0
        for clip in clips:
            rel = st.clip_relative_drift(clip, ref_id)
            worst = max(worst, abs(rel))
            if (
                accepted
                or abs(rel) <= threshold
                or any(
                    _still_placed(r, rel, threshold)
                    for r in _placement_rows(by_id, by_source, clip, current_clip_ids)
                )
            ):
                continue
            flagged[t.id] = max(flagged.get(t.id, 0.0), abs(rel))
        tracks[t.id] = round(worst, 3)
    return tracks, flagged


@dataclass(frozen=True)
class _AlignFindings:
    """What still needs a person; the unattended gate and export QC only format these."""

    moves: list[dict[str, Any]]  # plan rows above threshold, incl. unconfirmed_hold candidates
    drift: dict[str, float]  # track -> worst relative drift no lock or accept explains
    tracks: dict[str, float]  # track -> worst relative drift (report)


def _align_findings(
    project: EpisodeProject,
    payload: dict[str, Any] | None,
    *,
    threshold: float,
    person_rows: list[dict[str, Any]] | None,
    accepted: bool = False,
) -> _AlignFindings:
    moves = large_align_moves(list((payload or {}).get("plans") or []), threshold=threshold)
    if payload is None or not _drift_checkable(payload):
        return _AlignFindings(moves=moves, drift={}, tracks={})
    tracks, drift = _unexplained_drift(
        project, payload, threshold=threshold, accepted_rows=person_rows or [], accepted=accepted
    )
    return _AlignFindings(moves=moves, drift=drift, tracks=tracks)


def alignment_drift_report(
    project: EpisodeProject,
    *,
    defaults: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Per-clip relative drift vs the reference for export QC.

    Ripple cuts shift every track alike and cancel out. A clip sitting more than
    the align threshold off the reference clock is an issue when no person accepted
    the alignment (missing, pending, waived by unattended), or when it moved more than
    the threshold since a person's now-stale accept. A locked clip, and each split piece
    of it, is exempt only while it still sits where align locked it. An
    ``unconfirmed_hold`` candidate above the threshold that no person accepted and an
    unreadable align artifact are issues too. All are warnings when
    ``align.accept.mode`` is ``off``.
    """
    payload, err = _align_artifact_or_error(project)
    threshold = align_threshold_sec(payload, defaults)
    mode = align_mode_from_defaults(defaults)
    if err or payload is None or not _drift_checkable(payload):
        errs = [err] if err else []
        if payload is None and not err and (load_status(project) or {}).get("accepted_plan_digest"):
            errs.append(
                "Accepted align artifact is missing; re-run align_tracks and review alignment."
            )
        return {
            "checked": False,
            "threshold_sec": threshold,
            "tracks": {},
            "issues": [] if mode == "off" else errs,
            "warnings": errs if mode == "off" else [],
        }
    ref_id = str(payload["reference_track_id"])
    state = _accept_state(project)
    found = _align_findings(
        project,
        payload,
        threshold=threshold,
        person_rows=state.person_rows,
        accepted=state.accepted,
    )
    findings: list[str] = []
    if not state.accepted:
        findings = [
            f"Track '{tid}' sits {rel:.1f}s off the reference clock ('{ref_id}') and the "
            f"alignment {state.reason}. Listen with `play --compare`, fix with `move_clips`, "
            "then `podcast align done`, or re-run align_tracks."
            for tid, rel in found.drift.items()
        ]
        status_data = load_status(project) or {}
        if status_data.get("accepted_plan_digest") != _plan_digest(payload):
            findings += [
                f"Track '{p.get('track_id')}' clip '{p.get('clip_id')}' has an unconfirmed "
                f"{_plan_move_sec(p):+.1f}s align candidate held at 0 and the alignment "
                f"{state.reason}. Listen with `play --compare`, nudge with `move_clips` if it "
                "is real, then `podcast align done`."
                for p in found.moves
                if p.get("method") == UNCONFIRMED_HOLD
            ]
    return {
        "checked": True,
        "threshold_sec": threshold,
        "accepted": state.accepted,
        "reference_track_id": ref_id,
        "tracks": found.tracks,
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
    unlocked clip's current drift exceeds the threshold: :func:`_align_findings`, the
    same findings export QC formats, without a person's accept to lean on.
    """
    mode = align_mode_from_defaults(defaults)
    if mode == "off":
        return "skipped (align.accept.mode=off)"
    data = load_status(project)
    fp = alignment_fingerprint(project)
    if status_is_clear_payload(data, fingerprint=fp) and _accept_covers_current_artifact(
        project, data
    ):
        return f"{(data or {}).get('status', 'done')} (fingerprint ok)"

    unattended_now = is_unattended(flag=unattended, defaults=defaults)
    if mode == "waive_unattended" and unattended_now:
        payload, err = _align_artifact_or_error(project)
        if err:
            raise AlignAcceptRequiredError(f"{err} {GATE_HINT}")
        if payload is None and (data or {}).get("accepted_plan_digest"):
            raise AlignAcceptRequiredError(
                f"Accepted align artifact is missing; re-run align_tracks. {GATE_HINT}"
            )
        threshold = align_threshold_sec(payload, defaults)
        found = _align_findings(project, payload, threshold=threshold, person_rows=None)
        named = {str(p.get("track_id")) for p in found.moves}
        listing = [
            f"{p.get('track_id')} {_plan_move_sec(p):+.2f}s ({p.get('method')})"
            for p in found.moves
        ]
        listing += [
            f"{tid} {rel:.2f}s off the reference"
            for tid, rel in found.drift.items()
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
