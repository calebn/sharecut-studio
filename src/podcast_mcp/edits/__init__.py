from typing import TYPE_CHECKING

from podcast_mcp.util.lazy_exports import resolve_export

if TYPE_CHECKING:
    from podcast_mcp.edits.context import build_edit_context, build_edit_context_json
    from podcast_mcp.edits.cut_application import apply_auto_edits, apply_edit_plan, approve_edits
    from podcast_mcp.edits.decisions import (
        edit_impact_report,
        format_edit_impact_markdown,
        list_edit_decisions,
        reject_edits,
        update_pending_edit,
    )
    from podcast_mcp.edits.tighten import (
        TightenProposal,
        analyze_fillers_and_pauses,
        apply_tighten_decisions,
        propose_tighten_edits,
    )
    from podcast_mcp.edits.tighten_intensity import (
        TIGHTEN_INTENSITIES,
        apply_tighten_intensity,
        normalize_tighten_intensity,
        with_tighten_intensity,
    )
    from podcast_mcp.edits.transcript_cuts import (
        cut_text_match,
        cut_time_range,
        cut_utterance,
        cut_words,
        format_transcript_timestamps,
        search_transcript,
    )

__all__ = [
    "TIGHTEN_INTENSITIES",
    "TightenProposal",
    "analyze_fillers_and_pauses",
    "apply_auto_edits",
    "apply_edit_plan",
    "apply_tighten_decisions",
    "apply_tighten_intensity",
    "approve_edits",
    "build_edit_context",
    "build_edit_context_json",
    "cut_text_match",
    "cut_time_range",
    "cut_utterance",
    "cut_words",
    "edit_impact_report",
    "format_edit_impact_markdown",
    "format_transcript_timestamps",
    "list_edit_decisions",
    "normalize_tighten_intensity",
    "propose_tighten_edits",
    "reject_edits",
    "search_transcript",
    "update_pending_edit",
    "with_tighten_intensity",
]

_MODULE_BY_NAME = {
    "build_edit_context": "context",
    "build_edit_context_json": "context",
    "apply_auto_edits": "cut_application",
    "apply_edit_plan": "cut_application",
    "approve_edits": "cut_application",
    "edit_impact_report": "decisions",
    "format_edit_impact_markdown": "decisions",
    "list_edit_decisions": "decisions",
    "reject_edits": "decisions",
    "update_pending_edit": "decisions",
    "TightenProposal": "tighten",
    "analyze_fillers_and_pauses": "tighten",
    "apply_tighten_decisions": "tighten",
    "propose_tighten_edits": "tighten",
    "TIGHTEN_INTENSITIES": "tighten_intensity",
    "apply_tighten_intensity": "tighten_intensity",
    "normalize_tighten_intensity": "tighten_intensity",
    "with_tighten_intensity": "tighten_intensity",
    "cut_text_match": "transcript_cuts",
    "cut_time_range": "transcript_cuts",
    "cut_utterance": "transcript_cuts",
    "cut_words": "transcript_cuts",
    "format_transcript_timestamps": "transcript_cuts",
    "search_transcript": "transcript_cuts",
}


def __getattr__(name: str) -> object:
    return resolve_export(name, package=__name__, namespace=globals(), modules=_MODULE_BY_NAME)
