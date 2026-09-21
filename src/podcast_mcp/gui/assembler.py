"""ProjectView construction and dump. Re-exports ViewProjection types as the compatibility path."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

from podcast_mcp.edits.comments import comments_for_view
from podcast_mcp.gui.mapper import (
    map_applied_edits_to_timeline,
    map_edit_boundaries,
    map_pending_edits_to_timeline,
    map_transcript_utterances_to_timeline,
    social_clips_for_view,
)
from podcast_mcp.gui.peaks import resolve_peaks_path
from podcast_mcp.gui.schemas import ProjectView, TrackView
from podcast_mcp.services import EditService, HistoryService, ProjectWorkspace
from podcast_mcp.services.document_sync.projection_types import (
    VIEW_PROJECTION_QUERY_DESCRIPTION,
    ViewProjection,
    parse_view_projection,
)
from podcast_mcp.services.transcript import TranscriptService

__all__ = [
    "VIEW_PROJECTION_QUERY_DESCRIPTION",
    "ViewProjection",
    "build_project_view",
    "dump_project_projection",
    "parse_view_projection",
]


def _workspace(source: Path | ProjectWorkspace) -> tuple[ProjectWorkspace, Path]:
    if isinstance(source, ProjectWorkspace):
        return source, source.path
    ws = ProjectWorkspace.open(source)
    return ws, ws.path


def _freshness_patch(
    ws: ProjectWorkspace,
    extra: dict[str, Any],
    *,
    edit: EditService | None = None,
) -> dict[str, Any]:
    svc = edit if edit is not None else EditService(ws)
    status = svc.render_status()
    return {
        **extra,
        "tracks": [t.model_dump() for t in build_track_views(ws, edit=svc, render_status=status)],
        "render_status": status,
    }


def _hydration(*, transcript_words: bool, history_groups: bool) -> dict[str, bool]:
    return {
        "transcript_words": transcript_words,
        "history_groups": history_groups,
    }


def _raw_transcript(ws: ProjectWorkspace) -> dict[str, Any] | None:
    project = ws.project
    if project.combined_transcript is not None:
        return project.combined_transcript.model_dump()
    if project.transcripts:
        try:
            import json

            return json.loads(TranscriptService(ws).get(combined=True))
        except (ValueError, TypeError):
            return None
    return None


def _effects_by_track(edit: EditService, ws: ProjectWorkspace) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {}
    for track in ws.project.tracks:
        fx = edit.list_effects(track_id=track.id)
        out[track.id] = fx.get("effects", [])
    return out


def build_track_views(
    ws: ProjectWorkspace,
    *,
    edit: EditService | None = None,
    render_status: dict[str, Any] | None = None,
    effects_by_track: dict[str, list[dict[str, Any]]] | None = None,
) -> list[TrackView]:
    project = ws.project
    svc = edit if edit is not None else EditService(ws)
    status = render_status if render_status is not None else svc.render_status()
    fx_map = effects_by_track if effects_by_track is not None else _effects_by_track(svc, ws)
    track_views: list[TrackView] = []
    for track in project.tracks:
        stem = status.get("tracks", {}).get(track.id, {})
        track_views.append(
            TrackView(
                id=track.id,
                label=track.label,
                role=track.role.value if hasattr(track.role, "value") else str(track.role),
                speaker=track.speaker,
                gain_db=track.gain_db,
                muted=track.muted,
                duration_sec=track.media.duration_sec if track.media else None,
                fx_count=len(fx_map.get(track.id, [])),
                stem_is_fresh=stem.get("stem_is_fresh"),
                has_source_audio=track.media is not None,
                media_path=track.media.path if track.media else None,
            )
        )
    return track_views


def build_project_view(
    source: Path | ProjectWorkspace,
    *,
    projection: ViewProjection | str = ViewProjection.FULL,
    history: dict[str, Any] | None = None,
) -> ProjectView:
    """Assemble a DAW ProjectView.

    ``FULL`` includes transcript ``words[]`` and history groups.
    ``SHELL`` omits those heavy keys and sets ``meta.hydration`` flags.
    Other projections raise — use :func:`dump_project_projection`.
    Pass ``history`` to reuse a precomputed ``HistoryService.list_entries()`` result.
    """
    proj = (
        projection
        if isinstance(projection, ViewProjection)
        else parse_view_projection(
            str(projection),
            default=ViewProjection.FULL,
        )
    )
    if proj not in (ViewProjection.FULL, ViewProjection.SHELL):
        raise ValueError(f"build_project_view does not support projection {proj}")

    ws, project_path = _workspace(source)
    edit = EditService(ws)
    history_svc = HistoryService(ws)
    project = ws.project
    include_words = proj is ViewProjection.FULL

    clips = edit.list_clips()
    render_status = edit.render_status()
    pending = edit.list_decisions(applied=False)
    applied = edit.list_applied_edits()
    chapters = edit.list_chapters()
    impact = edit.impact_report()
    if not isinstance(impact, dict):
        impact = {}

    effects_by_track = _effects_by_track(edit, ws)
    track_views = build_track_views(
        ws,
        edit=edit,
        render_status=render_status,
        effects_by_track=effects_by_track,
    )
    peaks_index = {t.id: resolve_peaks_path(project, t.id) is not None for t in project.tracks}

    transcript = map_transcript_utterances_to_timeline(
        project,
        _raw_transcript(ws),
        include_words=include_words,
    )

    duration = float(clips.get("timeline_duration_sec") or project.timeline.duration_sec or 0.0)

    if include_words:
        history_payload = history if history is not None else history_svc.list_entries()
    else:
        hist_status = history_svc.status()
        history_payload = {
            "cursor": hist_status["cursor"],
            "can_undo": hist_status["can_undo"],
            "can_redo": hist_status["can_redo"],
            "entries": [],
            "groups": [],
        }

    meta: dict[str, Any] = {
        "name": project.meta.name,
        "workspace_dir": str(project.meta.workspace_dir),
        "hydration": _hydration(
            transcript_words=include_words,
            history_groups=include_words,
        ),
    }

    return ProjectView(
        project_path=str(project_path.resolve()),
        meta=meta,
        timeline_duration_sec=duration,
        tracks=track_views,
        clips=clips,
        chapters=chapters,
        pending_edits=map_pending_edits_to_timeline(project, pending),
        edit_boundaries=map_edit_boundaries(project),
        applied_edits=map_applied_edits_to_timeline(project, applied),
        effects_by_track=effects_by_track,
        envelopes=[e.model_dump() for e in project.mix.automation_envelopes],
        social_clips=social_clips_for_view(project),
        comments=comments_for_view(project),
        render_status=render_status,
        edit_impact=impact,
        history=history_payload,
        transcript=transcript,
        peaks_index=peaks_index,
    )


def dump_project_projection(
    source: Path | ProjectWorkspace,
    *,
    projection: ViewProjection | str = ViewProjection.SHELL,
    history: dict[str, Any] | None = None,
    audience: Literal["host", "guest"] = "host",
) -> dict[str, Any]:
    """Dict payload for HTTP/WS. ``SHELL``/``FULL`` are complete views; others are patches.

    Guest DETAIL is hydration flags only (no ``words[]`` or history).
    ``sanitize_guest_project_view`` only strips paths. CLIPS/FX/ENVELOPES include
    ``tracks`` + ``render_status`` so stem freshness updates with the slice.
    """
    proj = (
        projection
        if isinstance(projection, ViewProjection)
        else parse_view_projection(str(projection))
    )
    ws, _path = _workspace(source)
    if proj is ViewProjection.TRACKS:
        return {"tracks": [t.model_dump() for t in build_track_views(ws)]}
    if proj is ViewProjection.COMMENTS:
        return {"comments": comments_for_view(ws.project)}
    if proj is ViewProjection.CLIPS:
        edit = EditService(ws)
        return _freshness_patch(ws, {"clips": edit.list_clips()}, edit=edit)
    if proj is ViewProjection.FX:
        edit = EditService(ws)
        return _freshness_patch(ws, {"effects_by_track": _effects_by_track(edit, ws)}, edit=edit)
    if proj is ViewProjection.ENVELOPES:
        return _freshness_patch(
            ws,
            {"envelopes": [e.model_dump() for e in ws.project.mix.automation_envelopes]},
        )
    if proj is ViewProjection.DETAIL:
        if audience == "guest":
            return {
                "meta": {
                    "hydration": _hydration(
                        transcript_words=False,
                        history_groups=False,
                    ),
                },
            }
        hist = history if history is not None else HistoryService(ws).list_entries()
        transcript = map_transcript_utterances_to_timeline(
            ws.project,
            _raw_transcript(ws),
            include_words=True,
        )
        return {
            "transcript": transcript,
            "history": hist,
            "meta": {
                "hydration": _hydration(transcript_words=True, history_groups=True),
            },
        }
    return build_project_view(ws, projection=proj, history=history).model_dump()
