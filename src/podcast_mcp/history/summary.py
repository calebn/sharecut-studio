from __future__ import annotations

import contextlib
from typing import Any


def _fmt_sec(sec: float | None) -> str:
    if sec is None:
        return "?"
    s = float(sec)
    if s < 0:
        s = 0.0
    m = int(s // 60)
    rem = s - m * 60
    if m >= 60:
        h = m // 60
        m = m % 60
        return f"{h}:{m:02d}:{rem:04.1f}"
    return f"{m}:{rem:04.1f}"


def _human_op(operation: str | None, label: str | None) -> str:
    if operation:
        return operation.replace("_", " ")
    if label:
        text = label.removeprefix("before ").removeprefix("after ")
        return text.replace("_", " ")
    return "snapshot"


def _track_list(ids: list[Any] | None) -> str | None:
    if not ids:
        return None
    names = [str(t) for t in ids if t is not None]
    if not names:
        return None
    if len(names) <= 3:
        return ", ".join(names)
    return f"{', '.join(names[:3])} +{len(names) - 3}"


def format_history_group_title(
    *,
    kind: str,
    label: str | None = None,
    operation: str | None = None,
    params: dict[str, Any] | None = None,
) -> str:
    """One-line title for a history group in list UIs."""
    params = params or {}
    op = _human_op(operation, label)
    bits: list[str] = [op]

    start = params.get("timeline_start", params.get("start"))
    end = params.get("timeline_end", params.get("end"))
    if start is not None and end is not None:
        try:
            dur = float(end) - float(start)
            bits.append(f"{_fmt_sec(float(start))}-{_fmt_sec(float(end))} ({dur:.1f}s)")
        except (TypeError, ValueError):
            pass
    elif start is not None:
        with contextlib.suppress(TypeError, ValueError):
            bits.append(f"@{_fmt_sec(float(start))}")

    tracks = params.get("track_ids") or params.get("affected_tracks")
    if isinstance(tracks, list):
        named = _track_list(tracks)
        if named:
            bits.append(f"on {named}")
    elif params.get("track_id"):
        bits.append(f"on {params['track_id']}")

    if params.get("query"):
        bits.append(f"“{params['query']}”")
    if params.get("fade_ms") is not None:
        bits.append(f"fade {params['fade_ms']}ms")
    if params.get("gain_db") is not None:
        bits.append(f"{params['gain_db']:+.1f} dB")

    title = " · ".join(bits)
    if kind == "snapshot" and label and label.startswith("after "):
        return f"pipeline: {label.removeprefix('after ')}"
    return title


def summarize_diff(
    diff: dict[str, Any],
    *,
    operation: str | None = None,
    params: dict[str, Any] | None = None,
    label: str | None = None,
) -> list[str]:
    """Human-readable lines describing a snapshot delta."""
    params = params or {}
    lines: list[str] = []

    # Prefer edit_log provenance when present.
    for rec in diff.get("edit_log", {}).get("added") or []:
        if not isinstance(rec, dict):
            continue
        op = _human_op(rec.get("operation") or operation, label)
        parts = [op]
        ts = rec.get("timeline_start")
        te = rec.get("timeline_end")
        if ts is not None and te is not None:
            try:
                dur = float(te) - float(ts)
                parts.append(f"{_fmt_sec(float(ts))}-{_fmt_sec(float(te))} ({dur:.1f}s)")
            except (TypeError, ValueError):
                pass
        tracks = _track_list(rec.get("track_ids"))
        if tracks:
            parts.append(f"on {tracks}")
        if rec.get("reason"):
            parts.append(f"- {rec['reason']}")
        lines.append(" ".join(parts))

    clips = diff.get("clips") or {}
    n_add = len(clips.get("added") or [])
    n_rem = len(clips.get("removed") or [])
    n_chg = len(clips.get("changed") or [])
    if n_add or n_rem or n_chg:
        clip_bits: list[str] = []
        if n_rem:
            clip_bits.append(f"{n_rem} clip{'s' if n_rem != 1 else ''} removed")
        if n_add:
            clip_bits.append(f"{n_add} clip{'s' if n_add != 1 else ''} added")
        if n_chg:
            clip_bits.append(f"{n_chg} clip{'s' if n_chg != 1 else ''} changed")
        lines.append(", ".join(clip_bits))

    decisions = diff.get("edit_decisions") or {}
    d_add = len(decisions.get("added") or [])
    d_rem = len(decisions.get("removed") or [])
    if d_add or d_rem:
        dec_bits: list[str] = []
        if d_add:
            dec_bits.append(f"{d_add} pending edit{'s' if d_add != 1 else ''} added")
        if d_rem:
            dec_bits.append(f"{d_rem} pending edit{'s' if d_rem != 1 else ''} removed")
        lines.append(", ".join(dec_bits))

    track_changes = (diff.get("tracks") or {}).get("changed") or []
    if track_changes:
        tids = _track_list([c.get("track_id") for c in track_changes if isinstance(c, dict)])
        field_names: list[str] = []
        for c in track_changes:
            if not isinstance(c, dict):
                continue
            for f in c.get("fields") or []:
                if isinstance(f, dict) and f.get("field"):
                    field_names.append(str(f["field"]))
        unique = sorted(set(field_names))
        detail = ", ".join(unique[:4])
        if len(unique) > 4:
            detail += f" +{len(unique) - 4}"
        line = "track settings changed"
        if tids:
            line += f" on {tids}"
        if detail:
            line += f" ({detail})"
        lines.append(line)

    duration_diff = diff.get("timeline_duration_sec") or {}
    if isinstance(duration_diff, dict):
        old_d, new_d = duration_diff.get("old"), duration_diff.get("new")
        if old_d is not None and new_d is not None and old_d != new_d:
            try:
                delta = float(new_d) - float(old_d)
                lines.append(
                    f"duration {_fmt_sec(float(old_d))} → {_fmt_sec(float(new_d))} ({delta:+.1f}s)"
                )
            except (TypeError, ValueError):
                pass

    if diff.get("mix_changed"):
        lines.append("mix / envelopes changed")
    if diff.get("meta_changed"):
        lines.append("project meta changed")

    if not lines:
        # Fall back to operation/params when the structural diff is empty-ish.
        title = format_history_group_title(
            kind="mutation",
            label=label,
            operation=operation,
            params=params,
        )
        lines.append(title if title != "snapshot" else "No structural changes detected")

    return lines
