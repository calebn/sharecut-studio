"""Pin the wire shape of ``TimelineService.join_quality`` and ``join_qa_sweep``.

``join_quality`` returns one report dict for an existing join (``join_sec``) or a proposed cut
(``cut_start``/``cut_end``); ``join_qa_sweep`` returns the whole-project sweep. The service
result, ``podcast edit join-quality`` / ``edit join-sweep`` (``json.dumps(indent=2)``),
``join_quality_tool`` / ``join_qa_sweep_tool`` (``to_json``), golden-ear ``_join_metrics`` and
``join_label`` (its ``features``) all carry the same dict. ``_as_dict`` lets the same
expectations hold if the service returns a model instead of a bare dict.

Scores are computed from audio, so only structure, key order and rounding are asserted
exactly; the numbers use ``pytest.approx``.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from typer.testing import CliRunner

from pause_policy_public_helpers import (
    configure,
    defaults,
    project,
    room,
    voice,
    workspace,
    write_wav,
)
from podcast_mcp.cli.main import app
from podcast_mcp.edits.join_continuity import JoinContinuityConfig, _Placement
from podcast_mcp.mcp.tools.edits import join_qa_sweep_tool, join_quality_tool
from podcast_mcp.models import Clip, EditDecision
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import TimelineService
from podcast_mcp.services.document.golden_ear import _join_metrics
from podcast_mcp.util.coded_error import CodedValueError

pytestmark = pytest.mark.unscoped_ok

runner = CliRunner()

REPORT_KEYS = [
    "track_id",
    "mode",
    "join_sec",
    "timebase",
    "risk",
    "invisibility",
    "verdict",
    "reasons",
    "detectors",
    "calibrated",
    "natural_p95",
    "side_sec",
    "disclaimer",
    "ranker",
]
ROW_KEYS = [*REPORT_KEYS, "source_gap_sec", "speech"]
SWEEP_KEYS = [
    "join_count",
    "fail_count",
    "review_count",
    "pass_count",
    "speech_cross_count",
    "worst",
    "joins",
    "disclaimer",
]
DETECTOR_KEYS = ["name", "score", "weight", "detail"]
DETECTORS = {
    "click": ["spike_over_rms"],
    "level_jump": ["jump_db", "pre_db", "post_db"],
    "spectral_flux": ["flux"],
    "mfcc_join_cost": ["score"],
    "lsf_mahalanobis": ["score"],
    "mca_join_cost": ["score"],
    "weighted_spectral_join": ["score"],
    "noise_floor": ["floor_delta_db"],
    "f0_jump": ["f0_left", "f0_right", "voiced"],
    "onset_collision": ["early_db"],
    "bicoherence_proxy": ["score"],
    "late_energy_ratio": ["score"],
}
RANKER_KEYS = ["available", "fail_proba", "threshold", "n_train"]
SPEECH_KEYS = [
    "track_id",
    "clip_id",
    "join_timeline_sec",
    "direction",
    "cut_source_sec",
    "voice_edge_source_sec",
    "removed_ms",
    "suggested_source_sec",
    "kept_level_db",
    "removed_level_db",
    "asr_prev_word",
    "asr_prev_end_sec",
    "asr_next_word",
    "asr_next_start_sec",
    "asr_lag_ms",
    "asr_disagrees",
]
DISCLAIMER = (
    "Fail-closed multi-detector join cost (TTS/forensic fusion). Not PEAQ/POLQA and not a "
    "human-ear guarantee - prefer leave-in when unsure."
)
SPEECH_REASON = "voiced speech cut through this join (see speech); never a pass"
TARGET_MESSAGE = "provide join_sec, or cut_start and cut_end"
# Continuous voice either side of the 2.0 s -> 4.7 s splice: the splice texture scores pass,
# the cut runs through voiced audio on both edges.
SPEECH_VOICES = [(1, 3), (4, 6)]
UNCALIBRATED = {"calibrate": False, "force_review_multi_hot": False}


def _as_dict(result: Any) -> dict:
    return result.model_dump(mode="json") if hasattr(result, "model_dump") else result


def _build(
    tmp_path: Path,
    monkeypatch,
    *,
    voices=None,
    guest: bool = False,
    track: str = "host",
    jc: dict | None = None,
    ranker: bool = False,
    topology: str = "deleted",
) -> str:
    """Host clips 0-2 and 4.7-6 (a join at timeline 2.0, source 2.0 -> 4.7) by default."""
    cfg = defaults()
    if jc is not None:
        cfg["join_continuity"] = jc
    configure(monkeypatch, cfg)
    result = project(tmp_path, topology=topology, guest="quiet" if guest else None)
    if voices is not None:
        audio = room(seed=5)
        for start, end in voices:
            voice(audio, start, end)
        write_wav(tmp_path / "raw" / "host.wav", audio)
    if guest:
        result.clips = [c for c in result.clips if c.track_id != "guest"]
        result.clips += [
            Clip(id="g0", track_id="guest", source_start=0, source_end=1, timeline_start=0),
            Clip(id="g1", track_id="guest", source_start=2, source_end=2.3, timeline_start=1),
        ]
    if track != "host":
        for item in [*result.clips, *result.transcripts]:
            if item.track_id == "host":
                item.track_id = track
        for owner in result.tracks:
            if owner.id == "host":
                owner.id = track
    ws = workspace(result)
    if ranker:
        model = {
            "weights": [0.0],
            "bias": 0.0,
            "feature_names": ["risk"],
            "threshold": 0.99,
            "false_pass_rate": 0.0,
            "n_train": 4,
        }
        dest = ws.project.artifacts_dir() / "join_ranker.json"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps(model), encoding="utf-8")
    return str(ws.path)


def _service(path: str, **kwargs) -> dict:
    return _as_dict(TimelineService(ProjectWorkspace.open(Path(path))).join_quality(**kwargs))


def _sweep(path: str, **kwargs) -> dict:
    return _as_dict(TimelineService(ProjectWorkspace.open(Path(path))).join_qa_sweep(**kwargs))


def _cli(path: str, command: str, *extra: str):
    return runner.invoke(app, ["edit", command, "--project", path, *extra])


def _check_report(report: dict, *, mode: str, timebase: str) -> None:
    assert list(report) == REPORT_KEYS
    assert report["track_id"] == "host"
    assert report["mode"] == mode
    assert isinstance(report["join_sec"], float)
    assert report["timebase"] == timebase
    assert isinstance(report["risk"], float)
    assert report["invisibility"] == pytest.approx(1 - report["risk"], abs=2e-4)
    assert report["verdict"] in {"pass", "review", "fail"}
    assert isinstance(report["reasons"], list)
    assert all(isinstance(r, str) for r in report["reasons"])
    assert report["side_sec"] == 0.045
    assert report["disclaimer"] == DISCLAIMER
    for row in report["detectors"]:
        assert list(row) == DETECTOR_KEYS


def _check_detectors(report: dict) -> None:
    assert [d["name"] for d in report["detectors"]] == list(DETECTORS)
    for row in report["detectors"]:
        assert list(row["detail"]) == DETECTORS[row["name"]]
        assert 0.0 <= row["score"] <= 1.0
        assert row["weight"] > 0
        assert row["score"] == round(row["score"], 4)
        assert row["weight"] == round(row["weight"], 4)


# ---------------------------------------------------------------- existing join


def _force_placement(monkeypatch, index: int) -> dict:
    """Make the placement at 0-based `index` the strict winner of the join's nine-way
    worst-placement search (order: dl in (0, -tol, +tol), dr in (0, -tol, +tol)).

    The real scores sit within ~0.002 of each other, so which placement wins is CPU
    dependent; forcing it keeps the report pin deterministic. Detector hits stay real."""
    from podcast_mcp.edits import join_continuity as jc

    original_wp = jc._worst_placement
    original_score = jc.score_splice_samples
    state: dict = {"join": False, "n": 0, "scored": []}

    def score(*args, **kwargs):
        risk, hits = original_score(*args, **kwargs)
        if state["join"]:
            risk = 0.9 if state["n"] == index else 0.1
            state["n"] += 1
        return risk, hits

    def worst_placement(*args, **kwargs):
        # the join's own call uses the default inaudible=True; calibration passes False
        state["join"], state["n"] = bool(kwargs.get("inaudible", True)), 0
        try:
            return original_wp(*args, **kwargs)
        finally:
            if state["join"]:
                state["scored"].append(state["n"])
            state["join"] = False

    monkeypatch.setattr(jc, "score_splice_samples", score)
    monkeypatch.setattr(jc, "_worst_placement", worst_placement)
    return state


def _check_existing_join_shape(report: dict, timebase: str) -> None:
    _check_report(report, mode="existing_join", timebase=timebase)
    _check_detectors(report)
    assert report["join_sec"] == 2.0
    assert report["calibrated"] is True
    assert report["natural_p95"] == pytest.approx(0.2677, abs=1e-2)
    assert report["natural_p95"] == round(report["natural_p95"], 4)
    assert report["ranker"] is None
    assert report["risk"] == round(report["risk"], 4)


@pytest.mark.parametrize("timebase", ["timeline", "source"])
def test_existing_join_report_shape(tmp_path, monkeypatch, timebase):
    state = _force_placement(monkeypatch, 2)  # (dl, dr) = (0, +tol)
    path = _build(tmp_path, monkeypatch)
    report = _service(path, track_id="host", join_sec=2.0, timebase=timebase)
    assert state["scored"] and set(state["scored"]) == {9}  # nine placements per join
    _check_existing_join_shape(report, timebase)
    assert report["reasons"][0] == "worst edge placement +0/+3 ms within +-3 ms"


@pytest.mark.parametrize("timebase", ["timeline", "source"])
def test_existing_join_report_without_a_shifted_placement_has_no_placement_reason(
    tmp_path, monkeypatch, timebase
):
    state = _force_placement(monkeypatch, 0)  # the unshifted (0, 0) placement wins
    path = _build(tmp_path, monkeypatch)
    report = _service(path, track_id="host", join_sec=2.0, timebase=timebase)
    assert state["scored"] and set(state["scored"]) == {9}
    _check_existing_join_shape(report, timebase)
    assert not any(r.startswith("worst edge placement") for r in report["reasons"])


def test_worst_edge_placement_reason_wording():
    cfg = JoinContinuityConfig()
    placement = _Placement(0.5, [], False, 0, round(3 * cfg.sample_rate / 1000.0))
    assert placement.reasons(cfg, cfg.sample_rate) == [
        "worst edge placement +0/+3 ms within +-3 ms"
    ]
    both = _Placement(0.5, [], False, -round(3 * cfg.sample_rate / 1000.0), placement.right_shift)
    assert both.reasons(cfg, cfg.sample_rate) == ["worst edge placement -3/+3 ms within +-3 ms"]
    assert _Placement(0.5, [], False, 0, 0).reasons(cfg, cfg.sample_rate) == []


def test_existing_join_default_timebase_is_timeline(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch)
    assert _service(path, track_id="host", join_sec=2.0)["timebase"] == "timeline"
    assert _service(path, track_id="host", join_sec=2.0, timebase="anything")["timebase"] == (
        "source"
    )


@pytest.mark.parametrize("given", [2, 2.0])
def test_join_sec_is_echoed_as_float(tmp_path, monkeypatch, given):
    path = _build(tmp_path, monkeypatch)
    echoed = _service(path, track_id="host", join_sec=given)["join_sec"]
    assert echoed == 2.0
    assert isinstance(echoed, float)
    assert json.dumps(echoed) == "2.0"


def test_existing_join_on_an_unspliced_track_still_has_a_report(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch, topology="split")
    report = _service(path, track_id="host", join_sec=4.7, timebase="source")
    _check_report(report, mode="existing_join", timebase="source")
    assert report["join_sec"] == 4.7


def test_natural_p95_is_null_when_calibration_is_off(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch, jc=UNCALIBRATED)
    report = _service(path, track_id="host", join_sec=2.0)
    assert list(report) == REPORT_KEYS
    assert "natural_p95" in report
    assert report["natural_p95"] is None
    assert report["calibrated"] is False
    assert '"natural_p95": null' in json.dumps(report)


def test_ranker_is_a_dict_when_a_ranker_is_saved(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch, ranker=True)
    report = _service(path, track_id="host", join_sec=2.0)
    assert list(report) == REPORT_KEYS
    assert list(report["ranker"]) == RANKER_KEYS
    assert report["ranker"] == {
        "available": True,
        "fail_proba": 0.5,
        "threshold": 0.99,
        "n_train": 4,
    }
    assert report["verdict"] == "pass"
    proposed = _service(path, track_id="host", cut_start=0.3, cut_end=2.0)
    assert list(proposed["ranker"]) == RANKER_KEYS


# ---------------------------------------------------------------- proposed cut


@pytest.mark.parametrize(
    ("timebase", "cut", "reason"),
    [
        ("source", (0.3, 4.45), "cut 0.300->4.450 (source)"),
        ("timeline", (0.3, 2.0), "cut 0.300->2.000 (timeline)"),
    ],
)
def test_proposed_cut_report_shape(tmp_path, monkeypatch, timebase, cut, reason):
    path = _build(tmp_path, monkeypatch)
    report = _service(path, track_id="host", cut_start=cut[0], cut_end=cut[1], timebase=timebase)
    _check_report(report, mode="proposed_cut", timebase=timebase)
    _check_detectors(report)
    assert report["join_sec"] == cut[0]
    assert report["reasons"][0] == reason
    assert report["calibrated"] is True
    assert report["natural_p95"] == pytest.approx(0.2677, abs=1e-2)
    assert report["ranker"] is None


def test_proposed_cut_wins_over_join_sec_and_echoes_cut_start_as_float(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch)
    report = _service(
        path, track_id="host", join_sec=2.0, cut_start=1, cut_end=2, timebase="source"
    )
    assert report["mode"] == "proposed_cut"
    assert report["join_sec"] == 1.0
    assert isinstance(report["join_sec"], float)
    assert report["reasons"][0] == "cut 1.000->2.000 (source)"


def test_proposed_cut_default_timebase_is_timeline(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch)
    report = _service(path, track_id="host", cut_start=0.3, cut_end=2.0)
    assert report["timebase"] == "timeline"


def test_proposed_cut_past_the_audio_is_a_one_detector_fail(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch)
    report = _service(path, track_id="host", cut_start=0.3, cut_end=999, timebase="source")
    _check_report(report, mode="proposed_cut", timebase="source")
    assert report["verdict"] == "fail"
    assert report["risk"] == 1.0
    assert report["invisibility"] == 0.0
    assert report["reasons"] == [
        "cut 0.300->999.000 (source)",
        "risk 1.00 >= fail threshold 0.48",
        "insufficient_audio=1.00",
    ]
    assert report["detectors"] == [
        {
            "name": "insufficient_audio",
            "score": 1.0,
            "weight": 2.0,
            "detail": {"left": 720, "right": 0},
        }
    ]
    assert [list(d["detail"]) for d in report["detectors"]] == [["left", "right"]]


def test_proposed_cut_natural_p95_is_null_when_calibration_is_off(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch, jc=UNCALIBRATED)
    report = _service(path, track_id="host", cut_start=0.3, cut_end=4.45, timebase="source")
    assert list(report) == REPORT_KEYS
    assert report["natural_p95"] is None
    assert report["calibrated"] is False


# ---------------------------------------------------------------- error path


def test_join_target_required_service(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch)
    ws = ProjectWorkspace.open(Path(path))
    for kwargs in ({}, {"cut_start": 0.3}, {"cut_end": 0.5}):
        with pytest.raises(CodedValueError) as err:
            TimelineService(ws).join_quality(track_id="host", **kwargs)
        assert err.value.code == "join_target_required"
        assert str(err.value) == TARGET_MESSAGE
        assert isinstance(err.value, ValueError)


def test_join_target_required_cli(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch)
    res = _cli(path, "join-quality", "--track", "host")
    assert res.exit_code == 1
    assert res.output == (
        f"Error: {TARGET_MESSAGE} (code join_target_required) "
        "(set PODCAST_DEBUG=1 for the traceback)\n"
    )


def test_join_target_required_mcp(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch)
    with pytest.raises(CodedValueError) as err:
        join_quality_tool(path, track_id="host")
    assert err.value.code == "join_target_required"
    assert str(err.value) == TARGET_MESSAGE


# ---------------------------------------------------------------- CLI and MCP bytes


def test_join_quality_cli_and_mcp_carry_the_service_dict_as_indent2_json(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch)
    service = _service(path, track_id="host", join_sec=2.0)
    cli = _cli(path, "join-quality", "--track", "host", "--join", "2")
    assert cli.exit_code == 0
    assert cli.stdout == json.dumps(service, indent=2) + "\n"
    assert list(json.loads(cli.stdout)) == REPORT_KEYS
    assert '  "join_sec": 2.0,\n' in cli.stdout
    assert '  "ranker": null\n}\n' in cli.stdout
    mcp = join_quality_tool(path, track_id="host", join_sec=2)
    assert mcp == json.dumps(service, indent=2)
    assert not mcp.endswith("\n")


def test_join_quality_cli_and_mcp_proposed_cut(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch)
    service = _service(path, track_id="host", cut_start=0.3, cut_end=4.45, timebase="source")
    cli = _cli(
        path,
        "join-quality",
        "--track",
        "host",
        "--cut-start",
        "0.3",
        "--cut-end",
        "4.45",
        "--timebase",
        "source",
    )
    assert cli.exit_code == 0
    assert cli.stdout == json.dumps(service, indent=2) + "\n"
    mcp = join_quality_tool(path, track_id="host", cut_start=0.3, cut_end=4.45, timebase="source")
    assert mcp == json.dumps(service, indent=2)
    assert json.loads(mcp)["mode"] == "proposed_cut"


@pytest.mark.parametrize("given", ["5", "5.0"])
def test_cli_and_mcp_join_sec_int_and_float_echo_alike(tmp_path, monkeypatch, given):
    path = _build(tmp_path, monkeypatch, topology="split")
    cli = _cli(path, "join-quality", "--track", "host", "--join", given)
    assert cli.exit_code == 0
    assert '  "join_sec": 5.0,\n' in cli.stdout
    assert '  "join_sec": 5.0,\n' in join_quality_tool(path, track_id="host", join_sec=float(given))
    assert '  "join_sec": 5.0,\n' in join_quality_tool(path, track_id="host", join_sec=5)


def test_non_ascii_track_id_is_escaped_in_cli_and_mcp_text(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch, track="hôst")
    service = _service(path, track_id="hôst", join_sec=2.0)
    assert service["track_id"] == "hôst"
    cli = _cli(path, "join-quality", "--track", "hôst", "--join", "2")
    assert cli.exit_code == 0
    assert '  "track_id": "h\\u00f4st",\n' in cli.stdout
    assert "ô" not in cli.stdout
    assert cli.stdout == json.dumps(service, indent=2) + "\n"
    mcp = join_quality_tool(path, track_id="hôst", join_sec=2)
    assert '  "track_id": "h\\u00f4st",\n' in mcp
    assert "ô" not in mcp
    assert mcp == json.dumps(service, indent=2)
    assert json.loads(mcp)["track_id"] == "hôst"

    sweep_cli = _cli(path, "join-sweep", "--track", "hôst")
    assert sweep_cli.exit_code == 0
    assert sweep_cli.stdout.count('"track_id": "h\\u00f4st"') == 2
    assert "ô" not in sweep_cli.stdout
    sweep_mcp = join_qa_sweep_tool(path, track_id="hôst")
    assert sweep_mcp.count('"track_id": "h\\u00f4st"') == 2
    assert "ô" not in sweep_mcp


# ---------------------------------------------------------------- sweep


def test_sweep_without_joins(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch, topology="intact")
    sweep = _sweep(path)
    assert list(sweep) == SWEEP_KEYS
    assert sweep == {
        "join_count": 0,
        "fail_count": 0,
        "review_count": 0,
        "pass_count": 0,
        "speech_cross_count": 0,
        "worst": None,
        "joins": [],
        "disclaimer": DISCLAIMER,
    }
    cli = _cli(path, "join-sweep")
    assert cli.exit_code == 0
    assert cli.stdout == json.dumps(sweep, indent=2) + "\n"
    assert '  "worst": null,\n  "joins": [],\n' in cli.stdout
    assert join_qa_sweep_tool(path) == json.dumps(sweep, indent=2)


def test_sweep_with_a_join(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch)
    sweep = _sweep(path)
    assert list(sweep) == SWEEP_KEYS
    assert sweep["join_count"] == 1
    assert [sweep[k] for k in ("fail_count", "review_count", "pass_count")] == [0, 0, 1]
    assert sweep["speech_cross_count"] == 0
    assert sweep["disclaimer"] == DISCLAIMER
    (row,) = sweep["joins"]
    assert sweep["worst"] == row
    assert list(row) == ROW_KEYS
    assert row["track_id"] == "host"
    assert row["mode"] == "existing_join"
    assert row["timebase"] == "timeline"
    assert row["join_sec"] == 2.0
    assert isinstance(row["join_sec"], float)
    assert row["source_gap_sec"] == 2.7
    assert row["speech"] == []
    assert row["calibrated"] is True
    assert row["natural_p95"] == pytest.approx(0.2646, abs=2e-2)
    assert row["ranker"] is None
    assert row["verdict"] == "pass"
    assert [d["name"] for d in row["detectors"]] == list(DETECTORS)
    for det in row["detectors"]:
        assert list(det) == DETECTOR_KEYS
        assert list(det["detail"]) == DETECTORS[det["name"]]


def test_sweep_row_is_the_existing_join_report_plus_two_keys(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch)
    (row,) = _sweep(path)["joins"]
    single = _service(path, track_id="host", join_sec=2.0)
    assert list(row)[: len(REPORT_KEYS)] == list(single)
    assert list(row)[len(REPORT_KEYS) :] == ["source_gap_sec", "speech"]
    assert row["join_sec"] == single["join_sec"]
    assert row["verdict"] == single["verdict"]
    assert row["risk"] == pytest.approx(single["risk"], abs=2e-2)


def test_sweep_row_natural_p95_is_null_without_calibration(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch, jc=UNCALIBRATED)
    (row,) = _sweep(path)["joins"]
    assert list(row) == ROW_KEYS
    assert row["natural_p95"] is None
    assert row["calibrated"] is False


def test_sweep_row_ranker_dict(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch, ranker=True)
    (row,) = _sweep(path)["joins"]
    assert list(row["ranker"]) == RANKER_KEYS
    assert row["ranker"]["n_train"] == 4


def test_sweep_row_with_speech_crossing_is_forced_to_review(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch, voices=SPEECH_VOICES, jc=UNCALIBRATED)
    sweep = _sweep(path)
    assert list(sweep) == SWEEP_KEYS
    assert sweep["join_count"] == 1
    assert [sweep[k] for k in ("fail_count", "review_count", "pass_count")] == [0, 1, 0]
    assert sweep["speech_cross_count"] == 2
    (row,) = sweep["joins"]
    assert sweep["worst"] == row
    assert list(row) == ROW_KEYS
    assert row["verdict"] == "review"
    assert row["reasons"][-1] == SPEECH_REASON
    assert row["reasons"].count(SPEECH_REASON) == 1
    assert row["risk"] < 0.28
    assert len(row["speech"]) == 2
    assert [list(c) for c in row["speech"]] == [SPEECH_KEYS, SPEECH_KEYS]
    assert [c["direction"] for c in row["speech"]] == ["clipped_tail", "clipped_onset"]
    assert [c["clip_id"] for c in row["speech"]] == ["host-0", "host-1"]
    assert {c["track_id"] for c in row["speech"]} == {"host"}
    assert [c["join_timeline_sec"] for c in row["speech"]] == [2.0, 2.0]
    assert [c["cut_source_sec"] for c in row["speech"]] == [2.0, 4.7]
    assert [c["asr_disagrees"] for c in row["speech"]] == [True, True]
    assert row["speech"][0]["asr_prev_word"] is None
    assert row["speech"][1]["asr_next_word"] == "after"
    assert row["source_gap_sec"] == 2.7


def test_sweep_speech_row_cli_and_mcp_text(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch, voices=SPEECH_VOICES, jc=UNCALIBRATED)
    sweep = _sweep(path)
    cli = _cli(path, "join-sweep", "--track", "host")
    assert cli.exit_code == 0
    assert cli.stdout == json.dumps(sweep, indent=2) + "\n"
    assert list(json.loads(cli.stdout)["joins"][0]) == ROW_KEYS
    mcp = join_qa_sweep_tool(path, track_id="host")
    assert mcp == json.dumps(sweep, indent=2)
    assert '"asr_prev_word": null' in mcp
    assert '"asr_disagrees": true' in mcp


def test_sweep_track_filter(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch, guest=True)
    everything = _sweep(path)
    assert list(everything) == SWEEP_KEYS
    assert everything["join_count"] == 2
    assert [r["track_id"] for r in everything["joins"]] == ["host", "guest"]
    assert [r["join_sec"] for r in everything["joins"]] == [2.0, 1.0]
    assert [r["source_gap_sec"] for r in everything["joins"]] == [2.7, 1.0]
    assert everything["worst"] == max(everything["joins"], key=lambda r: r["risk"])
    for tid, join_sec in (("host", 2.0), ("guest", 1.0)):
        only = _sweep(path, track_id=tid)
        assert list(only) == SWEEP_KEYS
        assert only["join_count"] == 1
        assert only["joins"][0]["track_id"] == tid
        assert only["joins"][0]["join_sec"] == join_sec
        assert only["worst"] == only["joins"][0]
        assert only["pass_count"] + only["review_count"] + only["fail_count"] == 1
    cli = _cli(path, "join-sweep", "--track", "guest")
    assert cli.exit_code == 0
    assert cli.stdout == json.dumps(_sweep(path, track_id="guest"), indent=2) + "\n"
    assert join_qa_sweep_tool(path, track_id="guest") == json.dumps(
        _sweep(path, track_id="guest"), indent=2
    )


def test_sweep_keys_survive_the_json_round_trip(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch, guest=True)
    sweep = json.loads(join_qa_sweep_tool(path))
    assert list(sweep) == SWEEP_KEYS
    assert [list(r) for r in sweep["joins"]] == [ROW_KEYS, ROW_KEYS]
    assert list(sweep["worst"]) == ROW_KEYS


# ---------------------------------------------------------------- golden ear and join_label


def test_golden_ear_join_metrics_is_the_proposed_cut_report(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch)
    ws = ProjectWorkspace.open(Path(path))
    edit = EditDecision(id="e1", track_id="host", start=0.3, end=4.45)
    metrics = _as_dict(_join_metrics(SimpleNamespace(ws=ws), edit, None))
    assert list(metrics) == REPORT_KEYS
    assert metrics["mode"] == "proposed_cut"
    assert metrics["timebase"] == "source"
    assert metrics["join_sec"] == 0.3
    assert metrics["reasons"][0] == "cut 0.300->4.450 (source)"
    assert metrics == _service(
        path, track_id="host", cut_start=0.3, cut_end=4.45, timebase="source"
    )


def test_golden_ear_join_metrics_error_fallback(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch)
    ws = ProjectWorkspace.open(Path(path))
    edit = EditDecision(id="e1", track_id="nope", start=0.3, end=4.45)
    metrics = _join_metrics(SimpleNamespace(ws=ws), edit, None)
    assert list(metrics) == ["verdict", "error"]
    assert metrics == {
        "verdict": "error",
        "error": "CodedValueError: unknown track_id: 'nope'",
    }


def test_join_label_features_are_the_join_quality_report(tmp_path, monkeypatch):
    path = _build(tmp_path, monkeypatch)
    ws = ProjectWorkspace.open(Path(path))
    result = TimelineService(ws).join_label(
        track_id="host", join_sec=2, verdict="pass", timebase="timeline"
    )
    wire = _as_dict(result)
    assert list(wire) == ["label", "played", "features"]
    assert wire["played"] is False
    assert list(wire["features"]) == REPORT_KEYS
    assert wire["features"] == _service(path, track_id="host", join_sec=2.0, timebase="timeline")
    assert wire["label"]["track_id"] == "host"
    assert wire["label"]["join_sec"] == 2.0
    assert wire["label"]["verdict"] == "pass"
    assert wire["label"]["features"]["risk"] == wire["features"]["risk"]
    assert list(wire["label"]["features"]["detectors"]) == list(DETECTORS)
