"""The bleed mute, handoff cut and reconcile TypedDicts match the pinned wire output."""

import ast
from pathlib import Path

import pytest
from pydantic import TypeAdapter

from podcast_mcp.services.document import (
    BleedMuteApplied,
    BleedMuteDryRun,
    ReconcileTranscriptPreview,
    ReconcileTranscriptResult,
    SuggestHandoffCut,
)
from podcast_mcp.services.document import analysis_edit_results as results
from podcast_mcp.services.document.analysis_edit_results import (
    AlignmentApplied,
    AlignmentPreview,
    AlignmentProposal,
    AlignmentShift,
    AlignmentSkip,
    BleedMuteTarget,
    BleedReason,
    BleedReviewCandidate,
    BleedReviewClip,
    BleedReviewExclusion,
    BleedReviewInterval,
    BleedReviewTarget,
    BleedStemSkip,
    ReconcileReattributeRow,
    ReconcileSuppressRow,
    ReconcileWordRow,
)
from podcast_mcp.services.document.retained_bleed_results import (
    RetainedBleedAlignmentApplied,
    RetainedBleedAlignmentPreview,
    RetainedBleedAlignmentProposal,
)
from test_analysis_bleed_mute_wire import _CASES as _BLEED_CASES
from test_analysis_handoff_cut_wire import _HANDOFF_CASES
from test_analysis_reconcile_wire import _CASES as _RECONCILE_CASES

pytestmark = pytest.mark.unscoped_ok

_FIELDS = {
    "candidate_count",
    "candidates",
    "applied_count",
    "applied",
    "skipped",
    "speaker_errors",
    "review_candidate_count",
    "review_candidates",
    "review_exclusions",
    "review_exclusions_truncated",
    "review_reasons",
    "review_truncated",
}
_RECONCILE_FIELDS = {
    "suppress",
    "suppress_count",
    "unsuppress",
    "unsuppress_count",
    "reattribute",
    "reattribute_count",
    "status_updates",
    "reconciliation",
}
_WORD_ROW = {
    "track_id",
    "source_id",
    "word_index",
    "text",
    "start",
    "end",
    "audibility_status",
}


def _shape(td: type) -> tuple[set[str], set[str]]:
    return set(td.__required_keys__), set(td.__optional_keys__)


@pytest.mark.parametrize(
    ("td", "required", "optional"),
    [
        (BleedMuteDryRun, {*_FIELDS, "dry_run"}, {"alignment"}),
        (BleedMuteApplied, {*_FIELDS, "dry_run"}, {"alignment"}),
        (
            BleedMuteTarget,
            {
                "track_id",
                "stem_path",
                "window_start",
                "window_end",
                "interval_count",
                "word_count",
                "suppressed_words",
                "duration_sec",
                "attenuation_count",
                "attenuation_spans",
                "bleed_reduction",
                "bleed_bed_db",
                "gate_reasons",
                "room_tone_fill",
                "room_tone_fill_reason",
            },
            set(),
        ),
        (BleedReason, {"track_id", "reason"}, set()),
        (
            BleedStemSkip,
            {"track_id", "reason", "expected_duration_sec", "stem_duration_sec"},
            set(),
        ),
        (BleedReviewInterval, {"start", "end"}, set()),
        (
            BleedReviewClip,
            {
                "id",
                "track_id",
                "source_id",
                "source_start",
                "source_end",
                "timeline_start",
                "fade_in_ms",
                "fade_out_ms",
                "join_in_mode",
                "mute_regions",
            },
            {
                "off_speaker_mute_regions",
                "bleed_restore",
                "fade_in_curve",
                "fade_out_curve",
                "gain_db",
                "timing",
                "segment_ref",
            },
        ),
        (
            BleedReviewTarget,
            {"kind", "intervals", "track_ids", "clips", "media_seals"},
            set(),
        ),
        (
            BleedReviewCandidate,
            {
                "track_id",
                "peer_track_id",
                "timeline_start",
                "timeline_end",
                "source_id",
                "clip_id",
                "source_start",
                "source_end",
                "requires_review",
                "target",
                "automatic_refusal_reasons",
                "protection_basis",
            },
            set(),
        ),
        (BleedReviewExclusion, {"track_id", "start", "end", "reason"}, set()),
        (ReconcileWordRow, _WORD_ROW, set()),
        (ReconcileSuppressRow, {*_WORD_ROW, "dominant_track", "reason"}, set()),
        (
            ReconcileReattributeRow,
            {*_WORD_ROW, "dominant_track", "reason", "attributed_to_track"},
            set(),
        ),
        (ReconcileTranscriptPreview, {*_RECONCILE_FIELDS, "applied"}, set()),
        (ReconcileTranscriptResult, {*_RECONCILE_FIELDS, "applied"}, set()),
        (
            SuggestHandoffCut,
            {
                "track_id",
                "track_ids",
                "timebase",
                "keep_left_end",
                "keep_right_start",
                "islands",
                "out_island",
                "in_island",
                "cut_start",
                "cut_end",
                "retained_air_after_left_sec",
                "retained_air_before_right_sec",
                "use_inaudible_opt",
                "ok",
                "warnings",
                "hint",
            },
            set(),
        ),
        (AlignmentSkip, {"track_id", "reason"}, set()),
        (
            AlignmentPreview,
            {"proposed_count", "proposals", "skipped"},
            set(),
        ),
        (AlignmentApplied, {"applied_count", "alignments", "skipped"}, set()),
    ],
)
def test_required_and_optional_keys(td, required, optional):
    assert _shape(td) == (required, optional)


def test_module_has_no_future_import():
    tree = ast.parse(Path(results.__file__).read_text(encoding="utf-8"))
    imports = [n for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)]
    assert "__future__" not in {n.module for n in imports}


def test_typed_dicts_come_from_typing_extensions():
    source = Path(results.__file__).read_text(encoding="utf-8")
    assert "from typing_extensions import TypedDict" in source


def test_alignment_mirrors_follow_the_pydantic_models():
    assert set(AlignmentProposal.__annotations__) == set(
        RetainedBleedAlignmentProposal.model_fields
    )
    assert set(AlignmentPreview.__annotations__) == set(RetainedBleedAlignmentPreview.model_fields)
    assert set(AlignmentApplied.__annotations__) == set(RetainedBleedAlignmentApplied.model_fields)
    assert set(AlignmentShift.__annotations__) <= set(AlignmentProposal.__annotations__)


@pytest.mark.parametrize("name", list(_BLEED_CASES))
def test_bleed_mute_pins_validate(name):
    expected = _BLEED_CASES[name][4]
    adapter = TypeAdapter(BleedMuteDryRun | BleedMuteApplied)
    validated = adapter.validate_python(expected)
    assert adapter.dump_python(validated, mode="json") == expected


@pytest.mark.parametrize("name", list(_RECONCILE_CASES))
def test_reconcile_pins_validate(name):
    expected = _RECONCILE_CASES[name][3]
    adapter = TypeAdapter(ReconcileTranscriptPreview | ReconcileTranscriptResult)
    validated = adapter.validate_python(expected)
    assert adapter.dump_python(validated, mode="json") == expected


@pytest.mark.parametrize("name", list(_HANDOFF_CASES))
def test_handoff_cut_pins_validate(name):
    expected = _HANDOFF_CASES[name][-1]
    adapter = TypeAdapter(SuggestHandoffCut)
    validated = adapter.validate_python(expected)
    assert adapter.dump_python(validated, mode="json") == expected
