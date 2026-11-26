"""Pin the exact wire output of retained-bleed alignment across every surface."""

from __future__ import annotations

import dataclasses
import json
import re
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.mcp.tools import timeline, transcript
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import AnalysisService
from podcast_mcp.services.document import analysis as analysis_module
from podcast_mcp.services.document_sync import (
    DocumentSyncService,
    host_command_result,
    submit_host_document_command,
)
from podcast_mcp.services.document_sync.handlers import edits as edit_handlers
from podcast_mcp.services.jobs import run_audio_edit
from podcast_mcp.services.pipeline.preview import rerender_preview
from podcast_mcp.util.coded_error import CodedError
from test_bleed_alignment_surfaces import _workspace
from test_retained_bleed_alignment import _two_phrase_episode

pytestmark = pytest.mark.unscoped_ok

_DIGEST = "sha256:" + "dfe3edfeca82502862f9" + "72cc905af9294021af4e" + "6afaef97cf6ebb29d242c621"
_FIRST_ID = "910dadf1-7b0f-58de-aa06-57264e1a205e"
_SECOND_ID = "f13767b0-1adc-5287-b035-c0286e54d337"
_WINDOW = {"track_id": "uncertain", "start_sec": 0.8, "end_sec": 3.5}
_MODES = ["auto", "manual", "declined"]
_CLI_FLAGS = {"track_id": "--track", "start_sec": "--start", "end_sec": "--end"}


def _wire(result):
    return result if isinstance(result, dict) else result.model_dump()


def _t(text: str) -> str:
    return text.replace("__DIGEST__", _DIGEST).strip("\n")


def _dump(value) -> str:
    return json.dumps(_wire(value), indent=2)


_PROPOSAL_FIRST = """
    {
      "decision_id": "910dadf1-7b0f-58de-aa06-57264e1a205e",
      "direct_track_id": "direct",
      "bleed_track_id": "uncertain",
      "clip_id": "clip-direct",
      "source_id": null,
      "source_start": 1.18,
      "source_end": 3.2199999999999998,
      "phrase_source_start": 1.2,
      "phrase_source_end": 3.2,
      "previous_timeline_start": 1.18,
      "timeline_start": 1.03,
      "offset_sec": -0.15,
      "provenance": "automatic",
      "validation_windows": 5,
      "max_residual_ms": 0.0,
      "reference_track_ids": [
        "uncertain"
      ],
      "media_key": "__DIGEST__"
    }"""

_PROPOSAL_SECOND = """
    {
      "decision_id": "f13767b0-1adc-5287-b035-c0286e54d337",
      "direct_track_id": "direct",
      "bleed_track_id": "uncertain",
      "clip_id": "clip-direct",
      "source_id": null,
      "source_start": 4.180000000000001,
      "source_end": 6.22,
      "phrase_source_start": 4.2,
      "phrase_source_end": 6.2,
      "previous_timeline_start": 4.180000000000001,
      "timeline_start": 4.03,
      "offset_sec": -0.15,
      "provenance": "automatic",
      "validation_windows": 5,
      "max_residual_ms": 0.0,
      "reference_track_ids": [
        "uncertain"
      ],
      "media_key": "__DIGEST__"
    }"""

_SKIPPED_NO_CANDIDATE = """
    {
      "track_id": "direct",
      "reason": "no_retained_bleed_candidate"
    }"""

_PREVIEW_ONE = _t(
    """
{
  "proposed_count": 1,
  "proposals": ["""
    + _PROPOSAL_FIRST
    + """
  ],
  "skipped": []
}
"""
)

_PREVIEW_TWO_WITH_SKIPPED = _t(
    """
{
  "proposed_count": 2,
  "proposals": ["""
    + _PROPOSAL_FIRST
    + ","
    + _PROPOSAL_SECOND
    + """
  ],
  "skipped": ["""
    + _SKIPPED_NO_CANDIDATE
    + """
  ]
}
"""
)

