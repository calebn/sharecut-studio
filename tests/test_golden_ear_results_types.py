"""The golden-ear build and score TypedDicts match the pinned wire output (#1811)."""

import ast
import wave
from pathlib import Path
from typing import Any, get_type_hints

import pytest
from pydantic import TypeAdapter, ValidationError

import join_quality_fixtures
from podcast_mcp.services.document import golden_ear_results as results
from podcast_mcp.services.document.analysis_report_results import FfmpegAstats, HumSkipped
from podcast_mcp.services.document.golden_ear import (
    ALLOWED_CLASSES,
    _pair_audio_diagnostics,
    source_fingerprint,
)
from podcast_mcp.services.document.golden_ear_results import (
    AcceptanceRollup,
    AudioRoleEntry,
    BuildResult,
    JoinDetectorWire,
    JoinMetrics,
    JoinQualityError,
    JoinQualityWire,
    JoinRankerWire,
    PairAudioDiagnostics,
    PairRow,
    PerClassRollups,
    ScoreReport,
    SourceFingerprint,
    WavPair,
)
from podcast_mcp.services.document.join_quality_results import (
    JoinDetectorRow,
    JoinQualityReport,
    JoinRankerVerdict,
)
from test_golden_ear_wire import EXPECTED as WIRE_PINS
from test_golden_ear_wire_cli import EXPECTED as CLI_PINS
from test_golden_ear_wire_faults import EXPECTED as FAULT_PINS
from test_golden_ear_wire_files import EXPECTED as FILE_PINS
from test_golden_ear_wire_matrix import EXPECTED as MATRIX_PINS
from test_golden_ear_wire_score import EXPECTED as SCORE_PINS

pytestmark = pytest.mark.unscoped_ok

BUILD_PINS: dict[str, dict[str, Any]] = {
    **{f"wire:{k}": v for k, v in WIRE_PINS.items()},
    **{f"faults:{k}": v for k, v in FAULT_PINS.items()},
    **{f"files:{k}": v for k, v in FILE_PINS.items()},
    **{f"matrix:{k}": v for k, v in MATRIX_PINS.items()},
}
FULL_PINS = {name: pin for name, pin in BUILD_PINS.items() if "key_full" in pin}
SCORE_REPORTS = {name: pin["report"] for name, pin in SCORE_PINS.items() if "report" in pin}
BUILD_OUTCOMES = {
    name: pin["outcome"]
    for name, pin in BUILD_PINS.items()
    if "outcome" in pin and "raised" not in pin["outcome"]
}
PAIR_ROWS = [
    pytest.param(row, id=f"{name}/{row['id']}")
    for name, pin in FULL_PINS.items()
    for row in pin["key_full"]["pairs"]
]
ROW_ORDER = [
    "id",
    "edit_id",
    "reason",
    "class",
    "track_id",
    "start",
    "end",
    "gated",
    "join_quality",
    "audition_context",
    "audition_context_source",
    "pair_diagnostics",
    "audition_context_error",
    "leave_file",
    "edit_file",
    "play_start",
    "play_end",
]
ROLLUP_ORDER = [
    "n",
    "answered_n",
    "missing_n",
    "prefer_edit",
    "prefer_edit_answered",
    "ties",
    "leftover_consonant_fails",
]
ANNOTATION_ORDERS = {
    SourceFingerprint: ["path", "mtime_ns", "size"],
    WavPair: ["leave_file", "edit_file", "play_start", "play_end"],
    PairAudioDiagnostics: ["source", "current", "suggested"],
    JoinQualityWire: list(JoinQualityReport.model_fields),
    BuildResult: ["out_dir", "listen_dir", "pair_count", "skipped_unsuggestable", "workspace"],
    AcceptanceRollup: ROLLUP_ORDER,
    PerClassRollups: ["filler", "pause", "repetition", "restart"],
    ScoreReport: [
        "n_answers",
        "gated_n",
        "all_n",
        "pair_count",
        "missing_n",
        "min_gated_n",
        "prefer_edit_all",
        "prefer_edit_gated",
        "per_class",
        "per_reason",
        "per_track",
        "leftover_consonant_fails",
        "bar",
        "pass",
        "fail_reasons",
    ],
    PairRow: ROW_ORDER,
}


def _round_trips(tp: Any, value: Any) -> None:
    assert TypeAdapter(tp).validate_python(value) == value


def _scrub_diagnostics(diagnostics: dict[str, Any]) -> dict[str, Any]:
    scrubbed: dict[str, Any] = {"source": diagnostics["source"]}
    for role in ("current", "suggested"):
        entry = diagnostics[role]
        scrubbed[role] = {
            key: entry[key] for key in ("file", "waveform_png", "error") if key in entry
        }
    return scrubbed


