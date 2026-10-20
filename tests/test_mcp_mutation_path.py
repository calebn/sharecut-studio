from __future__ import annotations

import re
from pathlib import Path

_MCP = Path(__file__).resolve().parents[1] / "src/podcast_mcp/mcp"
_EDIT_SERVICE_CALL = re.compile(r"EditService\(\w+(?:\.\w+)*\)\s*\.\s*(\w+)\(")

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
        "join_label",
        "join_qa_sweep",
        "join_quality",
        "list_applied_edits",
        "list_bleed_words",
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
        "add_effect",
        "align_retained_bleed",
        "apply_auto",
        "apply_bleed_mute",
        "apply_fade_recommendations",
        "apply_plan",
        "apply_suggested_actions",
        "apply_transcript_cleanup",
        "correct_phrase",
        "correct_word",
        "crossfade_joins",
        "cut_range",
        "cut_text_match",
        "cut_time_range",
        "cut_utterance",
        "cut_words",
        "fade_joins",
        "fill_room_tone",
        "insert_gap",
        "move_by_text",
        "mute_off_speaker",
        "propose_tighten",
        "reconcile_transcript",
        "reject",
        "remove_chapter",
        "remove_effect",
        "revert_applied",
        "ripple_delete_text",
        "set_bleed_alignment_mode",
        "set_clip_fade",
        "set_effect_bypass",
        "set_word_automatic",
        "set_word_suppressed",
        "set_words_ignored",
        "shorten_word_gaps",
        "strip_silence",
        "suppress_bleed",
        "suppress_low_audibility",
        "update_pending",
        "verify_transcript",
    }
)
_DIRECT_MUTATIONS_SIZE = 40


def _called_methods() -> set[str]:
    return {
        match.group(1)
        for path in _MCP.rglob("*.py")
        for match in _EDIT_SERVICE_CALL.finditer(path.read_text(encoding="utf-8"))
    }


def test_mcp_tools_call_edit_service_only_for_reads_and_pending_mutations() -> None:
    assert _called_methods() == _READ_ONLY | _DIRECT_MUTATIONS


def test_direct_mutation_allowlist_only_shrinks() -> None:
    assert len(_DIRECT_MUTATIONS) == _DIRECT_MUTATIONS_SIZE
    assert not _READ_ONLY & _DIRECT_MUTATIONS