_PREVIEW_ONE_WITH_SKIPPED = _t(
    """
{
  "proposed_count": 1,
  "proposals": ["""
    + _PROPOSAL_FIRST
    + """
  ],
  "skipped": ["""
    + _SKIPPED_NO_CANDIDATE
    + """
  ]
}
"""
)

_PREVIEW_NONE_WITH_SKIPPED = _t(
    """
{
  "proposed_count": 0,
  "proposals": [],
  "skipped": ["""
    + _SKIPPED_NO_CANDIDATE
    + """
  ]
}
"""
)

_PREVIEW_EMPTY = _t(
    """
{
  "proposed_count": 0,
  "proposals": [],
  "skipped": []
}
"""
)

_ALIGNMENT_FIRST = """
    {
      "decision_id": "910dadf1-7b0f-58de-aa06-57264e1a205e",
      "direct_track_id": "direct",
      "bleed_track_id": "uncertain",
      "source_id": null,
      "source_start": 1.18,
      "source_end": 3.2199999999999998,
      "previous_timeline_start": 1.18,
      "timeline_start": 1.03,
      "offset_sec": -0.15
    }"""

_ALIGNMENT_SECOND = """
    {
      "decision_id": "f13767b0-1adc-5287-b035-c0286e54d337",
      "direct_track_id": "direct",
      "bleed_track_id": "uncertain",
      "source_id": null,
      "source_start": 4.180000000000001,
      "source_end": 6.22,
      "previous_timeline_start": 4.180000000000001,
      "timeline_start": 4.03,
      "offset_sec": -0.15
    }"""

_APPLY_ONE = _t(
    """
{
  "applied_count": 1,
  "alignments": ["""
    + _ALIGNMENT_FIRST
    + """
  ],
  "skipped": []
}
"""
)

_APPLY_ONE_WITH_SKIPPED = _t(
    """
{
  "applied_count": 1,
  "alignments": ["""
    + _ALIGNMENT_FIRST
    + """
  ],
  "skipped": ["""
    + _SKIPPED_NO_CANDIDATE
    + """
  ]
}
"""
)

_APPLY_TWO_WITH_SKIPPED = _t(
    """
{
  "applied_count": 2,
  "alignments": ["""
    + _ALIGNMENT_FIRST
    + ","
    + _ALIGNMENT_SECOND
    + """
  ],
  "skipped": ["""
    + _SKIPPED_NO_CANDIDATE
    + """
  ]
}
"""
)

_APPLY_NOTHING = _t(
    """
{
  "applied_count": 0,
  "alignments": [],
  "skipped": []
}
"""
)

_APPLY_NOTHING_SAVED = """
{
  "applied_count": 0,
  "alignments": [],
  "skipped": [
    {
      "track_id": "direct",
      "reason": "__REASON__"
    }
  ]
}
"""

_DECISION_EXISTING = """
{
  "start_s": 1.2,
  "end_s": 3.2,
  "id": "910dadf1-7b0f-58de-aa06-57264e1a205e",
  "direct_track_id": "direct",
  "bleed_track_id": "uncertain",
  "source_id": null,
  "media_key": "__DIGEST__",
  "mode": "__MODE__",
  "offset_sec": -0.15,
  "previous_timeline_start": 1.18,
  "timeline_start": 1.03,
  "provenance": "automatic",
  "evidence_revision": 5
}
"""

_DECISION_PROPOSAL = """
{
  "start_s": 1.2,
  "end_s": 3.2,
  "id": "910dadf1-7b0f-58de-aa06-57264e1a205e",
  "direct_track_id": "direct",
  "bleed_track_id": "uncertain",
  "source_id": null,
  "media_key": "__DIGEST__",
  "mode": "__MODE__",
  "offset_sec": 0.0,
  "previous_timeline_start": 1.18,
  "timeline_start": 1.18,
  "provenance": "automatic",
  "evidence_revision": 5
}
"""