def test_pin_collections_are_not_empty():
    assert SCORE_REPORTS
    assert any("raised" in pin for pin in SCORE_PINS.values())
    assert FULL_PINS
    assert BUILD_OUTCOMES
    assert PAIR_ROWS
    assert CLI_PINS


@pytest.mark.parametrize("name", sorted(SCORE_REPORTS))
def test_score_reports_match_the_typed_shape(name):
    report = SCORE_REPORTS[name]
    _round_trips(ScoreReport, report)
    assert list(report) == list(ScoreReport.__annotations__)
    assert isinstance(report["min_gated_n"], int)
    assert list(report["per_class"]) == list(ALLOWED_CLASSES)
    rollups = [
        *report["per_class"].values(),
        *report["per_reason"].values(),
        *report["per_track"].values(),
    ]
    for rollup in rollups:
        _round_trips(AcceptanceRollup, rollup)
        assert list(rollup) == list(AcceptanceRollup.__annotations__)


def test_per_class_keys_follow_the_allowed_classes():
    assert list(PerClassRollups.__annotations__) == list(ALLOWED_CLASSES)


@pytest.mark.parametrize("name", sorted(BUILD_OUTCOMES))
def test_build_outcomes_match_the_typed_shape(name):
    outcome = BUILD_OUTCOMES[name]
    _round_trips(BuildResult, outcome)
    assert list(outcome) == list(BuildResult.__annotations__)


def test_empty_build_outcome_is_pinned():
    assert BUILD_OUTCOMES["wire:detail_no_candidates"]["pair_count"] == 0


FINGERPRINTED = sorted(
    name
    for name, pin in BUILD_PINS.items()
    if "source_fingerprint" in pin.get("key_head", {}).get("head", {})
)


def test_most_key_heads_carry_a_fingerprint():
    assert len(FINGERPRINTED) > 100


@pytest.mark.parametrize("name", FINGERPRINTED)
def test_key_head_fingerprint_order_and_intensity(name):
    pin = BUILD_PINS[name]
    head = pin["key_head"]["head"]
    assert list(head["source_fingerprint"]) == list(SourceFingerprint.__annotations__)
    assert "intensity" in head
    assert "intensity" not in pin["manifest"]["manifest"]
    assert "intensity" not in PairRow.__annotations__
    assert "intensity" not in BuildResult.__annotations__


def test_source_fingerprint_validates_the_real_return(tmp_path):
    project = tmp_path / "episode.sharecut"
    project.write_text("{}", encoding="utf-8")
    fingerprint = source_fingerprint(project)
    _round_trips(SourceFingerprint, fingerprint)
    assert list(fingerprint) == ["path", "mtime_ns", "size"]


@pytest.mark.parametrize("row", PAIR_ROWS)
def test_pair_rows_keep_the_runtime_key_order(row):
    expected = [key for key in ROW_ORDER if key != "audition_context_error" or key in row]
    assert list(row) == expected
    assert PairRow.__optional_keys__ == {"audition_context_error"}
    assert PairRow.__required_keys__ | PairRow.__optional_keys__ == set(ROW_ORDER)
    _round_trips(JoinMetrics, row["join_quality"])


@pytest.mark.parametrize("row", PAIR_ROWS)
def test_pair_rows_validate_with_the_stubbed_leaves_scrubbed(row):
    context = row["audition_context"]
    assert context is None or "schema" in context
    scrubbed = {
        **row,
        "audition_context": None,
        "pair_diagnostics": _scrub_diagnostics(row["pair_diagnostics"]),
    }
    _round_trips(PairRow, scrubbed)


def test_context_error_sits_right_after_the_diagnostics():
    row = FULL_PINS["wire:detail_context_error"]["key_full"]["pairs"][0]
    keys = list(row)
    assert keys[keys.index("pair_diagnostics") + 1] == "audition_context_error"
    assert keys.index("audition_context_error") < keys.index("leave_file")


def test_join_error_arm_is_pinned():
    rows = FULL_PINS["wire:detail_join_errors"]["key_full"]["pairs"]
    errors = [row["join_quality"] for row in rows if row["join_quality"]["verdict"] == "error"]
    assert errors
    for error in errors:
        _round_trips(JoinQualityError, error)
        assert list(error) == ["verdict", "error"]


