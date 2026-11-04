"""Characterization pin of the effects service wire output and every adapter (#1811).

Expected values were captured by running the code on main before the effects results are typed.
Each comparison goes through ``json.dumps`` so key order is pinned along with the values.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from podcast_mcp.gui.assembler import _effects_by_track
from podcast_mcp.mcp.tools import timeline as tools
from podcast_mcp.models import ProcessingChain, ProcessingEffect, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import AnalysisService, EpisodeService
from podcast_mcp.services.document_sync.registry import apply_command
from podcast_mcp.util.coded_error import CodedValueError

SUPPORTED = [
    "acompressor",
    "afftdn",
    "agate",
    "arnndn",
    "bandreject",
    "deesser",
    "equalizer",
    "highpass",
    "loudnorm",
]
PRESETS = [
    "deess",
    "eq_clarity",
    "eq_presence",
    "eq_warm",
    "gate",
    "noise_reduction",
    "noise_reduction_heavy",
    "noise_reduction_rnnoise",
    "podcast_standard",
]
UNSUPPORTED_MSG = (
    "unsupported effect 'volume'; supported effects: "
    "acompressor, afftdn, agate, arnndn, bandreject, deesser, equalizer, highpass, loudnorm"
)
HIGHPASS = {"effect": "highpass", "params": {"frequency": 80}, "bypass": False}
DEESSER = {"effect": "deesser", "params": {"intensity": 0.5, "frequency": 0.5}, "bypass": False}


def _same(actual: Any, expected: Any) -> None:
    assert json.dumps(actual) == json.dumps(expected)


def _with_supported(entry: dict[str, Any], **over: Any) -> dict[str, Any]:
    return {**entry, **over, "supported": True}


@pytest.fixture
def ws(minimal_project) -> ProjectWorkspace:
    workspace = ProjectWorkspace.open(minimal_project)
    EpisodeService(workspace).add_empty_track("host", speaker="Host")
    EpisodeService(workspace).add_empty_track("other")
    return workspace


def _refused(call, exc_type: type[Exception], code: str | None, message: str) -> None:
    with pytest.raises(exc_type) as caught:
        call()
    assert type(caught.value) is exc_type
    assert getattr(caught.value, "code", None) == code
    assert str(caught.value) == message


def test_service_add_and_remove_effect(ws):
    svc = AnalysisService(ws)
    _same(
        svc.add_effect(track_id="host", effect="highpass", params={"frequency": 80}),
        {"track_id": "host", "effects": [HIGHPASS]},
    )
    _same(
        svc.add_effect(track_id="host", preset="deess"),
        {"track_id": "host", "effects": [HIGHPASS, DEESSER]},
    )
    _same(svc.remove_effect(track_id="host", effect="highpass"), {"track_id": "host", "removed": 1})
    _same(svc.remove_effect(track_id="host", effect="zzz"), {"track_id": "host", "removed": 0})
    _same(svc.remove_effect(speaker="Host"), {"track_id": "host", "removed": 1})


def test_service_add_effect_refusals(ws):
    svc = AnalysisService(ws)
    _refused(
        lambda: svc.add_effect(track_id="host", effect="volume"),
        CodedValueError,
        "unsupported_effect",
        UNSUPPORTED_MSG,
    )
    _refused(
        lambda: svc.add_effect(track_id="host"),
        CodedValueError,
        "effect_required",
        "preset or effect is required",
    )
    _refused(
        lambda: svc.add_effect(track_id="host", preset="nope"),
        ValueError,
        None,
        "unknown effect preset: 'nope'",
    )


def test_service_set_effect_bypass_and_refusals(ws):
    svc = AnalysisService(ws)
    svc.add_effect(track_id="host", effect="highpass", params={"frequency": 80})
    svc.add_effect(track_id="host", preset="deess")
    _same(
        svc.set_effect_bypass(track_id="host", effect_index=1, bypass=True),
        {
            "track_id": "host",
            "effect_index": 1,
            "bypass": True,
            "effect": "deesser",
            "effects": [_with_supported(HIGHPASS), _with_supported(DEESSER, bypass=True)],
        },
    )
    _refused(
        lambda: svc.set_effect_bypass(track_id="host", effect_index=9, bypass=True),
        ValueError,
        None,
        "effect_index 9 out of range for track 'host' (len=2)",
    )
    _refused(
        lambda: svc.set_effect_bypass(track_id="host", effect_index=-1, bypass=True),
        ValueError,
        None,
        "effect_index -1 out of range for track 'host' (len=2)",
    )
    _refused(
        lambda: svc.set_effect_bypass(track_id="other", effect_index=0, bypass=True),
        ValueError,
        None,
        "no processing chain for track_id='other'",
    )


def test_service_list_effects_track_and_preset_views(ws):
    svc = AnalysisService(ws)
    _same(svc.list_effects(), {"presets": PRESETS, "supported_effects": SUPPORTED})
    _same(
        svc.list_effects(track_id="host"),
        {"track_id": "host", "effects": [], "supported_effects": SUPPORTED},
    )
    svc.add_effect(track_id="host", effect="highpass", params={"frequency": 80})
    _same(
        svc.list_effects(speaker="Host"),
        {
            "track_id": "host",
            "effects": [_with_supported(HIGHPASS)],
            "supported_effects": SUPPORTED,
        },
    )


def test_service_list_effects_flags_an_unsupported_stored_effect(ws, minimal_project):
    project = ws.project
    project.processing_chains.append(
        ProcessingChain(track_id="host", effects=[ProcessingEffect(effect="volume", params={})])
    )
    save_project(project, minimal_project)
    listed = AnalysisService(ProjectWorkspace.open(minimal_project)).list_effects(track_id="host")
    _same(
        listed,
        {
            "track_id": "host",
            "effects": [
                {
                    "effect": "volume",
                    "params": {},
                    "bypass": False,
                    "supported": False,
                    "warning": (
                        "Unsupported effect 'volume' will not be rendered. "
                        "Remove it from this chain before export."
                    ),
                }
            ],
            "supported_effects": SUPPORTED,
        },
    )


def test_sync_handlers_return_the_service_dicts(ws):
    _same(
        apply_command(
            ws, "AddEffect", {"track_id": "host", "effect": "highpass", "params": {"frequency": 80}}
        ),
        {"track_id": "host", "effects": [HIGHPASS]},
    )
    _same(
        apply_command(ws, "AddEffect", {"track_id": "host", "preset": "deess"}),
        {"track_id": "host", "effects": [HIGHPASS, DEESSER]},
    )
    _same(
        apply_command(
            ws, "SetEffectBypass", {"track_id": "host", "effect_index": 0, "bypass": True}
        ),
        {
            "track_id": "host",
            "effect_index": 0,
            "bypass": True,
            "effect": "highpass",
            "effects": [_with_supported(HIGHPASS, bypass=True), _with_supported(DEESSER)],
        },
    )
    _same(
        apply_command(ws, "RemoveEffect", {"track_id": "host", "effect": "highpass"}),
        {"track_id": "host", "removed": 1},
    )
    _same(
        apply_command(ws, "RemoveEffect", {"track_id": "host"}), {"track_id": "host", "removed": 1}
    )


def test_sync_handler_refusals(ws):
    _refused(
        lambda: apply_command(ws, "AddEffect", {"track_id": "host", "effect": "volume"}),
        CodedValueError,
        "unsupported_effect",
        UNSUPPORTED_MSG,
    )
    apply_command(ws, "AddEffect", {"track_id": "host", "effect": "highpass"})
    _refused(
        lambda: apply_command(
            ws, "SetEffectBypass", {"track_id": "host", "effect_index": 7, "bypass": True}
        ),
        ValueError,
        None,
        "effect_index 7 out of range for track 'host' (len=1)",
    )


def test_mcp_tools_return_the_exact_json_text(minimal_project):
    p = str(minimal_project)
    ws = ProjectWorkspace.open(p)
    EpisodeService(ws).add_empty_track("host", speaker="Host")

    added = tools.add_effect_tool(p, track_id="host", effect="highpass", params={"frequency": 80})
    assert added == json.dumps({"track_id": "host", "effects": [HIGHPASS]}, indent=2)
    added = tools.add_effect_tool(p, speaker="Host", preset="deess")
    assert added == json.dumps({"track_id": "host", "effects": [HIGHPASS, DEESSER]}, indent=2)

    bypassed = tools.set_effect_bypass_tool(p, 0, True, track_id="host")
    both = [_with_supported(HIGHPASS, bypass=True), _with_supported(DEESSER)]
    assert bypassed == json.dumps(
        {
            "track_id": "host",
            "effect_index": 0,
            "bypass": True,
            "effect": "highpass",
            "effects": both,
        },
        indent=2,
    )
    assert tools.list_effects_tool(p, track_id="host") == json.dumps(
        {"track_id": "host", "effects": both, "supported_effects": SUPPORTED}, indent=2
    )
    assert tools.list_effects_tool(p) == json.dumps(
        {"presets": PRESETS, "supported_effects": SUPPORTED}, indent=2
    )
    assert tools.remove_effect_tool(p, track_id="host", effect="highpass") == json.dumps(
        {"track_id": "host", "removed": 1}, indent=2
    )
    assert tools.remove_effect_tool(p, track_id="host") == json.dumps(
        {"track_id": "host", "removed": 1}, indent=2
    )


def test_mcp_tool_refusals(minimal_project):
    p = str(minimal_project)
    EpisodeService(ProjectWorkspace.open(p)).add_empty_track("host")
    _refused(
        lambda: tools.add_effect_tool(p, track_id="host", effect="volume"),
        CodedValueError,
        "unsupported_effect",
        UNSUPPORTED_MSG,
    )
    tools.add_effect_tool(p, track_id="host", effect="highpass")
    _refused(
        lambda: tools.set_effect_bypass_tool(p, 7, True, track_id="host"),
        ValueError,
        None,
        "effect_index 7 out of range for track 'host' (len=1)",
    )


def test_gui_assembler_reads_the_track_effect_rows(ws, minimal_project):
    svc = AnalysisService(ws)
    svc.add_effect(track_id="host", preset="deess")
    svc.set_effect_bypass(track_id="host", effect_index=0, bypass=True)
    rows = _effects_by_track(ProjectWorkspace.open(minimal_project))
    _same(rows, {"host": [_with_supported(DEESSER, bypass=True)], "other": []})