_ROW_EXISTING = """
{
  "type": "SetBleedAlignmentMode",
  "payload": {
    "decision_id": "910dadf1-7b0f-58de-aa06-57264e1a205e",
    "mode": "__MODE__",
    "track_id": null,
    "start_sec": null,
    "end_sec": null,
    "override_placement_lock": false,
    "result": {
      "start_s": 1.2,
      "end_s": 3.2,
      "id": "910dadf1-7b0f-58de-aa06-57264e1a205e",
      "direct_track_id": "direct",
      "bleed_track_id": "uncertain",
      "source_id": null,
      "media_key": "__DIGEST__",
      "mode": "__MODE__",
      "offset_sec": -0.15,
      "previous_timeline_start": 1.18,
      "timeline_start": 1.03,
      "provenance": "automatic",
      "evidence_revision": 5
    }
  }
}
"""

_ROW_PROPOSAL = """
{
  "type": "SetBleedAlignmentMode",
  "payload": {
    "decision_id": "910dadf1-7b0f-58de-aa06-57264e1a205e",
    "mode": "__MODE__",
    "track_id": "uncertain",
    "start_sec": 0.8,
    "end_sec": 3.5,
    "override_placement_lock": false,
    "result": {
      "start_s": 1.2,
      "end_s": 3.2,
      "id": "910dadf1-7b0f-58de-aa06-57264e1a205e",
      "direct_track_id": "direct",
      "bleed_track_id": "uncertain",
      "source_id": null,
      "media_key": "__DIGEST__",
      "mode": "__MODE__",
      "offset_sec": 0.0,
      "previous_timeline_start": 1.18,
      "timeline_start": 1.18,
      "provenance": "automatic",
      "evidence_revision": 5
    }
  }
}
"""

_DECISION_KEYS = [
    "start_s",
    "end_s",
    "id",
    "direct_track_id",
    "bleed_track_id",
    "source_id",
    "media_key",
    "mode",
    "offset_sec",
    "previous_timeline_start",
    "timeline_start",
    "provenance",
    "evidence_revision",
]

_PROPOSAL_KEYS = [
    "decision_id",
    "direct_track_id",
    "bleed_track_id",
    "clip_id",
    "source_id",
    "source_start",
    "source_end",
    "phrase_source_start",
    "phrase_source_end",
    "previous_timeline_start",
    "timeline_start",
    "offset_sec",
    "provenance",
    "validation_windows",
    "max_residual_ms",
    "reference_track_ids",
    "media_key",
]

_ALIGNMENT_KEYS = [
    "decision_id",
    "direct_track_id",
    "bleed_track_id",
    "source_id",
    "source_start",
    "source_end",
    "previous_timeline_start",
    "timeline_start",
    "offset_sec",
]

_NOT_FOUND = (
    "unknown retained-bleed alignment decision 'nope'. "
    "List the alignment decisions and pick one of them."
)
_STALE = "retained-bleed alignment plan is stale. Plan the alignment again."
_INVALID_MODE = "alignment mode must be auto, manual, or declined"
_DEBUG_HINT = "(set PODCAST_DEBUG=1 for the traceback)"


def _single(tmp_path: Path) -> ProjectWorkspace:
    return _workspace(tmp_path)


def _double(tmp_path: Path) -> ProjectWorkspace:
    project = _two_phrase_episode(tmp_path)
    rerender_preview(project, reconcile=False, defaults=load_defaults())
    ws = ProjectWorkspace(tmp_path / "episode.sharecut", project)
    ws.save()
    return ws


_BUILDERS = {"single": _single, "double": _double}


def _prep_none(ws: ProjectWorkspace) -> None:
    return None


def _prep_applied(ws: ProjectWorkspace) -> None:
    AnalysisService(ws).align_retained_bleed(**_WINDOW)


def _prep_saved(mode: str):
    def prep(ws: ProjectWorkspace) -> None:
        AnalysisService(ws).set_bleed_alignment_mode(_FIRST_ID, mode, **_WINDOW)

    return prep


