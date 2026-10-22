from __future__ import annotations

import ast
from pathlib import Path

_MCP = Path(__file__).resolve().parents[1] / "src/podcast_mcp/mcp"

_READ_ONLY = frozenset(
    {
        "_resolve",
        "analyze_cleanup",
        "audibility_map",
        "audio_diagnostics",
        "boundary_context",
        "build_context",
        "check_loudness",
        "copy_segment",
        "flagged_words",
        "gate_overreach",
        "impact_report",
        "inspect_clip_bleed",
        "join_label",
        "join_qa_sweep",
        "join_quality",
        "list_applied_edits",
        "list_bleed_words",
        "preview_reconcile_transcript",
        "preview_suppress_bleed",
        "list_chapters",
        "list_clips",
        "list_decisions",
        "list_effects",
        "low_audibility_words",
        "low_confidence_words",
        "overlap_duplicates",
        "preview_inaudible_cut",
        "preview_transcript_replacement",
        "recommend_fades",
        "reconciliation_status",
        "render_status",
        "search",
        "selected_range_target",
        "suggest_handoff_cut",
        "word_timing_context",
    }
)

# Mutating tools that still call EditService directly (#1809). Each migration moves a
# method into the document command catalog and shrinks this set and its size.
_DIRECT_MUTATIONS = frozenset(
    {
        "align_retained_bleed",
        "apply_auto",
        "apply_bleed_mute",
        "apply_fade_recommendations",
        "apply_plan",
        "crossfade_joins",
        "fade_joins",
        "fill_room_tone",
        "mute_off_speaker",
        "propose_tighten",
        "ripple_delete_text",
        "shorten_word_gaps",
        "strip_silence",
    }
)
_DIRECT_MUTATIONS_SIZE = 13
# TranscriptService also carries ASR and export entry points that predate the edit services.
_ASR_AND_EXPORT = frozenset({"transcribe", "seed", "get", "export_markdown", "export_subtitles"})
_EDIT_SERVICES = frozenset(
    {"EditService", "TimelineService", "AnalysisService", "TranscriptService"}
)


def _is_edit_service(node: ast.AST) -> bool:
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id in _EDIT_SERVICES
    )


def _methods_called_in(source: str) -> set[str]:
    tree = ast.parse(source)
    bound = {
        target.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Assign) and _is_edit_service(node.value)
        for target in node.targets
        if isinstance(target, ast.Name)
    }
    return {
        node.func.attr
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr not in _ASR_AND_EXPORT
        and (
            _is_edit_service(node.func.value)
            or (isinstance(node.func.value, ast.Name) and node.func.value.id in bound)
        )
    }


def _called_methods() -> set[str]:
    return {
        method
        for path in _MCP.rglob("*.py")
        for method in _methods_called_in(path.read_text(encoding="utf-8"))
    }


def test_mcp_tools_call_edit_service_only_for_reads_and_pending_mutations() -> None:
    assert _called_methods() == _READ_ONLY | _DIRECT_MUTATIONS


def test_direct_mutation_allowlist_only_shrinks() -> None:
    assert len(_DIRECT_MUTATIONS) == _DIRECT_MUTATIONS_SIZE
    assert not _READ_ONLY & _DIRECT_MUTATIONS
