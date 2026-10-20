"""Tighten analysis: filler, pause, repetition and restart cut proposals.

``analyze_fillers_and_pauses`` is the facade over the analysis modules; the
``propose`` module turns its result into reviewable edit decisions.
"""

from __future__ import annotations

from podcast_mcp.edits.tighten.apply import analyze_fillers_and_pauses
from podcast_mcp.edits.tighten.candidate import normalize_edit_mode
from podcast_mcp.edits.tighten.lexicon import lexicon_tokens
from podcast_mcp.edits.tighten.propose import (
    TightenProposal,
    apply_tighten_decisions,
    format_tighten_propose_summary,
    propose_tighten_edits,
)

__all__ = [
    "TightenProposal",
    "analyze_fillers_and_pauses",
    "apply_tighten_decisions",
    "format_tighten_propose_summary",
    "lexicon_tokens",
    "normalize_edit_mode",
    "propose_tighten_edits",
]