def _cli_scope(params: dict) -> list[str]:
    args: list[str] = []
    for name, value in params.items():
        args += [_CLI_FLAGS[name], str(value)]
    return args


def _cli_text(result) -> str:
    assert result.exit_code == 0, result.output
    assert result.output.endswith("\n")
    return result.output[:-1]


def _preview_surface(surface: str, ws: ProjectWorkspace, params: dict) -> str:
    if surface == "service":
        return _dump(AnalysisService(ws).preview_retained_bleed_alignment(**params))
    if surface == "service_apply_false":
        return _dump(AnalysisService(ws).align_retained_bleed(apply=False, **params))
    if surface == "cli":
        args = ["edit", "align-retained-bleed", "--project", str(ws.path), "--dry-run"]
        return _cli_text(CliRunner().invoke(app, [*args, *_cli_scope(params)]))
    return transcript.align_retained_bleed_tool(str(ws.path), apply=False, **params)


def _apply_surface(surface: str, ws: ProjectWorkspace, params: dict) -> str:
    if surface == "service":
        return _dump(AnalysisService(ws).align_retained_bleed(**params))
    if surface == "job":
        return _dump(run_audio_edit(ws, "align_retained_bleed", dict(params), lock_timeout=5.0))
    if surface == "cli":
        args = ["edit", "align-retained-bleed", "--project", str(ws.path)]
        return _cli_text(CliRunner().invoke(app, [*args, *_cli_scope(params)]))
    return transcript.align_retained_bleed_tool(str(ws.path), **params)


def _journal(path: Path) -> list[dict]:
    return DocumentSyncService.open(path).store.commands_after(0)


def _journal_types(path: Path) -> list[str]:
    return [row["type"] for row in _journal(path)]


_PREVIEW_SURFACES = ["service", "service_apply_false", "cli", "mcp"]
_APPLY_SURFACES = ["service", "cli", "mcp", "job"]

_PREVIEW_CASES = [
    pytest.param("single", _prep_none, _WINDOW, _PREVIEW_ONE, id="several-window-one"),
    pytest.param("double", _prep_none, {}, _PREVIEW_TWO_WITH_SKIPPED, id="several-all-two"),
    pytest.param("single", _prep_none, {}, _PREVIEW_ONE_WITH_SKIPPED, id="all-one-skipped"),
    pytest.param(
        "single",
        _prep_none,
        {"track_id": "direct"},
        _PREVIEW_NONE_WITH_SKIPPED,
        id="none-skipped",
    ),
    pytest.param("single", _prep_applied, _WINDOW, _PREVIEW_EMPTY, id="none-empty-after-apply"),
]

_APPLY_CASES = [
    pytest.param("single", _prep_none, _WINDOW, _APPLY_ONE, id="window"),
    pytest.param("single", _prep_none, {}, _APPLY_ONE_WITH_SKIPPED, id="all-with-skipped"),
    pytest.param("double", _prep_none, {}, _APPLY_TWO_WITH_SKIPPED, id="two-alignments"),
    pytest.param("single", _prep_applied, _WINDOW, _APPLY_NOTHING, id="nothing-to-apply"),
    pytest.param(
        "single",
        _prep_saved("manual"),
        _WINDOW,
        _t(_APPLY_NOTHING_SAVED.replace("__REASON__", "saved_manual_decision")),
        id="saved-manual",
    ),
    pytest.param(
        "single",
        _prep_saved("declined"),
        _WINDOW,
        _t(_APPLY_NOTHING_SAVED.replace("__REASON__", "saved_declined_decision")),
        id="saved-declined",
    ),
]


@pytest.mark.parametrize("surface", _PREVIEW_SURFACES)
@pytest.mark.parametrize(("kind", "prep", "params", "expected"), _PREVIEW_CASES)
def test_preview_wire_text(tmp_path, surface, kind, prep, params, expected):
    ws = _BUILDERS[kind](tmp_path)
    prep(ws)
    assert _preview_surface(surface, ws, params) == expected