def test_skipped_pairs_stay_out_of_the_rows():
    pin = FULL_PINS["wire:detail_skipped"]["key_full"]
    skipped = pin["skipped_unsuggestable"]
    assert isinstance(skipped, int)
    assert skipped >= 1
    ids = [row["id"] for row in pin["pairs"]]
    assert ids == [f"pair_{index:03d}" for index in range(len(ids))]
    assert pin["pair_count"] == len(ids)


def test_audio_role_entries_stay_inside_the_declared_keys():
    entries = [
        entry
        for pin in FULL_PINS.values()
        for row in pin["key_full"]["pairs"]
        for entry in (row["pair_diagnostics"]["current"], row["pair_diagnostics"]["suggested"])
    ]
    assert entries
    for entry in entries:
        assert set(entry) <= set(AudioRoleEntry.__annotations__)
        assert "file" in entry
        if "error" in entry and "waveform_png" in entry:
            assert entry["error"] == "astats unavailable: no metrics"


@pytest.fixture
def real_pair(tmp_path, sample_wav):
    pair = tmp_path / "listen" / "pair_000"
    pair.mkdir(parents=True)
    (pair / "1.wav").write_bytes(sample_wav.read_bytes())
    short = pair / "2.wav"
    with wave.open(str(short), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16000)
        handle.writeframes(b"\x10\x00" * 8000)
    wavs: WavPair = {
        "leave_file": "1.wav",
        "edit_file": "2.wav",
        "play_start": 0.0,
        "play_end": 1.0,
    }
    return pair, wavs, tmp_path / "diagnostics"


def test_real_ffmpeg_diagnostics_validate(real_pair):
    pair, wavs, diagnostics = real_pair
    result = _pair_audio_diagnostics(pair, wavs, diagnostics, "pair_000")
    _round_trips(PairAudioDiagnostics, result)
    assert list(result) == list(PairAudioDiagnostics.__annotations__)
    assert list(result["current"]["astats"]) == list(FfmpegAstats.__annotations__)
    assert list(result["suggested"]["astats"]) == list(FfmpegAstats.__annotations__)
    assert list(result["current"]) == ["file", "astats", "hum", "waveform_png"]
    assert "hum_detected" in result["current"]["hum"]
    _round_trips(HumSkipped, result["suggested"]["hum"])


def test_join_mirror_field_order_matches_the_models():
    assert list(JoinQualityWire.__annotations__) == list(JoinQualityReport.model_fields)
    assert list(JoinDetectorWire.__annotations__) == list(JoinDetectorRow.model_fields)
    assert list(JoinRankerWire.__annotations__) == list(JoinRankerVerdict.model_fields)


def test_join_mirror_field_types_match_the_models():
    hints = get_type_hints(JoinQualityWire)
    fields = JoinQualityReport.model_fields
    for name in fields:
        if name in {"detectors", "ranker"}:
            continue
        assert hints[name] == fields[name].annotation, name
    assert hints["detectors"] == list[JoinDetectorWire]
    assert hints["ranker"] == JoinRankerWire | None
    for wire, model in ((JoinDetectorWire, JoinDetectorRow), (JoinRankerWire, JoinRankerVerdict)):
        wire_hints = get_type_hints(wire)
        for name, field in model.model_fields.items():
            assert wire_hints[name] == field.annotation, name


def test_join_mirror_round_trips_the_model_dump():
    detector = {"name": "click", "score": 0.5, "weight": 1.0, "detail": {"peak": 0.2}}
    ranker = {"available": True, "fail_proba": 0.2, "threshold": 0.5, "n_train": 12}
    dump = join_quality_fixtures.report(detectors=[detector], ranker=ranker).model_dump()
    _round_trips(JoinQualityWire, dump)
    _round_trips(JoinMetrics, dump)
    assert list(dump) == list(JoinQualityWire.__annotations__)


def test_join_union_cannot_cross_over():
    dump = join_quality_fixtures.report().model_dump()
    with pytest.raises(ValidationError):
        TypeAdapter(JoinQualityWire).validate_python({**dump, "verdict": "error"})
    with pytest.raises(ValidationError):
        TypeAdapter(JoinQualityError).validate_python({"verdict": "pass", "error": "x"})


@pytest.mark.parametrize("typed", sorted(ANNOTATION_ORDERS, key=lambda tp: tp.__name__))
def test_declared_key_order(typed):
    assert list(typed.__annotations__) == ANNOTATION_ORDERS[typed]


def test_keyword_keys_use_the_functional_syntax():
    assert "class" in PairRow.__annotations__
    assert "pass" in ScoreReport.__annotations__


def test_results_module_import_hygiene():
    tree = ast.parse(Path(results.__file__).read_text(encoding="utf-8"))
    future = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module == "__future__"
    ]
    assert future == []
