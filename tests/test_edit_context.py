from __future__ import annotations

from podcast_mcp.edits.context import build_edit_context
from podcast_mcp.models import CombinedTranscript, CombinedUtterance, EpisodeProject


def test_build_edit_context_includes_tools_hint():
    proj = EpisodeProject.create("t", "/tmp/ws")
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=1.0,
                text="Hello",
            )
        ]
    )
    ctx = build_edit_context(proj)
    assert ctx["tools_hint"]
    assert "inaudible-cuts" in ctx["tools_hint"]
    assert ctx["doc_refs"]["inaudible_cuts"] == "docs/inaudible-cuts.md"
    assert ctx["doc_refs"]["history"] == "docs/history.md"
    assert "mutate" in ctx["tools_hint"]
    assert len(ctx["transcript_excerpt"]) == 1