@pytest.mark.parametrize("surface", _PREVIEW_SURFACES)
def test_preview_does_not_touch_project_or_journal(tmp_path, surface):
    ws = _single(tmp_path)
    before = ws.path.read_bytes()
    _preview_surface(surface, ws, _WINDOW)
    assert ws.path.read_bytes() == before
    assert _journal_types(ws.path) == []


@pytest.mark.parametrize("surface", _APPLY_SURFACES)
@pytest.mark.parametrize(("kind", "prep", "params", "expected"), _APPLY_CASES)
def test_apply_wire_text(tmp_path, surface, kind, prep, params, expected):
    ws = _BUILDERS[kind](tmp_path)
    prep(ws)
    assert _apply_surface(surface, ws, params) == expected


def test_proposal_apply_and_decision_rows_keep_key_names_and_order(tmp_path):
    ws = _double(tmp_path)
    service = AnalysisService(ws)
    preview = _wire(service.preview_retained_bleed_alignment())
    assert list(preview) == ["proposed_count", "proposals", "skipped"]
    for row in preview["proposals"]:
        assert list(row) == _PROPOSAL_KEYS
        assert type(row["max_residual_ms"]) is float
        assert type(row["offset_sec"]) is float
        assert type(row["validation_windows"]) is int
        assert row["source_id"] is None
        assert list(row["reference_track_ids"]) == ["uncertain"]
    applied = _wire(service.align_retained_bleed())
    assert list(applied) == ["applied_count", "alignments", "skipped"]
    for row in applied["alignments"]:
        assert list(row) == _ALIGNMENT_KEYS
        assert row["source_id"] is None
    decision = _wire(service.set_bleed_alignment_mode(_FIRST_ID, "manual"))
    assert type(decision) is dict
    assert list(decision) == _DECISION_KEYS
    assert type(decision["evidence_revision"]) is int
    assert type(decision["start_s"]) is float
    assert type(decision["end_s"]) is float


def test_integral_floats_stay_floats_in_decision_text(tmp_path):
    ws = _single(tmp_path)
    decision = _dump(AnalysisService(ws).set_bleed_alignment_mode(_FIRST_ID, "auto", **_WINDOW))
    assert '"offset_sec": 0.0,' in decision
    assert '"offset_sec": 0,' not in decision
    preview = _dump(AnalysisService(ws).preview_retained_bleed_alignment(**_WINDOW))
    assert '"max_residual_ms": 0.0,' in preview


def _mode_surface(surface: str, ws: ProjectWorkspace, mode: str, params: dict) -> str:
    if surface == "service":
        return _dump(AnalysisService(ws).set_bleed_alignment_mode(_FIRST_ID, mode, **params))
    if surface == "cli":
        args = [
            "edit",
            "bleed-alignment-choice",
            "--project",
            str(ws.path),
            "--decision",
            _FIRST_ID,
            "--mode",
            mode,
        ]
        return _cli_text(CliRunner().invoke(app, [*args, *_cli_scope(params)]))
    if surface == "mcp":
        return timeline.set_retained_bleed_alignment_mode_tool(
            str(ws.path), _FIRST_ID, mode, **params
        )
    if surface == "handler":
        result = edit_handlers.set_bleed_alignment_mode(
            ws, {"decision_id": _FIRST_ID, "mode": mode, **params}
        )
        assert type(result) is dict
        return json.dumps(result, indent=2)
    reply = submit_host_document_command(
        ws.path, "SetBleedAlignmentMode", {"decision_id": _FIRST_ID, "mode": mode, **params}
    )
    result = host_command_result(reply)
    assert type(result) is dict
    return json.dumps(result, indent=2)


_MODE_SURFACES = ["service", "cli", "mcp", "handler", "host"]

