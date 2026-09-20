from __future__ import annotations

from podcast_mcp.edits.decisions import list_edit_decisions
from podcast_mcp.models import EditDecision, EditDecisionType, EpisodeProject


def test_list_edit_decisions_filters():
    proj = EpisodeProject.create("t", "/tmp/ws")
    proj.edit_decisions = [
        EditDecision(
            id="1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=0,
            end=1,
            reason="nl:x",
            review_required=True,
            applied=False,
        ),
        EditDecision(
            id="2",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=2,
            end=3,
            reason="filler:um",
            applied=True,
        ),
    ]
    pending = list_edit_decisions(proj, review_required=True)
    assert len(pending) == 1
    fillers = list_edit_decisions(proj, reason_prefix="filler:")
    assert len(fillers) == 1
    applied_only = list_edit_decisions(proj, applied=True)
    assert len(applied_only) == 1
    assert applied_only[0].id == "2"
    not_applied = list_edit_decisions(proj, applied=False)
    assert len(not_applied) == 1
