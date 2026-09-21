"""Audition context: captions, clock maps, and freshness for a timeline window.

Used before play/compare so agents (and humans) can see what each track is
saying at the same session clock - and whether stale stems would make the
premix misleading.

``detail``:
- ``summary`` (default) - captions, freshness, comments, effects, edits,
  and windowed hum/clip hypotheses (no PNGs; DSP skipped above 60s)
- ``full`` - summary plus fuller edit/comment payloads
- ``visual`` - full plus per-track waveform/spectrogram PNGs (slower)

Payload ``schema`` is ``audition_context.v2``: typed hypotheses, suggested
listens, and explicit clocks. Existing keys (``summary``, ``warnings``,
``tracks[].text``) stay so older skill lines still parse.
"""

from __future__ import annotations

import contextlib
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Literal

from podcast_mcp.edits.comments import list_comments
from podcast_mcp.engines.audio_audit import clipping_indicated
from podcast_mcp.engines.render_status import render_status_report
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.timebase import SourceSec, TimelineSec
from podcast_mcp.util.tracks import dialogue_track_ids

DetailLevel = Literal["summary", "full", "visual"]

SCHEMA_ID = "audition_context.v2"

DEFAULT_SKEW_WARN_SEC = 0.05

MAX_VISUAL_EVENTS = 20
MAX_BURNED_LABELS = 8
MAX_SUGGESTED_LISTEN = 4
MAX_DSP_WINDOW_SEC = 60.0

# Dialogue tracks' source clocks at one timeline instant are reported on
# ``tracks[].source_at_mid`` / ``clip_skew.pairs``. Unequal per-track cuts make
# those clocks diverge; that is remaining-clip math, not recorder desync.

_GLOBAL_HYPOTHESIS_CODES = frozenset(
    {
        "stale_render",
        "stale_reconciliation",
        "uneven_transcript_density",
        "edits_in_window",
    }
)

HYPOTHESIS_CATALOG: dict[str, dict[str, Any]] = {
    "stale_render": {
        "severity": "warn",
        "confidence": "measured",
        "autonomy": "auto_ok",
        "skill": None,
        "tools": ["render_preview"],
        "meaning": (
            "Stems and/or premix are stale relative to the current timeline; "
            "play may not match these captions."
        ),
    },
    "stale_reconciliation": {
        "severity": "warn",
        "confidence": "measured",
        "autonomy": "auto_ok",
        "skill": "podcast-transcript-reconcile",
        "tools": ["reconcile_transcript_tool"],
        "meaning": "Transcript reconciliation is stale versus current audio state.",
    },
    "edits_in_window": {
        "severity": "info",
        "confidence": "measured",
        "autonomy": "needs_approval",
        "skill": "podcast-edit-natural-language",
        "tools": ["play_pending_preview_tool"],
        "meaning": "Pending or applied edits overlap this window.",
    },
    "acoustic_gap_filler": {
        "severity": "info",
        "confidence": "heuristic",
        "autonomy": "needs_approval",
        "skill": "podcast-tighten-dialogue",
        "tools": ["play_pending_preview_tool"],
        "meaning": "A local DSP candidate found voiced audio inside an ASR gap; review before cutting.",
    },
    "suppressed_only_track": {
        "severity": "info",
        "confidence": "measured",
        "autonomy": "needs_approval",
        "skill": "podcast-mute-bleed",
        "tools": ["apply_transcript_gate_tool"],
        "meaning": "This track's words in the window are all suppressed (bleed smell).",
    },
    "muted_track_speaking": {
        "severity": "warn",
        "confidence": "measured",
        "autonomy": "present_only",
        "skill": None,
        "tools": [],
        "meaning": "Track is muted but has caption words in this window; confirm intent.",
    },
    "uneven_transcript_density": {
        "severity": "info",
        "confidence": "heuristic",
        "autonomy": "present_only",
        "skill": None,
        "tools": [],
        "meaning": (
            "One track has a full line while another has only fragments "
            "in this window (bleed or desync smell)."
        ),
    },
    "hum_in_window": {
        "severity": "warn",
        "confidence": "measured",
        "autonomy": "needs_approval",
        "skill": "podcast-audio-cleanup",
        "tools": ["audio_diagnostics_tool"],
        "meaning": "Mains hum detected in this window on the named track.",
    },
    "clipping_in_window": {
        "severity": "warn",
        "confidence": "measured",
        "autonomy": "needs_approval",
        "skill": "podcast-audio-cleanup",
        "tools": ["audio_diagnostics_tool"],
        "meaning": "Clipping indicators (peak/flat-factor) in this window on the named track.",
    },
    "dsp_unavailable": {
        "severity": "info",
        "confidence": "measured",
        "autonomy": "present_only",
        "skill": None,
        "tools": ["audio_diagnostics_tool"],
        "meaning": "Windowed astats/hum could not run for this span; do not treat the window as clean.",
    },
}