_MODE_STATES = [
    pytest.param(_prep_applied, {}, _DECISION_EXISTING, id="existing"),
    pytest.param(_prep_none, _WINDOW, _DECISION_PROPOSAL, id="proposal"),
]


@pytest.mark.parametrize("surface", _MODE_SURFACES)
@pytest.mark.parametrize("mode", _MODES)
@pytest.mark.parametrize(("prep", "params", "template"), _MODE_STATES)
def test_set_mode_wire_text(tmp_path, surface, mode, prep, params, template):
    ws = _single(tmp_path)
    prep(ws)
    expected = _t(template.replace("__MODE__", mode))
    assert _mode_surface(surface, ws, mode, params) == expected


@pytest.mark.parametrize("mode", _MODES)
@pytest.mark.parametrize(
    ("prep", "params", "template"),
    [
        pytest.param(_prep_applied, {}, _ROW_EXISTING, id="existing"),
        pytest.param(_prep_none, _WINDOW, _ROW_PROPOSAL, id="proposal"),
    ],
)
@pytest.mark.parametrize("surface", ["mcp", "host", "cli"])
def test_set_mode_journals_a_plain_dict_result_row(tmp_path, surface, mode, prep, params, template):
    ws = _single(tmp_path)
    prep(ws)
    _mode_surface(surface, ws, mode, params)
    rows = [row for row in _journal(ws.path) if row["type"] == "SetBleedAlignmentMode"]
    assert len(rows) == 1
    assert type(rows[0]["payload"]["result"]) is dict
    row = {"type": rows[0]["type"], "payload": rows[0]["payload"]}
    expected = _t(template.replace("__MODE__", mode))
    assert json.dumps(row, indent=2) == expected


def test_handler_result_is_the_decision_dump_for_every_mode(tmp_path):
    ws = _single(tmp_path)
    _prep_applied(ws)
    for mode in _MODES:
        result = edit_handlers.set_bleed_alignment_mode(
            ws, {"decision_id": _FIRST_ID, "mode": mode}
        )
        assert type(result) is dict
        assert json.dumps(result, indent=2) == _t(_DECISION_EXISTING.replace("__MODE__", mode))


def _raises(call, message: str, code: str) -> None:
    with pytest.raises(CodedError) as excinfo:
        call()
    assert str(excinfo.value) == message
    assert excinfo.value.code == code


def test_invalid_mode_is_coded_on_service_mcp_handler_and_host(tmp_path):
    ws = _single(tmp_path)
    before = ws.path.read_bytes()
    calls = [
        lambda: AnalysisService(ws).set_bleed_alignment_mode(_FIRST_ID, "oops", **_WINDOW),  # type: ignore[arg-type]
        lambda: timeline.set_retained_bleed_alignment_mode_tool(str(ws.path), _FIRST_ID, "oops"),  # type: ignore[arg-type]
        lambda: edit_handlers.set_bleed_alignment_mode(
            ws, {"decision_id": _FIRST_ID, "mode": "oops"}
        ),
        lambda: submit_host_document_command(
            ws.path, "SetBleedAlignmentMode", {"decision_id": _FIRST_ID, "mode": "oops"}
        ),
    ]
    for call in calls:
        _raises(call, _INVALID_MODE, "invalid_mode")
    assert ws.path.read_bytes() == before
    assert _journal_types(ws.path) == []


def test_cli_invalid_mode_is_rejected_by_the_option_check(tmp_path):
    ws = _single(tmp_path)
    before = ws.path.read_bytes()
    result = CliRunner().invoke(
        app,
        [
            "edit",
            "bleed-alignment-choice",
            "--project",
            str(ws.path),
            "--decision",
            _FIRST_ID,
            "--mode",
            "oops",
        ],
    )
    assert result.exit_code == 2
    flat = "".join(re.sub(r"\x1b\[[0-9;]*m|[│╭╮╰╯─]", "", result.output).split())
    assert "Invalidvaluefor--mode:modemustbeauto,manual,ordeclined" in flat
    assert ws.path.read_bytes() == before
    assert _journal_types(ws.path) == []


