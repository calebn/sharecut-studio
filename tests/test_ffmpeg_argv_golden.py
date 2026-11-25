"""scripts/ffmpeg_argv_golden.py: the recorded argv and output hashes are the same on every run."""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path

import pytest

from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.util import process
from script_loader import load_script

golden = load_script("ffmpeg_argv_golden", register=True)
SUBSET = ("probe", "export")


def _record(directory: Path) -> dict:
    engine = FFmpegEngine()
    if not engine.check_available()[0]:
        pytest.skip("ffmpeg not available")
    directory.mkdir()
    return golden.run_suite(engine, directory, SUBSET)


def test_two_runs_in_different_directories_record_identical_json(tmp_path: Path) -> None:
    first = golden.render_json(_record(tmp_path / "one"))
    second = golden.render_json(_record(tmp_path / "two"))

    assert first == second
    assert golden.compare_texts(first, second) == ""


def test_the_record_is_independent_of_the_directory_and_the_binary_paths(tmp_path: Path) -> None:
    text = golden.render_json(_record(tmp_path / "work"))
    record = json.loads(text)
    engine = FFmpegEngine()

    assert str(tmp_path) not in text
    assert engine.ffmpeg not in text
    assert "owner" not in record
    steps = record["steps"]
    assert {"probe", "export_wav", "export_mp3", "export_flac"} <= set(steps)
    probe = steps["probe"]["calls"][0]
    assert probe["argv"][0] == "<ffprobe>"
    assert probe["kind"] == "run"
    assert probe["kwargs"] == {
        "capture_output": "True",
        "check": "True",
        "text": "True",
        "timeout": "120.0",
    }
    export = steps["export_mp3"]["calls"][0]
    assert export["argv"][0] == "<ffmpeg>"
    assert export["argv"][-1] == "<work>/export.mp3"
    assert export["kwargs"] == {"capture_output": "True", "check": "True"}
    assert len(steps["export_mp3"]["outputs"]["export.mp3"]) == 64


def test_the_full_suite_drives_the_surface_and_records_a_spawn_for_each_step(
    tmp_path: Path,
) -> None:
    steps = _record_all(tmp_path / "all")["steps"]

    assert {
        "resample_streams",
        "stream_mono_f32",
        "render_dialogue_track",
        "render_stacked_showwavespic",
        "annotate_time_marks",
        "peak_trim_db",
        "audio_start_sec",
        "check_ffprobe_version",
        "supports_encode",
        "check_available",
        "export_cancelled",
    } <= set(steps)
    assert not [name for name, step in steps.items() if not step["calls"]]
    assert steps["export_cancelled"]["result"]["raised"] == "CancelledProgress"
    assert {call["kind"] for step in steps.values() for call in step["calls"]} == {"run", "popen"}


def test_compare_exits_one_on_a_difference_and_zero_on_none(tmp_path: Path, capsys) -> None:
    record = golden.run_suite(FFmpegEngine(), _fresh(tmp_path, "a"), ("probe",))
    left = tmp_path / "left.json"
    right = tmp_path / "right.json"
    left.write_text(golden.render_json(record), encoding="utf-8")
    right.write_text(golden.render_json(record), encoding="utf-8")
    assert golden.main(["--compare", str(left), str(right)]) == 0
    assert capsys.readouterr().out == ""

    changed = json.loads(right.read_text(encoding="utf-8"))
    changed["steps"]["probe"]["calls"][0]["argv"].append("-extra")
    right.write_text(golden.render_json(changed), encoding="utf-8")
    assert golden.main(["--compare", str(left), str(right)]) == 1
    assert any(
        line.startswith("+") and line.strip("+ ") == '"-extra"'
        for line in capsys.readouterr().out.splitlines()
    )


def test_the_recorder_catches_every_binding_of_run_and_popen(monkeypatch) -> None:
    sibling = types.ModuleType("podcast_mcp._golden_sibling")
    sibling.run = process.run  # type: ignore[attr-defined]
    sibling.popen = process.popen  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, sibling.__name__, sibling)
    recorder = golden.SpawnRecorder()
    original = (process.run, process.popen)

    with recorder.recording():
        sibling.run([sys.executable, "-c", "pass"], check=True, input=b"abc", timeout=5)  # type: ignore[attr-defined]
        sibling.popen([sys.executable, "-c", "pass"]).wait()  # type: ignore[attr-defined]
        process.run([sys.executable, "-c", "pass"])

    assert (process.run, process.popen) == original
    assert (sibling.run, sibling.popen) == original  # type: ignore[attr-defined]
    calls = recorder.take()
    assert [call["kind"] for call in calls] == ["run", "popen", "run"]
    assert calls[0]["kwargs"] == {"check": "True", "input": "<bytes len=3>", "timeout": "5"}
    assert calls[1]["kwargs"] == {}


def test_a_keyword_value_is_described_without_an_address() -> None:
    assert golden.describe(lambda: None) is None
    assert golden.describe(-1) == "-1"
    assert golden.describe(None) == "None"
    assert golden.describe(Path("/x")) == "'/x'"
    assert golden.describe(object()) == "<object>"


def _record_all(directory: Path) -> dict:
    engine = FFmpegEngine()
    if not engine.check_available()[0]:
        pytest.skip("ffmpeg not available")
    directory.mkdir()
    return golden.run_suite(engine, directory)


def _fresh(tmp_path: Path, name: str) -> Path:
    directory = tmp_path / name
    directory.mkdir()
    return directory
