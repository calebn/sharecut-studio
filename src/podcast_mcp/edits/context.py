from __future__ import annotations

import json
from typing import Any

from podcast_mcp.edits.decisions import edit_impact_report
from podcast_mcp.edits.transcript_cuts import (
    ensure_combined_transcript,
    format_transcript_timestamps,
)
from podcast_mcp.models import EpisodeProject


def build_edit_context(
    project: EpisodeProject,
    *,
    max_utterances: int = 200,
) -> dict[str, Any]:
    """Compact context for LLM agents (Cursor, Copilot, Claude Code) driving edits."""
    combined = ensure_combined_transcript(project)
    utterances = combined.utterances[:max_utterances]
    tracks = [
        {
            "id": t.id,
            "label": t.label,
            "role": t.role.value,
            "speaker": t.speaker,
            "duration_sec": t.media.duration_sec if t.media else None,
        }
        for t in project.tracks
    ]
    pending = [
        {
            "id": e.id,
            "track_id": e.track_id,
            "start": e.start,
            "end": e.end,
            "reason": e.reason,
            "review_required": e.review_required,
            "applied": e.applied,
        }
        for e in project.edit_decisions
        if e.review_required or not e.applied
    ]
    return {
        "name": project.name,
        "workspace_dir": project.workspace_dir,
        "tracks": tracks,
        "transcript_excerpt": [
            {
                "index": i,
                "track_id": u.track_id,
                "speaker": u.speaker,
                "start": u.start,
                "end": u.end,
                "text": u.text,
            }
            for i, u in enumerate(utterances)
        ],
        "transcript_timestamps": format_transcript_timestamps(project),
        "edit_decisions_pending": pending,
        "edit_impact": edit_impact_report(project),
        "tools_hint": (
            "Use search_transcript, cut_time_range, cut_text_match, cut_utterance, "
            "cut_words, apply_edit_plan, approve_edits, edit_impact_report, render_preview. "
            "Cuts are boundary-optimized by default (docs/inaudible-cuts.md); "
            "preview_inaudible_cut_tool or podcast edit preview-cut to inspect shifts; "
            "use_inaudible_opt=false or --no-inaudible-opt to disable per call. "
            "Raw audio in raw/ is never modified. "
            "Undoable state changes use ProjectWorkspace.mutate (docs/history.md)."
        ),
        "doc_refs": {
            "inaudible_cuts": "docs/inaudible-cuts.md",
            "nl_editing": "docs/nl-editing.md",
            "history": "docs/history.md",
            "contributing_history": "docs/contributing.md#history-non-destructive-undoable-state",
        },
    }


def build_edit_context_json(project: EpisodeProject, **kwargs: Any) -> str:
    return json.dumps(build_edit_context(project, **kwargs), indent=2)
