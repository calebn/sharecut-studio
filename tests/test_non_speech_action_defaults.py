"""Table-driven defaults for non-speech suggested actions (#1434)."""

from __future__ import annotations

import pytest

from podcast_mcp.edits.non_speech_suggestions import (
    NonSpeechAction,
    NonSpeechKind,
    classify_non_speech_kind,
    default_action_table,
    non_speech_view_for_decision,
)
from podcast_mcp.models import EditDecision, EpisodeProject


def test_default_action_table_matches_product_table() -> None:
    table = default_action_table()
    assert table[NonSpeechKind.FALSE_START] == NonSpeechAction.CUT
    assert table[NonSpeechKind.HARD_FILLER] == NonSpeechAction.CUT
    assert table[NonSpeechKind.MOUTH_SOUND] == NonSpeechAction.CUT
    assert table[NonSpeechKind.BREATH] == NonSpeechAction.LEAVE
    assert table[NonSpeechKind.LAUGH] == NonSpeechAction.LEAVE
    assert table[NonSpeechKind.BACKCHANNEL] == NonSpeechAction.LEAVE
    assert table[NonSpeechKind.PLAYFUL_VOCAL] == NonSpeechAction.LEAVE


@pytest.mark.parametrize(
    ("reason", "kind", "action"),
    [
        ("filler:acoustic:likely_laugh", NonSpeechKind.LAUGH, NonSpeechAction.LEAVE),
        ("filler:acoustic", NonSpeechKind.ACOUSTIC_UNKNOWN, NonSpeechAction.LEAVE),
        ("filler:um", NonSpeechKind.HARD_FILLER, NonSpeechAction.CUT),
        ("filler:mm-hmm", NonSpeechKind.BACKCHANNEL, NonSpeechAction.LEAVE),
        ("restart:phrase:I", NonSpeechKind.FALSE_START, NonSpeechAction.CUT),
        ("repetition:word:the", NonSpeechKind.FALSE_START, NonSpeechAction.CUT),
        ("pause:1.2s", None, None),
    ],
)
def test_classify_reason(
    reason: str, kind: NonSpeechKind | None, action: NonSpeechAction | None
) -> None:
    assert classify_non_speech_kind(reason) == kind
    if kind is None:
        return
    decision = EditDecision(
        id="d1",
        track_id="host",
        start=1.0,
        end=2.0,
        reason=reason,
        review_required=True,
        applied=False,
    )
    project = EpisodeProject.create("t", "/tmp")
    view = non_speech_view_for_decision(project, decision)
    assert view is not None
    assert view["non_speech_kind"] == kind.value
    assert view["suggested_action"] == action.value
