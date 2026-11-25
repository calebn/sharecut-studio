"""scripts/ffmpeg_argv_golden.py: the recorded argv and output hashes are the same on every run."""

from __future__ import annotations

import json
from pathlib import Path

from podcast_mcp.engines.ffmpeg import FFmpegEngine
from script_loader import load_script

golden = load_script("ffmpeg_argv_golden", register=True)
SUBSET = ("probe", "export")


def _record(directory: Path) -> dict:
    engine = FFmpegEngine()
    available, detail = engine.check_available()
    assert available, detail
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
    assert record["owner"] == "ffmpeg"
    steps = record["steps"]
    assert {"probe", "export_wav", "export_mp3", "export_flac"} <= set(steps)
    assert steps["probe"]["argv"][0][0] == "<ffprobe>"
    assert steps["export_mp3"]["argv"][0][0] == "<ffmpeg>"
    assert steps["export_mp3"]["argv"][0][-1] == "<work>/export.mp3"
    assert len(steps["export_mp3"]["outputs"]["export.mp3"]) == 64


def test_compare_exits_one_on_a_difference_and_zero_on_none(tmp_path: Path, capsys) -> None:
    record = golden.run_suite(FFmpegEngine(), _fresh(tmp_path, "a"), ("probe",))
    left = tmp_path / "left.json"
    right = tmp_path / "right.json"
    left.write_text(golden.render_json(record), encoding="utf-8")
    right.write_text(golden.render_json(record), encoding="utf-8")
    assert golden.main(["--compare", str(left), str(right)]) == 0
    assert capsys.readouterr().out == ""

    changed = json.loads(right.read_text(encoding="utf-8"))
    changed["steps"]["probe"]["argv"][0].append("-extra")
    right.write_text(golden.render_json(changed), encoding="utf-8")
    assert golden.main(["--compare", str(left), str(right)]) == 1
    assert '+          "-extra"' in capsys.readouterr().out


def test_the_recorder_finds_the_module_that_owns_run_and_popen() -> None:
    module = golden.owner_module()

    assert callable(module.run)
    assert callable(module.popen)
    assert module.__name__.startswith("podcast_mcp.engines.ffmpeg")


def _fresh(tmp_path: Path, name: str) -> Path:
    directory = tmp_path / name
    directory.mkdir()
    return directory
