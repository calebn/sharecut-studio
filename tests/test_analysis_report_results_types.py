"""The analysis report TypedDicts match what the four report methods emit."""

import ast
from pathlib import Path

import pytest
from pydantic import TypeAdapter

from podcast_mcp.services.document import (
    AudioDiagnosticsReport,
    CleanupAnalysisReport,
    GateOverreach,
    ReconciliationStatus,
)
from podcast_mcp.services.document import analysis_report_results as results
from podcast_mcp.services.document.analysis_report_results import (
    AudioDiagnosticsWindow,
    CleanupPolicy,
    CleanupTrackRow,
    FfmpegAstats,
    GateCombinedReport,
    GateNoGate,
    GateNoiseReport,
    GateTranscriptReport,
    HumAnalyzed,
    HumSkipped,
    TrackHealth,
)
from test_analysis_reports_wire import (
    _GUEST_ROW,
    _LOSS_ISSUES,
    _NO_GATE,
    _NOISE_REPORT,
    _POLICY,
    _RECONCILIATION,
    _TRANSCRIPT_REPORT,
    _cleanup,
    _host_row,
)

pytestmark = pytest.mark.unscoped_ok


def _shape(td: type) -> tuple[set[str], set[str]]:
    return set(td.__required_keys__), set(td.__optional_keys__)


@pytest.mark.parametrize(
    ("td", "required", "optional"),
    [
        (
            ReconciliationStatus,
            {"stale", "fingerprint", "last_reconciliation_hash", "reconciliation_stale_flag"},
            set(),
        ),
        (
            CleanupPolicy,
            {
                "bleed_dominance_db",
                "bleed_ratio_warn_threshold",
                "ml_backend",
                "transcript_mode",
                "reconcile_on_render",
            },
            set(),
        ),
        (
            FfmpegAstats,
            {
                "dc_offset",
                "peak_level_db",
                "rms_level_db",
                "crest_factor",
                "flat_factor",
                "peak_count",
                "noise_floor_db",
                "dynamic_range_db",
            },
            set(),
        ),
        (
            HumAnalyzed,
            {
                "hum_detected",
                "dominant_frequency",
                "energy_ratios",
                "threshold_ratio",
                "recommendation",
            },
            set(),
        ),
        (HumSkipped, {"hum_detected", "reason"}, set()),
        (
            TrackHealth,
            {*FfmpegAstats.__annotations__, "hum", "voice_db"},
            set(),
        ),
        (GateNoGate, {"track_id", "gate_present", "risk", "issues", "advice"}, set()),
        (
            GateNoiseReport,
            {"track_id", "gate_present", "risk", "issues", "advice"},
            {"issue_count", "gate_type"},
        ),
        (
            GateTranscriptReport,
            {
                "track_id",
                "gate_present",
                "gate_type",
                "risk",
                "issue_count",
                "issues",
                "analyzed_words",
                "advice",
            },
            set(),
        ),
        (
            GateCombinedReport,
            {
                "track_id",
                "gate_present",
                "gate_type",
                "risk",
                "issue_count",
                "issues",
                "components",
                "advice",
            },
            set(),
        ),
        (
            CleanupTrackRow,
            {
                "track_id",
                "effects",
                "health",
                "gate_analysis",
                "low_audibility_count",
                "low_audibility_sample",
                "flagged_count",
                "bleed_count",
                "bleed_ratio",
                "flagged_sample",
                "fade_recommendations",
            },
            {"high_bleed_warning", "suppression_recommendations"},
        ),
        (
            CleanupAnalysisReport,
            {"tracks", "policy", "reconciliation", "summary"},
            set(),
        ),
        (
            AudioDiagnosticsWindow,
            {"clock", "unit", "start", "end"},
            set(),
        ),
        (
            AudioDiagnosticsReport,
            {"track_id", "astats", "hum", "spectrogram_png", "waveform_png"},
            {"window"},
        ),
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


def test_digit_leading_hum_keys_are_declared():
    assert set(HumAnalyzed.__annotations__["energy_ratios"].__annotations__) == {
        "50hz_ratio",
        "60hz_ratio",
    }


def test_reconciliation_pin_validates():
    TypeAdapter(ReconciliationStatus).validate_python(_RECONCILIATION)


@pytest.mark.parametrize(
    "report",
    [
        {"track_id": "host", **_NO_GATE},
        {
            "track_id": "host",
            "gate_present": True,
            "risk": "unknown",
            "issues": [],
            "advice": "No transcript words to analyze gate behavior.",
        },
        _NOISE_REPORT,
        _TRANSCRIPT_REPORT,
        {
            "track_id": "host",
            "gate_present": True,
            "gate_type": "combined",
            "risk": "high",
            "issue_count": 7,
            "issues": _LOSS_ISSUES,
            "components": [{**_NOISE_REPORT, "gate_type": "noise"}, _TRANSCRIPT_REPORT],
            "advice": "Review each gate separately.",
        },
        {
            "track_id": "host",
            "gate_present": True,
            "gate_type": "combined",
            "risk": "unknown",
            "issue_count": 0,
            "issues": [],
            "components": [],
            "advice": "Evidence before transcript gating is unavailable.",
        },
    ],
)
def test_gate_pins_validate(report):
    assert TypeAdapter(GateOverreach).validate_python(report) == report


def test_cleanup_pins_validate():
    report = _cleanup([_host_row(), _GUEST_ROW])
    assert TypeAdapter(CleanupAnalysisReport).validate_python(report) == report
    assert TypeAdapter(CleanupPolicy).validate_python(_POLICY) == _POLICY


def test_diagnostics_pins_validate():
    astats = {key: 1.0 for key in FfmpegAstats.__annotations__}
    astats["peak_count"] = 3
    hum = {
        "hum_detected": False,
        "dominant_frequency": "none",
        "energy_ratios": {"50hz_ratio": 0.1, "60hz_ratio": 0.2},
        "threshold_ratio": 0.5,
        "recommendation": None,
    }
    base = {
        "track_id": "host",
        "astats": astats,
        "hum": hum,
        "spectrogram_png": "s.png",
        "waveform_png": "w.png",
    }
    adapter = TypeAdapter(AudioDiagnosticsReport)
    assert adapter.validate_python(base) == base
    windowed = {
        **base,
        "hum": {"hum_detected": False, "reason": "clip too short to analyze"},
        "window": {"clock": "timeline", "unit": "sec", "start": 0.5, "end": 1.5},
    }
    assert adapter.validate_python(windowed) == windowed