def event_x(t: float, window_start: float, window_end: float) -> float:
    """Linear plot-relative x in [0, 1] for timeline instant ``t``."""
    span = window_end - window_start
    if span <= 0:
        return 0.0
    x = (t - window_start) / span
    return max(0.0, min(1.0, round(x, 6)))


def cap_visual_events(
    events: Sequence[dict[str, Any]],
    *,
    limit: int = MAX_VISUAL_EVENTS,
) -> list[dict[str, Any]]:
    """Keep all non-word events; drop lowest-priority words to fit ``limit``."""
    non_words = [e for e in events if e.get("kind") != "word"]
    words = [e for e in events if e.get("kind") == "word"]
    room = max(0, limit - len(non_words))
    return list(non_words) + words[:room]


def build_visual_events(
    *,
    track_id: str,
    window_start: float,
    window_end: float,
    words: Sequence[tuple[float, str]],
    comments: Sequence[dict[str, Any]],
    pending_edits: Sequence[dict[str, Any]],
    hypotheses: Sequence[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Time-grounded sidecar events for one track visual (timeline clock)."""
    hyp_windows = [h.get("window") or {} for h in hypotheses if track_id in (h.get("tracks") or [])]
    word_events: list[dict[str, Any]] = []
    for i, (t, text) in enumerate(words):
        if t < window_start or t > window_end:
            continue
        in_hyp = any(
            float(w.get("start", window_start)) <= t <= float(w.get("end", window_end))
            for w in hyp_windows
        )
        keep = i == 0 or in_hyp
        if not keep:
            continue
        word_events.append(
            {
                "t": t,
                "x": event_x(t, window_start, window_end),
                "kind": "word",
                "track_id": track_id,
                "text": text,
            }
        )

    other: list[dict[str, Any]] = []
    for c in comments:
        c_tracks = c.get("track_ids")
        if c_tracks and track_id not in c_tracks:
            continue
        t = float(c.get("timeline_start", window_start))
        other.append(
            {
                "t": t,
                "x": event_x(t, window_start, window_end),
                "kind": "comment",
                "track_id": track_id,
                "id": c.get("id"),
                "text": c.get("body"),
            }
        )
    for e in pending_edits:
        if e.get("track_id") not in (None, track_id):
            continue
        t = float(e.get("timeline_start", window_start))
        other.append(
            {
                "t": t,
                "x": event_x(t, window_start, window_end),
                "kind": "pending_edit",
                "track_id": e.get("track_id", track_id),
                "id": e.get("id"),
                "text": e.get("reason"),
            }
        )
    for h in hypotheses:
        if track_id not in (h.get("tracks") or []):
            continue
        win = h.get("window") or {}
        t = float(win.get("start", window_start))
        other.append(
            {
                "t": t,
                "x": event_x(t, window_start, window_end),
                "kind": "hypothesis",
                "track_id": track_id,
                "id": h.get("code"),
                "text": h.get("code"),
            }
        )
    return cap_visual_events(other + word_events)


def build_audition_context(
    project: EpisodeProject,
    timeline_start: float,
    timeline_end: float,
    *,
    skew_warn_sec: float = DEFAULT_SKEW_WARN_SEC,
    detail: DetailLevel = "summary",
    render_visual_pngs: bool | None = None,
) -> dict[str, Any]:
    if timeline_end <= timeline_start:
        raise ValueError("timeline_end must be after timeline_start")
    if detail not in ("summary", "full", "visual"):
        raise ValueError("detail must be summary, full, or visual")

    speaker_roles: dict[str, Any] | None = None
    if detail in ("full", "visual"):
        speaker_roles = _speaker_roles_for_window(
            project,
            dialogue_track_ids(project, include_muted=True),
            timeline_start,
            timeline_end,
        )

    st = SessionTimeline(project)
    track_ids = dialogue_track_ids(project, include_muted=True)
    mid = (timeline_start + timeline_end) / 2.0
    window = _clock_window(timeline_start, timeline_end)
    tracks_out: list[dict[str, Any]] = []
    source_at_mid: dict[str, float | None] = {}
    words_timeline: dict[str, list[tuple[float, str]]] = {}

    for tid in track_ids:
        spans = st.map_timeline_span(tid, TimelineSec(timeline_start), TimelineSec(timeline_end))
        src_mid = st.timeline_to_source(tid, TimelineSec(mid))
        source_at_mid[tid] = float(src_mid) if src_mid is not None else None
        words = _words_in_source_spans(project, tid, spans)
        text = " ".join(w.text for w in words).strip()
        mapped_words: list[tuple[float, str]] = []
        for w in words:
            tl = st.source_to_timeline(tid, SourceSec(w.start))
            if tl is None:
                continue
            mapped_words.append((float(tl), w.text))
        words_timeline[tid] = mapped_words
        track_info: dict[str, Any] = {
            "track_id": tid,
            "kind": "transcript_caption",
            "source_spans": [
                {"clock": "source", "start": float(a), "end": float(b)} for a, b in spans
            ],
            "source_at_mid": source_at_mid[tid],
            "word_count": len(words),
            "text": text,
            "suppressed_only": bool(spans) and not words and _has_any_words(project, tid, spans),
            "effects": _active_effects(project, tid),
            "muted": bool(getattr(project.track_by_id(tid), "muted", False)),
        }
        tracks_out.append(track_info)

    skew = _clip_skew_warnings(source_at_mid, skew_warn_sec=skew_warn_sec)
    render = render_status_report(project)
    comments = _comments_in_window(project, timeline_start, timeline_end, full=detail != "summary")
    edits = _edits_in_window(project, st, timeline_start, timeline_end, full=detail != "summary")
    render_status = {
        "needs_rerender": render.get("needs_rerender"),
        "tracks": {
            tid: {
                "stem_exists": info.get("stem_exists"),
                "stem_is_fresh": info.get("stem_is_fresh"),
            }
            for tid, info in (render.get("tracks") or {}).items()
        },
        "premix_exists": bool((render.get("premix") or {}).get("exists")),
        "reconciliation_stale": bool((render.get("reconciliation") or {}).get("stale")),
    }

    hypotheses = _build_hypotheses(
        window=window,
        tracks_out=tracks_out,
        render_status=render_status,
        edits=edits,
        track_ids=track_ids,
    )

    dsp = _diagnostics_for_tracks(
        project,
        track_ids,
        timeline_start,
        timeline_end,
        pngs=detail == "visual" if render_visual_pngs is None else render_visual_pngs,
    )
    hypotheses.extend(_visual_hypotheses(window, dsp))

    visuals: list[dict[str, Any]] | None = None
    if detail == "visual":
        visuals = dsp
        _enrich_visuals(
            visuals,
            timeline_start=timeline_start,
            timeline_end=timeline_end,
            words_timeline=words_timeline,
            comments=comments,
            edits=edits,
            hypotheses=hypotheses,
        )

    suggested = _build_suggested_listen(hypotheses, window, track_ids)
    _attach_listen_refs(hypotheses, suggested)
    warnings = [_warning_line(h) for h in hypotheses]

    out: dict[str, Any] = {
        "schema": SCHEMA_ID,
        "window": window,
        "timeline_start": timeline_start,
        "timeline_end": timeline_end,
        "mid_sec": mid,
        "detail": detail,
        "tracks": tracks_out,
        "clip_skew": skew,
        "comments": comments,
        "edits": edits,
        "render_status": render_status,
        "hypotheses": hypotheses,
        "suggested_listen": suggested,
        "limits": _limits(detail=detail, needs_rerender=bool(render_status.get("needs_rerender"))),
        "warnings": warnings,
        "summary": _summary(tracks_out, warnings, comments),
    }
    if speaker_roles is not None:
        out["speaker_roles"] = speaker_roles
    if visuals is not None:
        out["visuals"] = visuals
    return out


def _clock_window(start: float, end: float) -> dict[str, Any]:
    return {"clock": "timeline", "unit": "sec", "start": start, "end": end}


def _hypothesis(
    code: str,
    *,
    tracks: list[str],
    window: dict[str, Any],
    evidence: dict[str, Any],
    meaning: str | None = None,
) -> dict[str, Any]:
    spec = HYPOTHESIS_CATALOG[code]
    return {
        "code": code,
        "severity": spec["severity"],
        "confidence": spec["confidence"],
        "tracks": list(tracks),
        "window": dict(window),
        "evidence": evidence,
        "meaning": meaning or spec["meaning"],
        "next": {
            "listen": None,
            "tools": list(spec.get("tools") or []),
            "fix": {"skill": spec.get("skill"), "autonomy": spec["autonomy"]},
        },
    }


def _build_hypotheses(
    *,
    window: dict[str, Any],
    tracks_out: list[dict[str, Any]],
    render_status: dict[str, Any],
    edits: dict[str, Any],
    track_ids: list[str],
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if render_status.get("needs_rerender"):
        out.append(
            _hypothesis(
                "stale_render",
                tracks=list(track_ids),
                window=window,
                evidence={
                    "premix_exists": render_status.get("premix_exists"),
                    "needs_rerender": True,
                },
            )
        )
    if render_status.get("reconciliation_stale"):
        out.append(
            _hypothesis(
                "stale_reconciliation",
                tracks=list(track_ids),
                window=window,
                evidence={"reconciliation_stale": True},
            )
        )
    pending = edits.get("pending") or []
    applied = edits.get("applied") or []
    if pending or applied:
        out.append(
            _hypothesis(
                "edits_in_window",
                tracks=sorted(
                    {
                        *(e.get("track_id") for e in pending if e.get("track_id")),
                        *(tid for e in applied for tid in (e.get("track_ids") or [])),
                    }
                )
                or list(track_ids),
                window=window,
                evidence={"pending": len(pending), "applied": len(applied)},
                meaning=(
                    f"edits_in_window: {len(pending)} pending, "
                    f"{len(applied)} applied overlapping this span"
                ),
            )
        )
        acoustic = [e for e in pending if str(e.get("reason") or "").startswith("filler:acoustic")]
        for e in acoustic:
            out.append(
                _hypothesis(
                    "acoustic_gap_filler",
                    tracks=[e["track_id"]] if e.get("track_id") else list(track_ids),
                    window=window,
                    evidence={"edit_id": e.get("id"), "reason": e.get("reason")},
                    meaning="acoustic_gap_filler: voiced run in an inter-word ASR gap (review required)",
                )
            )
    for t in tracks_out:
        if t.get("suppressed_only"):
            out.append(
                _hypothesis(
                    "suppressed_only_track",
                    tracks=[t["track_id"]],
                    window=window,
                    evidence={"suppressed_only": True},
                )
            )
        if t.get("muted") and (t.get("text") or "").strip():
            out.append(
                _hypothesis(
                    "muted_track_speaking",
                    tracks=[t["track_id"]],
                    window=window,
                    evidence={"muted": True, "word_count": t.get("word_count")},
                )
            )
    dense = [t for t in tracks_out if t["word_count"] >= 8]
    sparse = [t for t in tracks_out if 0 < t["word_count"] <= 3]
    if dense and sparse:
        out.append(
            _hypothesis(
                "uneven_transcript_density",
                tracks=[t["track_id"] for t in dense + sparse],
                window=window,
                evidence={
                    "dense": [t["track_id"] for t in dense],
                    "sparse": [t["track_id"] for t in sparse],
                },
            )
        )
    return out


def _visual_hypotheses(
    window: dict[str, Any],
    visuals: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for vis in visuals:
        tid = vis.get("track_id")
        if not tid:
            continue
        if vis.get("dsp_unavailable") or vis.get("error"):
            reason = vis.get("reason") or vis.get("error") or "dsp_failed"
            out.append(
                _hypothesis(
                    "dsp_unavailable",
                    tracks=[tid],
                    window=window,
                    evidence={"reason": str(reason)[:200]},
                )
            )
            continue
        hum = vis.get("hum") or {}
        if hum.get("hum_detected"):
            out.append(
                _hypothesis(
                    "hum_in_window",
                    tracks=[tid],
                    window=window,
                    evidence={
                        "hum_detected": True,
                        "dominant_frequency": hum.get("dominant_frequency"),
                        "energy_ratios": hum.get("energy_ratios"),
                    },
                )
            )
        astats = vis.get("astats") or {}
        if clipping_indicated(astats):
            out.append(
                _hypothesis(
                    "clipping_in_window",
                    tracks=[tid],
                    window=window,
                    evidence={
                        "peak_level_db": astats.get("peak_level_db"),
                        "flat_factor": astats.get("flat_factor"),
                        "peak_count": astats.get("peak_count"),
                    },
                )
            )
    return out


def _build_suggested_listen(
    hypotheses: list[dict[str, Any]],
    window: dict[str, Any],
    dialogue_ids: list[str],
) -> list[dict[str, Any]]:
    start, end = float(window["start"]), float(window["end"])
    entries: list[dict[str, Any]] = [
        {
            "id": "sl-1",
            "why": "Hear what the listener hears in this window",
            "source": "premix",
            "start": start,
            "end": end,
            "clock": "timeline",
        }
    ]
    track_specific = [h for h in hypotheses if h["code"] not in _GLOBAL_HYPOTHESIS_CODES]
    compose_ids: list[str] = []
    seen_compose: set[str] = set()
    for h in track_specific:
        for tid in h.get("tracks") or []:
            if tid in dialogue_ids and tid not in seen_compose:
                seen_compose.add(tid)
                compose_ids.append(tid)
    if len(compose_ids) >= 2 and len(entries) < MAX_SUGGESTED_LISTEN:
        entries.append(
            {
                "id": f"sl-{len(entries) + 1}",
                "why": "Hear the named tracks together without the rest of the premix",
                "track_ids": compose_ids,
                "tier": "processed",
                "start": start,
                "end": end,
                "clock": "timeline",
            }
        )
    warn_tracks: list[str] = []
    seen_warn: set[str] = set()
    for h in track_specific:
        if h.get("severity") not in ("warn", "error"):
            continue
        for tid in h.get("tracks") or []:
            if tid in dialogue_ids and tid not in seen_warn:
                seen_warn.add(tid)
                warn_tracks.append(tid)
    for tid in warn_tracks:
        if len(entries) >= MAX_SUGGESTED_LISTEN:
            break
        entries.append(
            {
                "id": f"sl-{len(entries) + 1}",
                "why": f"Isolate {tid} with FX+edits",
                "source": f"processed:{tid}",
                "start": start,
                "end": end,
                "clock": "timeline",
            }
        )
    return entries


def _attach_listen_refs(
    hypotheses: list[dict[str, Any]],
    suggested: list[dict[str, Any]],
) -> None:
    premix_id = next((s["id"] for s in suggested if s.get("source") == "premix"), None)
    compose_id = next((s["id"] for s in suggested if s.get("track_ids")), None)
    isolate_by_track = {
        s["source"].split(":", 1)[1]: s["id"]
        for s in suggested
        if isinstance(s.get("source"), str) and s["source"].startswith("processed:")
    }
    for h in hypotheses:
        tracks = h.get("tracks") or []
        listen = premix_id
        if len(tracks) == 1 and tracks[0] in isolate_by_track:
            listen = isolate_by_track[tracks[0]]
        elif len(tracks) >= 2 and compose_id:
            listen = compose_id
        h["next"]["listen"] = listen


def _limits(*, detail: str, needs_rerender: bool) -> list[str]:
    out = ["cannot_hear", "captions_are_transcript_not_audio"]
    if needs_rerender:
        out.append("needs_rerender")
    if detail == "visual":
        out.append("visuals_are_degradation_not_asr")
    return out


def _warning_line(hypothesis: dict[str, Any]) -> str:
    code = hypothesis["code"]
    meaning = hypothesis.get("meaning") or ""
    if meaning.startswith(f"{code}:"):
        return meaning
    return f"{code}: {meaning}"


def _speaker_roles_for_window(
    project: EpisodeProject,
    track_ids: list[str],
    timeline_start: float,
    timeline_end: float,
) -> dict[str, Any] | None:
    from podcast_mcp.engines.speaker_id import (
        classify_track_role,
        load_all_profiles,
        resolve_speaker_backend,
        score_window,
    )
    from podcast_mcp.transcript_context import load_transcript_context

    profiles = load_all_profiles(project)
    if not profiles:
        return None
    ctx = load_transcript_context(project.workspace_path())
    backend = resolve_speaker_backend()
    st = SessionTimeline(project)
    mid = (timeline_start + timeline_end) / 2.0
    tracks_out: dict[str, Any] = {}
    for tid in track_ids:
        src = st.timeline_to_source(tid, TimelineSec(mid))
        if src is None:
            continue
        center = float(src)
        half = max(0.15, (timeline_end - timeline_start) / 4.0)
        ws = score_window(
            project,
            tid,
            center - half,
            center + half,
            ctx.speaker_id,
            backend,
            profiles=profiles,
        )
        role, match_id = classify_track_role(ws, tid, ctx.speaker_id)
        tracks_out[tid] = {
            "role": role,
            "match_identity": match_id,
            "margin": ws.margin if ws else 0.0,
            "best_home_track": ws.best_track_id if ws else None,
        }
    return tracks_out if tracks_out else None


def _active_effects(project: EpisodeProject, track_id: str) -> list[dict[str, Any]]:
    chain = next((c for c in project.processing_chains if c.track_id == track_id), None)
    if chain is None:
        return []
    return [
        {
            "effect": fx.effect,
            "bypass": fx.bypass,
            "params": fx.params if not fx.bypass else {},
        }
        for fx in chain.effects
        if not fx.bypass
    ]


def _comments_in_window(
    project: EpisodeProject,
    timeline_start: float,
    timeline_end: float,
    *,
    full: bool,
) -> list[dict[str, Any]]:
    rows = []
    for c in list_comments(project, include_resolved=True):
        c_end = c.timeline_end if c.timeline_end is not None else c.timeline_start
        if c_end < timeline_start or c.timeline_start > timeline_end:
            continue
        open_actions = [a for a in c.action_items if not a.done]
        entry: dict[str, Any] = {
            "id": c.id,
            "body": c.body,
            "author": c.author,
            "timeline_start": c.timeline_start,
            "timeline_end": c.timeline_end,
            "resolved": c.resolved,
            "open_action_count": len(open_actions),
        }
        if full:
            entry["track_ids"] = list(c.track_ids)
            entry["action_items"] = [
                {"id": a.id, "text": a.text, "done": a.done} for a in c.action_items
            ]
        rows.append(entry)
    return rows


def _edits_in_window(
    project: EpisodeProject,
    st: SessionTimeline,
    timeline_start: float,
    timeline_end: float,
    *,
    full: bool,
) -> dict[str, Any]:
    pending: list[dict[str, Any]] = []
    for e in project.edit_decisions:
        if e.applied:
            continue
        tl = st.map_source_span(e.track_id, SourceSec(e.start), SourceSec(e.end))
        if not tl:
            mid_src = (e.start + e.end) / 2.0
            mid_tl = st.source_to_timeline(e.track_id, SourceSec(mid_src))
            if mid_tl is None:
                continue
            if not (timeline_start <= float(mid_tl) <= timeline_end):
                continue
            tl_start, tl_end = float(mid_tl), float(mid_tl)
        else:
            tl_start = min(a for a, _ in tl)
            tl_end = max(b for _, b in tl)
            if tl_end < timeline_start or tl_start > timeline_end:
                continue
        entry: dict[str, Any] = {
            "id": e.id,
            "track_id": e.track_id,
            "reason": e.reason,
            "review_required": e.review_required,
            "cut_confidence": e.cut_confidence,
            "timeline_start": tl_start,
            "timeline_end": tl_end,
        }
        if full:
            entry.update(
                {
                    "source_start": e.start,
                    "source_end": e.end,
                    "boundary_mode": e.boundary_mode,
                }
            )
        pending.append(entry)

    applied: list[dict[str, Any]] = []
    for r in project.editorial.edit_log:
        rs, re_ = r.timeline_start, r.timeline_end
        if rs is None or re_ is None:
            continue
        if re_ < timeline_start or rs > timeline_end:
            continue
        entry = {
            "id": r.id,
            "operation": r.operation,
            "reason": r.reason,
            "timeline_start": rs,
            "timeline_end": re_,
            "cut_confidence": r.cut_confidence,
        }
        if full:
            entry.update(
                {
                    "track_ids": list(r.track_ids),
                    "source_start": r.source_start,
                    "source_end": r.source_end,
                    "boundary_mode": r.boundary_mode,
                }
            )
        applied.append(entry)

    return {"pending": pending, "applied": applied}


def _safe_dsp_reason(exc: BaseException, project: EpisodeProject) -> str:
    text = f"{type(exc).__name__}: {exc}"
    with contextlib.suppress(OSError):
        text = text.replace(str(project.workspace_path()), "")
    return text[:300]


def _diagnostics_for_tracks(
    project: EpisodeProject,
    track_ids: list[str],
    timeline_start: float,
    timeline_end: float,
    *,
    pngs: bool = True,
) -> list[dict[str, Any]]:
    from podcast_mcp.edits.audio_quality import DiagnosticsWindowError, audio_diagnostics_report

    window = _clock_window(timeline_start, timeline_end)
    span = timeline_end - timeline_start
    visuals: list[dict[str, Any]] = []
    if span > MAX_DSP_WINDOW_SEC:
        reason = f"window_too_long:{span:.1f}s>{MAX_DSP_WINDOW_SEC:.0f}s"
        for tid in track_ids:
            visuals.append({"track_id": tid, "dsp_unavailable": True, "reason": reason})
        return visuals
    for tid in track_ids:
        try:
            report = audio_diagnostics_report(
                project,
                tid,
                start_sec=timeline_start,
                end_sec=timeline_end,
                pngs=pngs,
            )
            row: dict[str, Any] = {
                "track_id": tid,
                "window": report.get("window") or window,
                "astats": report.get("astats"),
                "hum": report.get("hum"),
            }
            if pngs:
                row["spectrogram_png"] = report.get("spectrogram_png")
                row["waveform_png"] = report.get("waveform_png")
            visuals.append(row)
        except DiagnosticsWindowError as exc:
            visuals.append({"track_id": tid, "dsp_unavailable": True, "reason": str(exc)[:300]})
        except Exception as exc:
            visuals.append(
                {
                    "track_id": tid,
                    "dsp_unavailable": True,
                    "reason": _safe_dsp_reason(exc, project),
                }
            )
    return visuals


def _enrich_visuals(
    visuals: list[dict[str, Any]],
    *,
    timeline_start: float,
    timeline_end: float,
    words_timeline: dict[str, list[tuple[float, str]]],
    comments: list[dict[str, Any]],
    edits: dict[str, Any],
    hypotheses: list[dict[str, Any]],
) -> None:
    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    plot = {
        "x0": 0.0,
        "x1": 1.0,
        "time_linear": True,
        "freq": "log",
        "read_for": "degradation_not_asr",
    }
    pending = edits.get("pending") or []
    eng = FFmpegEngine()
    for vis in visuals:
        if vis.get("dsp_unavailable") or vis.get("error"):
            continue
        tid = vis["track_id"]
        events = build_visual_events(
            track_id=tid,
            window_start=timeline_start,
            window_end=timeline_end,
            words=words_timeline.get(tid) or [],
            comments=comments,
            pending_edits=pending,
            hypotheses=hypotheses,
        )
        vis["plot"] = plot
        vis["events"] = events
        marks = _burn_marks(events)
        for png in (vis.get("spectrogram_png"), vis.get("waveform_png")):
            if not png:
                continue
            path = Path(png)
            if not path.is_file():
                continue
            try:
                eng.annotate_time_marks(
                    path,
                    marks,
                    path,
                    window_start=timeline_start,
                    window_end=timeline_end,
                )
            except Exception as exc:
                vis["annotate_error"] = type(exc).__name__


def _burn_marks(events: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    priority = {"hypothesis": 0, "pending_edit": 1, "comment": 2, "word": 3}
    ordered = sorted(events, key=lambda e: (priority.get(str(e.get("kind")), 9), e.get("t", 0)))
    marks: list[dict[str, Any]] = []
    for ev in ordered[:MAX_BURNED_LABELS]:
        label = ev.get("text") or ev.get("id") or ev.get("kind")
        if label is None:
            continue
        text = str(label)
        if len(text) > 24:
            text = text[:21] + "…"
        marks.append({"x": float(ev["x"]), "label": text, "kind": ev.get("kind")})
    return marks


def _has_any_words(
    project: EpisodeProject,
    track_id: str,
    spans: Sequence[tuple[Any, Any]],
) -> bool:
    tr = project.transcript_for_track(track_id)
    if not tr or not tr.words or not spans:
        return False
    for w in tr.words:
        for a, b in spans:
            if w.end > float(a) and w.start < float(b):
                return True
    return False


def _words_in_source_spans(
    project: EpisodeProject,
    track_id: str,
    spans: Sequence[tuple[Any, Any]],
) -> list[Any]:
    tr = project.transcript_for_track(track_id)
    if not tr or not tr.words or not spans:
        return []
    out = []
    for w in tr.words:
        if w.suppressed:
            continue
        for a, b in spans:
            if w.end > float(a) and w.start < float(b):
                out.append(w)
                break
    return out


def _clip_skew_warnings(
    source_at_mid: dict[str, float | None],
    *,
    skew_warn_sec: float,
) -> dict[str, Any]:
    """Report source-clock deltas at window mid. Do not flag desync.

    Per-track cuts make ``source_at_mid`` diverge; that is remaining-clip math.
    """
    pairs: list[dict[str, Any]] = []
    ids = [tid for tid, src in source_at_mid.items() if src is not None]
    for i, left in enumerate(ids):
        for right in ids[i + 1 :]:
            delta = abs(source_at_mid[left] - source_at_mid[right])  # type: ignore[operator]
            pairs.append(
                {
                    "track_a": left,
                    "track_b": right,
                    "source_delta_sec": round(delta, 6),
                    "skewed": False,
                }
            )
    return {
        "threshold_sec": skew_warn_sec,
        "pairs": pairs,
        "warnings": [],
        "any_skewed": False,
    }


def _summary(
    tracks: list[dict[str, Any]],
    warnings: list[str],
    comments: list[dict[str, Any]],
) -> str:
    bits = []
    for t in tracks:
        label = t["track_id"]
        text = t["text"] or "(silence / no words)"
        if len(text) > 120:
            text = text[:117] + "…"
        fx = t.get("effects") or []
        fx_note = f" [{len(fx)} fx]" if fx else ""
        bits.append(f"{label}: {text}{fx_note}")
    head = " | ".join(bits) if bits else "no dialogue tracks"
    extras = []
    if comments:
        extras.append(f"{len(comments)} comments")
    if warnings:
        extras.append(f"{len(warnings)} warnings")
    if extras:
        return f"{head}  [{', '.join(extras)}]"
    return head
