"""Pin the wire output of the join label and join train operations.

``TimelineService.join_label`` / ``join_train``, the ``edit join-label`` / ``edit join-train``
CLI commands (``json.dumps(indent=2)``) and the ``join_label_tool`` MCP tool (``to_json``) all
return the same dicts. The project is real: two host clips with a cut between them over
generated audio, so the features are the real detector output. The only normalized field is
the label timestamp ``ts``.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.mcp.tools.edits import join_label_tool
from podcast_mcp.models import (
    Clip,
    MediaAsset,
    Track,
    TrackRole,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import TimelineService
from podcast_mcp.util.coded_error import CodedValueError

pytestmark = pytest.mark.unscoped_ok

runner = CliRunner()

DETECTORS = {
    "click": 0.1378,
    "level_jump": 0.0037,
    "spectral_flux": 0.0001,
    "mfcc_join_cost": 0.0981,
    "lsf_mahalanobis": 1.0,
    "mca_join_cost": 0.0341,
    "weighted_spectral_join": 0.3818,
    "noise_floor": 0.0042,
    "f0_jump": 0.0,
    "onset_collision": 1.0,
    "bicoherence_proxy": 0.0,
    "late_energy_ratio": 0.0,
}
DETECTOR_ROWS = [
    {
        "name": "click",
        "score": 0.1378,
        "weight": 1.35,
        "detail": {"spike_over_rms": 1.6539},
    },
    {
        "name": "level_jump",
        "score": 0.0037,
        "weight": 0.85,
        "detail": {"jump_db": 0.044, "pre_db": -21.06, "post_db": -21.1},
    },
    {"name": "spectral_flux", "score": 0.0001, "weight": 0.444, "detail": {"flux": 0.0}},
    {
        "name": "mfcc_join_cost",
        "score": 0.0981,
        "weight": 0.5045,
        "detail": {"score": 0.0981},
    },
    {
        "name": "lsf_mahalanobis",
        "score": 1.0,
        "weight": 0.4843,
        "detail": {"score": 1.0},
    },
    {
        "name": "mca_join_cost",
        "score": 0.0341,
        "weight": 0.4641,
        "detail": {"score": 0.0341},
    },
    {
        "name": "weighted_spectral_join",
        "score": 0.3818,
        "weight": 0.5247,
        "detail": {"score": 0.3818},
    },
    {
        "name": "noise_floor",
        "score": 0.0042,
        "weight": 0.7,
        "detail": {"floor_delta_db": 0.042},
    },
    {
        "name": "f0_jump",
        "score": 0.0,
        "weight": 0.3632,
        "detail": {"f0_left": 219.2, "f0_right": 219.2, "ratio": 1.0},
    },
    {
        "name": "onset_collision",
        "score": 1.0,
        "weight": 1.15,
        "detail": {"early_db": -21.17},
    },
    {
        "name": "bicoherence_proxy",
        "score": 0.0,
        "weight": 0.2422,
        "detail": {"score": 0.0},
    },
    {
        "name": "late_energy_ratio",
        "score": 0.0,
        "weight": 0.55,
        "detail": {"score": 0.0},
    },
]
DISCLAIMER = (
    "Fail-closed multi-detector join cost (TTS/forensic fusion). Not PEAQ/POLQA and not a "
    "human-ear guarantee - prefer leave-in when unsure."
)
LABEL_KEYS = [
    "ts",
    "track_id",
    "timebase",
    "join_sec",
    "cut_start",
    "cut_end",
    "verdict",
    "note",
    "features",
    "episode",
    "config_hash",
    "source",
]
FEATURES_KEYS = [
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
RESULT_KEYS = ["label", "played", "features"]
TRAIN_KEYS = ["model", "path", "n_labels"]
MODEL_KEYS = [
    "weights",
    "bias",
    "feature_names",
    "threshold",
    "false_pass_rate",
    "n_train",
]
REASONS = [
    "worst edge placement +0/+3 ms within +-3 ms",
    "multi_hot=2 forcing >= review",
    "risk 0.28 in review band [0.28, 0.48)",
    "lsf_mahalanobis=1.00",
    "onset_collision=1.00",
]

TS = re.compile(r'"ts": "[^"]+"')


def _features(*, mode: str, join_sec: float, timebase: str, reasons: list[str]) -> dict:
    return {
        "track_id": "host",
        "mode": mode,
        "join_sec": join_sec,
        "timebase": timebase,
        "risk": 0.28,
        "invisibility": 0.72,
        "verdict": "review",
        "reasons": reasons,
        "detectors": DETECTOR_ROWS,
        "calibrated": True,
        "natural_p95": 0.2831,
        "side_sec": 0.045,
        "disclaimer": DISCLAIMER,
        "ranker": None,
    }


def _label(*, join_sec, timebase, verdict, note="", cut_start=None, cut_end=None) -> dict:
    return {
        "ts": "<ts>",
        "track_id": "host",
        "timebase": timebase,
        "join_sec": join_sec,
        "cut_start": cut_start,
        "cut_end": cut_end,
        "verdict": verdict,
        "note": note,
        "features": {"risk": 0.28, "detectors": DETECTORS},
        "episode": "test_episode",
        "config_hash": "44136fa355b3",
        "source": "human",
    }


def _result(label: dict, features: dict, *, played: bool = False) -> dict:
    return {"label": label, "played": played, "features": features}


EXISTING = _features(mode="existing_join", join_sec=0.8, timebase="timeline", reasons=REASONS)
CUT = _features(
    mode="proposed_cut",
    join_sec=0.8,
    timebase="source",
    reasons=["cut 0.800->1.200 (source)", *REASONS],
)


def _norm(text: str) -> str:
    """The only normalization: the label timestamp."""
    assert len(TS.findall(text)) == 1
    return TS.sub('"ts": "<ts>"', text)


def _norm_result(result: dict) -> dict:
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT[\d:.]+\+00:00", result["label"]["ts"])
    return {**result, "label": {**result["label"], "ts": "<ts>"}}


@pytest.fixture
def ws(minimal_project) -> ProjectWorkspace:
    opened = ProjectWorkspace.open(minimal_project)
    opened.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    opened.project.timeline.clips = [
        Clip(id="a", track_id="host", source_start=0.0, source_end=0.8, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=1.2, source_end=2.0, timeline_start=0.8),
    ]
    save_project(opened.project, opened.path)
    return ProjectWorkspace.open(minimal_project)


def _label_lines(ws: ProjectWorkspace) -> list[str]:
    path = ws.project.artifacts_dir() / "join_labels.jsonl"
    return path.read_text(encoding="utf-8").splitlines() if path.is_file() else []


def _cli(minimal_project, *args: str):
    return runner.invoke(app, ["edit", *args, "--project", str(minimal_project)])


def _join_label_args(*extra: str) -> list[str]:
    return ["join-label", "--track", "host", "--join", "0.8", "--timebase", "timeline", *extra]


# ----------------------------------------------------------------- service: join_label


def test_service_join_label_wire(ws):
    result = TimelineService(ws).join_label(
        track_id="host", join_sec=0.8, verdict="fail", note="n", timebase="timeline"
    )
    result = result.model_dump()
    assert list(result) == RESULT_KEYS
    assert list(result["label"]) == LABEL_KEYS
    assert list(result["label"]["features"]) == ["risk", "detectors"]
    assert list(result["label"]["features"]["detectors"]) == list(DETECTORS)
    assert list(result["features"]) == FEATURES_KEYS
    assert result["played"] is False
    assert result["features"]["ranker"] is None
    expected = _result(
        _label(join_sec=0.8, timebase="timeline", verdict="fail", note="n"), EXISTING
    )
    assert json.dumps(_norm_result(result)) == json.dumps(expected)
    # the label record on disk is the same dict, one line, with the same timestamp
    (line,) = _label_lines(ws)
    assert json.loads(line) == result["label"]
    assert list(json.loads(line)) == LABEL_KEYS
    assert line == json.dumps(result["label"], ensure_ascii=False)


def test_service_join_label_pinned_text(ws):
    result = TimelineService(ws).join_label(
        track_id="host", join_sec=0.8, verdict="pass", timebase="timeline"
    )
    result = result.model_dump()
    text = json.dumps(_norm_result(result))
    assert text.startswith(
        '{"label": {"ts": "<ts>", "track_id": "host", "timebase": "timeline", "join_sec": 0.8, '
        '"cut_start": null, "cut_end": null, "verdict": "pass", "note": "", "features": '
        '{"risk": 0.28, "detectors": {"click": 0.1378, "level_jump": 0.0037, '
        '"spectral_flux": 0.0001, "mfcc_join_cost": 0.0981, "lsf_mahalanobis": 1.0, '
        '"mca_join_cost": 0.0341, "weighted_spectral_join": 0.3818, "noise_floor": 0.0042, '
        '"f0_jump": 0.0, "onset_collision": 1.0, "bicoherence_proxy": 0.0, '
        '"late_energy_ratio": 0.0}}, "episode": "test_episode", "config_hash": '
        '"44136fa355b3", "source": "human"}, "played": false, "features": {"track_id": "host", '
        '"mode": "existing_join", "join_sec": 0.8, "timebase": "timeline", "risk": 0.28, '
        '"invisibility": 0.72, "verdict": "review", "reasons": ["worst edge placement +0/+3 ms '
        'within +-3 ms", "multi_hot=2 forcing >= review", "risk 0.28 in review band '
        '[0.28, 0.48)", "lsf_mahalanobis=1.00", "onset_collision=1.00"], "detectors": '
        '[{"name": "click", "score": 0.1378, "weight": 1.35, "detail": {"spike_over_rms": '
        '1.6539}}, {"name": "level_jump", "score": 0.0037, "weight": 0.85, "detail": '
        '{"jump_db": 0.044, "pre_db": -21.06, "post_db": -21.1}}, '
    )
    assert text.endswith(
        '"calibrated": true, "natural_p95": 0.2831, "side_sec": 0.045, "disclaimer": '
        f'"{DISCLAIMER}", "ranker": null}}}}'
    )


def test_service_join_label_default_timebase_is_source(ws):
    result = TimelineService(ws).join_label(track_id="host", join_sec=0.8, verdict="pass")
    result = result.model_dump()
    assert result["label"]["timebase"] == "source"
    assert result["features"]["timebase"] == "source"
    assert result["features"]["mode"] == "existing_join"
    assert list(result["features"]) == FEATURES_KEYS


def test_service_join_label_by_speaker(ws):
    result = TimelineService(ws).join_label(
        speaker="Host", join_sec=0.8, verdict="pass", timebase="timeline"
    )
    result = result.model_dump()
    assert result["label"]["track_id"] == "host"
    assert json.dumps(_norm_result(result)) == json.dumps(
        _result(_label(join_sec=0.8, timebase="timeline", verdict="pass"), EXISTING)
    )


def test_service_join_label_cut_range(ws):
    result = TimelineService(ws).join_label(
        track_id="host", join_sec=0.8, verdict="pass", cut_start=0.8, cut_end=1.2
    )
    result = result.model_dump()
    assert list(result) == RESULT_KEYS
    assert list(result["features"]) == FEATURES_KEYS
    expected = _result(
        _label(join_sec=0.8, timebase="source", verdict="pass", cut_start=0.8, cut_end=1.2),
        CUT,
    )
    assert json.dumps(_norm_result(result)) == json.dumps(expected)


def test_service_join_label_int_join_sec_is_float(ws):
    result = TimelineService(ws).join_label(
        track_id="host", join_sec=1, verdict="pass", timebase="timeline"
    )
    result = result.model_dump()
    assert isinstance(result["label"]["join_sec"], float)
    assert json.dumps(result["label"]["join_sec"]) == "1.0"
    assert isinstance(result["features"]["join_sec"], float)
    (line,) = _label_lines(ws)
    assert '"join_sec": 1.0,' in line


def test_service_join_label_play_true(ws):
    with patch("podcast_mcp.services.document.play.PlayService.play") as play:
        result = TimelineService(ws).join_label(
            track_id="host", join_sec=0.8, verdict="pass", timebase="timeline", play=True
        )
        result = result.model_dump()
    assert list(result) == RESULT_KEYS
    assert result["played"] is True
    assert json.dumps(_norm_result(result)) == json.dumps(
        _result(_label(join_sec=0.8, timebase="timeline", verdict="pass"), EXISTING, played=True)
    )
    (request,) = play.call_args.args
    assert (request.source, request.start_sec, request.end_sec) == ("processed:host", 0.0, 2.8)


def test_service_join_label_play_start_is_clamped_at_zero_and_offset_two_sec(ws):
    with patch("podcast_mcp.services.document.play.PlayService.play") as play:
        TimelineService(ws).join_label(
            track_id="host", join_sec=1.0, verdict="fail", timebase="timeline", play=True
        )
    (request,) = play.call_args.args
    assert (request.start_sec, request.end_sec) == (0.0, 3.0)


def test_service_join_label_appends_one_line_per_call(ws):
    svc = TimelineService(ws)
    svc.join_label(track_id="host", join_sec=0.8, verdict="pass", timebase="timeline")
    svc.join_label(track_id="host", join_sec=0.8, verdict="fail", timebase="timeline")
    lines = _label_lines(ws)
    assert [json.loads(x)["verdict"] for x in lines] == ["pass", "fail"]
    assert all(list(json.loads(x)) == LABEL_KEYS for x in lines)


# ------------------------------------------------------------ service: join_label errors


@pytest.mark.parametrize("verdict", ["bad", "", "PASS", "review"])
def test_service_join_label_verdict_invalid(ws, verdict):
    with pytest.raises(CodedValueError) as raised:
        TimelineService(ws).join_label(track_id="host", join_sec=0.8, verdict=verdict)
    assert raised.value.code == "join_verdict_invalid"
    assert str(raised.value) == "verdict must be pass or fail"
    assert _label_lines(ws) == []


def test_service_join_label_verdict_invalid_does_not_play(ws):
    with patch("podcast_mcp.services.document.play.PlayService.play") as play:
        with pytest.raises(CodedValueError) as raised:
            TimelineService(ws).join_label(track_id="host", join_sec=0.8, verdict="x", play=True)
    assert raised.value.code == "join_verdict_invalid"
    play.assert_not_called()


def test_service_join_label_target_required(ws):
    with pytest.raises(CodedValueError) as raised:
        TimelineService(ws).join_label(track_id="host", join_sec=None, verdict="pass")
    assert raised.value.code == "join_target_required"
    assert str(raised.value) == "provide join_sec, or cut_start and cut_end"
    assert _label_lines(ws) == []


def test_service_join_label_unknown_track(ws):
    with pytest.raises(CodedValueError) as raised:
        TimelineService(ws).join_label(track_id="nope", join_sec=0.8, verdict="pass")
    assert raised.value.code == "track_not_found"
    assert str(raised.value) == "unknown track_id: 'nope'"
    assert _label_lines(ws) == []


def test_service_join_label_track_required(ws):
    with pytest.raises(CodedValueError) as raised:
        TimelineService(ws).join_label(join_sec=0.8, verdict="pass")
    assert raised.value.code == "missing_argument"
    assert str(raised.value) == "track_id or speaker is required"


def test_service_join_label_verdict_checked_before_target(ws):
    with pytest.raises(CodedValueError) as raised:
        TimelineService(ws).join_label(track_id="host", join_sec=None, verdict="bad")
    assert raised.value.code == "join_verdict_invalid"


# --------------------------------------------------------------- service: join_train

TRAINED_MODEL_ONE = (
    '{"weights": [0.0], "bias": 5.0, "feature_names": ["risk"], "threshold": 0.5, '
    '"false_pass_rate": 0.0, "n_train": 1}'
)
TRAINED_MODEL_NONE = (
    '{"weights": [0.0], "bias": 5.0, "feature_names": ["risk"], "threshold": 0.5, '
    '"false_pass_rate": 0.0, "n_train": 0}'
)
FILE_LABELS = [
    {
        "ts": "T",
        "track_id": "host",
        "timebase": "source",
        "join_sec": 1.0,
        "cut_start": None,
        "cut_end": None,
        "verdict": verdict,
        "note": "",
        "features": {"risk": risk, "detectors": {"click": risk}},
        "episode": "e",
        "config_hash": "h",
        "source": "human",
    }
    for verdict, risk in (("pass", 0.1), ("fail", 0.6), ("pass", 0.2), ("fail", 0.9))
]
TRAINED_MODEL_FILE = (
    '{"weights": [8.287112077596877, 8.287112077596877], "bias": -6.959868448125731, '
    '"feature_names": ["det:click", "risk"], "threshold": 0.9542652294213642, '
    '"false_pass_rate": 0.5, "n_train": 4}'
)


def _labels_file(tmp_path: Path) -> Path:
    path = tmp_path / "labels.jsonl"
    path.write_text("".join(json.dumps(x) + "\n" for x in FILE_LABELS), encoding="utf-8")
    return path


def _ranker_path(ws: ProjectWorkspace) -> str:
    return str(ws.project.artifacts_dir() / "join_ranker.json")


def test_service_join_train_without_labels(ws):
    result = TimelineService(ws).join_train()
    result = result.model_dump()
    assert list(result) == TRAIN_KEYS
    assert list(result["model"]) == MODEL_KEYS
    assert json.dumps(result) == (
        f'{{"model": {TRAINED_MODEL_NONE}, "path": {json.dumps(_ranker_path(ws))}, "n_labels": 0}}'
    )
    assert isinstance(result["n_labels"], int)
    assert isinstance(result["path"], str)
    assert json.loads(Path(result["path"]).read_text(encoding="utf-8")) == result["model"]


def test_service_join_train_after_one_label(ws):
    svc = TimelineService(ws)
    svc.join_label(track_id="host", join_sec=0.8, verdict="fail", timebase="timeline")
    result = svc.join_train()
    result = result.model_dump()
    assert list(result) == TRAIN_KEYS
    assert json.dumps(result) == (
        f'{{"model": {TRAINED_MODEL_ONE}, "path": {json.dumps(_ranker_path(ws))}, "n_labels": 1}}'
    )


def test_service_join_train_after_four_labels_feature_names(ws):
    svc = TimelineService(ws)
    for verdict in ("pass", "fail", "pass", "fail"):
        svc.join_label(track_id="host", join_sec=0.8, verdict=verdict, timebase="timeline")
    result = svc.join_train()
    result = result.model_dump()
    assert list(result["model"]) == MODEL_KEYS
    assert result["n_labels"] == 4
    assert result["model"]["n_train"] == 4
    assert result["model"]["feature_names"] == [
        "det:bicoherence_proxy",
        "det:click",
        "det:f0_jump",
        "det:late_energy_ratio",
        "det:level_jump",
        "det:lsf_mahalanobis",
        "det:mca_join_cost",
        "det:mfcc_join_cost",
        "det:noise_floor",
        "det:onset_collision",
        "det:spectral_flux",
        "det:weighted_spectral_join",
        "risk",
    ]
    assert result["model"]["weights"] == [0.0] * 13
    assert result["model"]["threshold"] == 0.5
    assert result["model"]["false_pass_rate"] == 0.0


def test_service_join_train_labels_file_and_out_path(ws, tmp_path):
    out = tmp_path / "ranker_out.json"
    result = TimelineService(ws).join_train(labels_path=_labels_file(tmp_path), out_path=out)
    result = result.model_dump()
    assert list(result) == TRAIN_KEYS
    assert json.dumps(result) == (
        f'{{"model": {TRAINED_MODEL_FILE}, "path": {json.dumps(str(out))}, "n_labels": 4}}'
    )
    assert json.dumps(json.loads(out.read_text(encoding="utf-8"))) == TRAINED_MODEL_FILE
    # the default ranker path is untouched when out_path is given
    assert not (ws.project.artifacts_dir() / "join_ranker.json").exists()


def test_service_join_train_missing_labels_file(ws, tmp_path):
    out = tmp_path / "sub.json"
    result = TimelineService(ws).join_train(labels_path=tmp_path / "absent.jsonl", out_path=out)
    result = result.model_dump()
    assert json.dumps(result) == (
        f'{{"model": {TRAINED_MODEL_NONE}, "path": {json.dumps(str(out))}, "n_labels": 0}}'
    )


def test_service_join_train_labels_file_default_out(ws, tmp_path):
    result = TimelineService(ws).join_train(labels_path=_labels_file(tmp_path))
    result = result.model_dump()
    assert result["path"] == _ranker_path(ws)
    assert result["n_labels"] == 4
    assert json.dumps(result["model"]) == TRAINED_MODEL_FILE


# ---------------------------------------------------------------------------- CLI


def test_cli_join_label_wire(ws, minimal_project):
    result = _cli(minimal_project, *_join_label_args("--verdict", "fail", "--note", "n"))
    assert result.exit_code == 0, result.output
    expected = _result(
        _label(join_sec=0.8, timebase="timeline", verdict="fail", note="n"), EXISTING
    )
    assert _norm(result.stdout) == json.dumps(expected, indent=2) + "\n"
    out = json.loads(result.stdout)
    assert list(out) == RESULT_KEYS
    assert list(out["label"]) == LABEL_KEYS
    assert list(out["features"]) == FEATURES_KEYS
    assert result.stdout.startswith('{\n  "label": {\n    "ts": "')
    assert '\n  "played": false,\n  "features": {\n    "track_id": "host",' in result.stdout
    assert [json.loads(x) for x in _label_lines(ws)] == [out["label"]]


def test_cli_join_label_defaults_timebase_source_and_empty_note(ws, minimal_project):
    result = _cli(
        minimal_project, "join-label", "--track", "host", "--join", "0.8", "--verdict", "pass"
    )
    assert result.exit_code == 0, result.output
    out = json.loads(result.stdout)
    assert out["label"]["timebase"] == "source"
    assert out["label"]["note"] == ""
    assert out["played"] is False


def test_cli_join_label_int_join_prints_float(ws, minimal_project):
    result = _cli(
        minimal_project,
        "join-label",
        "--track",
        "host",
        "--join",
        "1",
        "--verdict",
        "pass",
        "--timebase",
        "timeline",
    )
    assert result.exit_code == 0, result.output
    assert '\n    "join_sec": 1.0,\n    "cut_start": null,' in result.stdout
    assert '\n    "join_sec": 1.0,\n    "timebase": "timeline",' in result.stdout


def test_cli_join_label_by_speaker(ws, minimal_project):
    result = _cli(
        minimal_project,
        "join-label",
        "--speaker",
        "Host",
        "--join",
        "0.8",
        "--verdict",
        "pass",
        "--timebase",
        "timeline",
    )
    assert result.exit_code == 0, result.output
    expected = _result(_label(join_sec=0.8, timebase="timeline", verdict="pass"), EXISTING)
    assert _norm(result.stdout) == json.dumps(expected, indent=2) + "\n"


def test_cli_join_label_play(ws, minimal_project):
    with patch("podcast_mcp.services.document.play.PlayService.play") as play:
        result = _cli(minimal_project, *_join_label_args("--verdict", "pass", "--play"))
    assert result.exit_code == 0, result.output
    expected = _result(
        _label(join_sec=0.8, timebase="timeline", verdict="pass"), EXISTING, played=True
    )
    assert _norm(result.stdout) == json.dumps(expected, indent=2) + "\n"
    (request,) = play.call_args.args
    assert (request.source, request.start_sec, request.end_sec) == ("processed:host", 0.0, 2.8)


def test_cli_join_label_no_play_is_default(ws, minimal_project):
    with patch("podcast_mcp.services.document.play.PlayService.play") as play:
        result = _cli(minimal_project, *_join_label_args("--verdict", "pass", "--no-play"))
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["played"] is False
    play.assert_not_called()


def test_cli_join_label_errors_print_nothing(ws, minimal_project):
    bad_verdict = _cli(minimal_project, *_join_label_args("--verdict", "bad"))
    assert bad_verdict.exit_code == 1
    assert bad_verdict.stdout == ""
    unknown = _cli(
        minimal_project, "join-label", "--track", "nope", "--join", "0.8", "--verdict", "pass"
    )
    assert unknown.exit_code == 1
    assert unknown.stdout == ""
    assert _label_lines(ws) == []


def test_cli_join_label_missing_options(ws, minimal_project):
    no_verdict = _cli(minimal_project, "join-label", "--track", "host", "--join", "0.8")
    assert no_verdict.exit_code == 2
    assert no_verdict.stdout == ""
    no_join = _cli(minimal_project, "join-label", "--track", "host", "--verdict", "pass")
    assert no_join.exit_code == 2
    assert no_join.stdout == ""
    no_track = _cli(minimal_project, "join-label", "--join", "0.8", "--verdict", "pass")
    assert no_track.exit_code == 1
    assert no_track.stdout == ""
    assert _label_lines(ws) == []


def test_cli_join_train_wire(ws, minimal_project):
    result = _cli(minimal_project, "join-train")
    assert result.exit_code == 0, result.output
    expected = {
        "model": json.loads(TRAINED_MODEL_NONE),
        "path": _ranker_path(ws),
        "n_labels": 0,
    }
    assert result.stdout == json.dumps(expected, indent=2) + "\n"
    assert result.stdout == (
        '{\n  "model": {\n    "weights": [\n      0.0\n    ],\n    "bias": 5.0,\n'
        '    "feature_names": [\n      "risk"\n    ],\n    "threshold": 0.5,\n'
        '    "false_pass_rate": 0.0,\n    "n_train": 0\n  },\n'
        f'  "path": {json.dumps(_ranker_path(ws))},\n  "n_labels": 0\n}}\n'
    )
    assert list(json.loads(result.stdout)) == TRAIN_KEYS


def test_cli_join_train_after_label(ws, minimal_project):
    assert _cli(minimal_project, *_join_label_args("--verdict", "fail")).exit_code == 0
    result = _cli(minimal_project, "join-train")
    assert result.exit_code == 0, result.output
    expected = {
        "model": json.loads(TRAINED_MODEL_ONE),
        "path": _ranker_path(ws),
        "n_labels": 1,
    }
    assert result.stdout == json.dumps(expected, indent=2) + "\n"


def test_cli_join_train_labels_and_out(ws, minimal_project, tmp_path):
    out = tmp_path / "cli_ranker.json"
    result = _cli(
        minimal_project, "join-train", "--labels", str(_labels_file(tmp_path)), "--out", str(out)
    )
    assert result.exit_code == 0, result.output
    expected = {"model": json.loads(TRAINED_MODEL_FILE), "path": str(out), "n_labels": 4}
    assert result.stdout == json.dumps(expected, indent=2) + "\n"
    assert '\n    "weights": [\n      8.287112077596877,\n      8.287112077596877\n    ],' in (
        result.stdout
    )
    assert '\n    "threshold": 0.9542652294213642,\n' in result.stdout
    assert out.is_file()


# ---------------------------------------------------------------------------- MCP


def test_mcp_join_label_tool_wire(ws, minimal_project):
    text = join_label_tool(
        str(minimal_project), 0.8, "fail", track_id="host", timebase="timeline", note="n"
    )
    expected = _result(
        _label(join_sec=0.8, timebase="timeline", verdict="fail", note="n"), EXISTING
    )
    assert _norm(text) == json.dumps(expected, indent=2)
    assert not text.endswith("\n")
    assert list(json.loads(text)) == RESULT_KEYS
    assert [json.loads(x) for x in _label_lines(ws)] == [json.loads(text)["label"]]


def test_mcp_join_label_tool_cut_range(ws, minimal_project):
    text = join_label_tool(
        str(minimal_project), 0.8, "pass", track_id="host", cut_start=0.8, cut_end=1.2
    )
    expected = _result(
        _label(join_sec=0.8, timebase="source", verdict="pass", cut_start=0.8, cut_end=1.2),
        CUT,
    )
    assert _norm(text) == json.dumps(expected, indent=2)


def test_mcp_join_label_tool_play(ws, minimal_project):
    with patch("podcast_mcp.services.document.play.PlayService.play") as play:
        text = join_label_tool(
            str(minimal_project), 0.8, "pass", track_id="host", timebase="timeline", play=True
        )
    expected = _result(
        _label(join_sec=0.8, timebase="timeline", verdict="pass"), EXISTING, played=True
    )
    assert _norm(text) == json.dumps(expected, indent=2)
    assert play.call_count == 1


def test_mcp_join_label_tool_by_speaker_default_timebase(ws, minimal_project):
    text = join_label_tool(str(minimal_project), 1, "pass", speaker="Host")
    out = json.loads(text)
    assert out["label"]["track_id"] == "host"
    assert out["label"]["timebase"] == "source"
    assert '\n    "join_sec": 1.0,\n    "cut_start": null,' in text


def test_mcp_join_label_tool_errors_raise(ws, minimal_project):
    with pytest.raises(CodedValueError) as bad:
        join_label_tool(str(minimal_project), 0.8, "bad", track_id="host")
    assert bad.value.code == "join_verdict_invalid"
    with pytest.raises(CodedValueError) as unknown:
        join_label_tool(str(minimal_project), 0.8, "pass", track_id="nope")
    assert unknown.value.code == "track_not_found"
    with pytest.raises(CodedValueError) as no_track:
        join_label_tool(str(minimal_project), 0.8, "pass")
    assert no_track.value.code == "missing_argument"
    assert _label_lines(ws) == []