def test_unknown_decision_is_coded_on_every_surface(tmp_path):
    ws = _single(tmp_path)
    code = "retained_bleed_decision_not_found"
    calls = [
        lambda: AnalysisService(ws).set_bleed_alignment_mode("nope", "auto"),
        lambda: timeline.set_retained_bleed_alignment_mode_tool(str(ws.path), "nope", "auto"),
        lambda: edit_handlers.set_bleed_alignment_mode(ws, {"decision_id": "nope", "mode": "auto"}),
        lambda: submit_host_document_command(
            ws.path, "SetBleedAlignmentMode", {"decision_id": "nope", "mode": "auto"}
        ),
    ]
    for call in calls:
        _raises(call, _NOT_FOUND, code)
    assert _journal_types(ws.path) == []
    result = CliRunner().invoke(
        app,
        [
            "edit",
            "bleed-alignment-choice",
            "--project",
            str(ws.path),
            "--decision",
            "nope",
            "--mode",
            "auto",
        ],
    )
    assert result.exit_code == 1
    assert result.output == f"Error: {_NOT_FOUND} (code {code}) {_DEBUG_HINT}\n"


def test_unknown_decision_outside_the_planned_window_is_not_found(tmp_path):
    ws = _single(tmp_path)
    _raises(
        lambda: AnalysisService(ws).set_bleed_alignment_mode(
            _FIRST_ID, "auto", track_id="direct", start_sec=0.8, end_sec=3.5
        ),
        f"unknown retained-bleed alignment decision '{_FIRST_ID}'. "
        "List the alignment decisions and pick one of them.",
        "retained_bleed_decision_not_found",
    )


@pytest.fixture
def stale_plans(monkeypatch):
    original = analysis_module.plan_retained_bleed_alignment

    def stale(*args, **kwargs):
        return dataclasses.replace(original(*args, **kwargs), fingerprint="stale")

    monkeypatch.setattr(analysis_module, "plan_retained_bleed_alignment", stale)


def test_stale_plan_is_coded_on_service_mcp_and_job(tmp_path, stale_plans):
    ws = _single(tmp_path)
    before = ws.path.read_bytes()
    code = "retained_bleed_plan_stale"
    calls = [
        lambda: AnalysisService(ws).align_retained_bleed(**_WINDOW),
        lambda: transcript.align_retained_bleed_tool(str(ws.path), **_WINDOW),
        lambda: run_audio_edit(ws, "align_retained_bleed", dict(_WINDOW), lock_timeout=5.0),
    ]
    for call in calls:
        _raises(call, _STALE, code)
    assert ws.path.read_bytes() == before
    assert _journal_types(ws.path) == []


def test_stale_plan_cli_error_text(tmp_path, stale_plans):
    ws = _single(tmp_path)
    result = CliRunner().invoke(
        app,
        ["edit", "align-retained-bleed", "--project", str(ws.path), *_cli_scope(_WINDOW)],
    )
    assert result.exit_code == 1
    assert result.output == f"Error: {_STALE} (code retained_bleed_plan_stale) {_DEBUG_HINT}\n"


def test_job_journals_one_external_row_after_a_successful_apply(tmp_path):
    ws = _single(tmp_path)
    run_audio_edit(ws, "align_retained_bleed", dict(_WINDOW), lock_timeout=5.0)
    assert _journal_types(ws.path) == ["ExternalMutate"]


def test_cli_and_mcp_apply_outputs_are_identical_json_documents(tmp_path):
    cli_ws = _single(tmp_path / "cli")
    mcp_ws = _single(tmp_path / "mcp")
    cli_text = _apply_surface("cli", cli_ws, _WINDOW)
    mcp_text = _apply_surface("mcp", mcp_ws, _WINDOW)
    assert cli_text == mcp_text == _APPLY_ONE
