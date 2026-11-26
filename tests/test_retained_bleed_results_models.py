from __future__ import annotations

import dataclasses
import json

import pytest
from pydantic import ValidationError
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.edits.retained_bleed_alignment import (
    PhraseAlignmentProposal,
    apply_retained_bleed_alignment,
    plan_retained_bleed_alignment,
    set_retained_bleed_alignment_mode,
)
from podcast_mcp.mcp.tools import transcript
from podcast_mcp.models.episode import RetainedBleedAlignmentDecision
from podcast_mcp.services.document import (
    AnalysisService,
    RetainedBleedAlignmentApplied,
    RetainedBleedAlignmentModeResult,
    RetainedBleedAlignmentPreview,
)
from podcast_mcp.services.document import analysis as analysis_module
from podcast_mcp.services.document.analysis import _alignment_preview
from podcast_mcp.services.document.retained_bleed_results import (
    RetainedBleedAlignmentProposal,
    RetainedBleedAlignmentRow,
    RetainedBleedAlignmentSkip,
    retained_bleed_applied,
    retained_bleed_mode,
    retained_bleed_preview,
)
from test_bleed_alignment_surfaces import _workspace

pytestmark = pytest.mark.unscoped_ok

WINDOW = {"track_id": "uncertain", "start_sec": 0.8, "end_sec": 3.5}
MODELS = (
    RetainedBleedAlignmentProposal,
    RetainedBleedAlignmentSkip,
    RetainedBleedAlignmentPreview,
    RetainedBleedAlignmentRow,
    RetainedBleedAlignmentApplied,
    RetainedBleedAlignmentModeResult,
)


def _plan(ws):
    return plan_retained_bleed_alignment(
        ws.project, defaults=ws.effective_config(), **WINDOW, override_placement_lock=False
    )


def test_models_are_frozen_and_forbid_extras() -> None:
    for model in MODELS:
        assert model.model_config["frozen"] is True
        assert model.model_config["extra"] == "forbid"


def test_proposal_fields_follow_dataclass_order() -> None:
    names = [f.name for f in dataclasses.fields(PhraseAlignmentProposal)]
    assert list(RetainedBleedAlignmentProposal.model_fields) == names


def test_mode_result_fields_follow_decision_order() -> None:
    assert list(RetainedBleedAlignmentModeResult.model_fields) == list(
        RetainedBleedAlignmentDecision.model_fields
    )


def test_facade_exports_are_the_module_classes() -> None:
    assert (
        RetainedBleedAlignmentPreview
        is retained_bleed_preview({"proposed_count": 0, "proposals": [], "skipped": []}).__class__
    )


def test_engine_output_round_trips_with_matching_keys(tmp_path) -> None:
    ws = _workspace(tmp_path)
    preview = _alignment_preview(_plan(ws))
    model = retained_bleed_preview(preview)
    assert model.proposed_count == 1
    assert list(model.model_dump()) == list(preview)
    assert list(model.model_dump()["proposals"][0]) == list(preview["proposals"][0])
    assert model.model_dump() == json.loads(json.dumps(preview))
    assert model.model_dump() == model.model_dump(mode="json")
    assert type(model.proposals[0].reference_track_ids) is list

    applied = apply_retained_bleed_alignment(ws.project, _plan(ws), defaults=ws.effective_config())
    applied_model = retained_bleed_applied(applied)
    assert applied_model.applied_count == 1
    assert list(applied_model.model_dump()["alignments"][0]) == list(applied["alignments"][0])
    assert applied_model.model_dump() == applied_model.model_dump(mode="json")

    decision_id = applied["alignments"][0]["decision_id"]
    mode = set_retained_bleed_alignment_mode(ws.project, decision_id, "declined")
    mode_model = retained_bleed_mode(mode)
    assert list(mode_model.model_dump()) == list(mode)
    assert mode_model.model_dump() == mode_model.model_dump(mode="json")


def test_frozen_instances_reject_assignment() -> None:
    skip = RetainedBleedAlignmentSkip(track_id="a", reason="b")
    with pytest.raises(ValidationError):
        skip.reason = "c"


def test_unknown_key_and_bad_literal_rejected() -> None:
    with pytest.raises(ValidationError):
        retained_bleed_preview({"proposed_count": 0, "proposals": [], "skipped": [], "x": 1})
    with pytest.raises(ValidationError):
        retained_bleed_mode(
            {
                "start_s": 0.0,
                "end_s": 1.0,
                "id": "a",
                "direct_track_id": "d",
                "bleed_track_id": "b",
                "source_id": None,
                "media_key": None,
                "mode": "other",
                "offset_sec": 0.0,
                "previous_timeline_start": 0.0,
                "timeline_start": 0.0,
                "provenance": "automatic",
                "evidence_revision": 1,
            }
        )


def test_non_ascii_track_id_matches_on_cli_and_mcp_preview(tmp_path, monkeypatch) -> None:
    ws = _workspace(tmp_path)
    original = analysis_module.plan_retained_bleed_alignment

    def renamed(*args, **kwargs):
        plan = original(*args, **kwargs)
        return dataclasses.replace(
            plan, skipped=({"track_id": "Hôte", "reason": "no_retained_bleed_candidate"},)
        )

    monkeypatch.setattr(analysis_module, "plan_retained_bleed_alignment", renamed)
    mcp_text = transcript.align_retained_bleed_tool(str(ws.path), apply=False, **WINDOW)
    cli = CliRunner().invoke(
        app,
        [
            "edit",
            "align-retained-bleed",
            "--project",
            str(ws.path),
            "--dry-run",
            "--track",
            "uncertain",
            "--start",
            "0.8",
            "--end",
            "3.5",
        ],
    )
    assert cli.exit_code == 0
    assert "H\\u00f4te" in mcp_text
    assert mcp_text == cli.output.rstrip("\n")
    direct = json.dumps(
        AnalysisService(ws).preview_retained_bleed_alignment(**WINDOW).model_dump(), indent=2
    )
    assert direct == mcp_text
