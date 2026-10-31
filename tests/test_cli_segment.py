"""``podcast segment``, through the real CLI."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.models import Clip, EpisodeProject, Track, save_project
from podcast_mcp.models.episode import MediaAsset

runner = CliRunner()


@pytest.fixture
def project(tmp_workspace: Path, sample_wav: Path) -> Path:
    raw = tmp_workspace / "raw"
    raw.mkdir()
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    episode = EpisodeProject.create("episode", str(tmp_workspace))
    episode.ensure_dirs()
    episode.tracks = [Track(id="host", label="Host", media=MediaAsset(path="raw/host.wav"))]
    episode.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=1.0, timeline_start=2.0),
        Clip(id="c2", track_id="host", source_start=1.0, source_end=2.0, timeline_start=4.0),
    ]
    return save_project(episode)


@pytest.fixture(autouse=True)
def _config_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    config = tmp_path / "cli-config"
    monkeypatch.setenv("PODCAST_CONFIG_DIR", str(config))
    return config


def _save(project: Path, *extra: str) -> object:
    return runner.invoke(
        app, ["segment", "save", "-p", str(project), "--name", "Warm Intro", *extra]
    )


def test_save_by_clips_then_list_and_show(project: Path, _config_dir: Path) -> None:
    saved = _save(project, "--clips", "c1,c2")
    assert saved.exit_code == 0, saved.output
    assert "Saved warm-intro-" in saved.stdout
    assert (_config_dir / "segments").is_dir()

    listed = runner.invoke(app, ["segment", "list"])
    assert listed.exit_code == 0
    assert "intro" in listed.stdout and "Warm Intro" in listed.stdout

    rows = json.loads(runner.invoke(app, ["segment", "list", "--json"]).stdout)
    assert len(rows) == 1 and rows[0]["versions"] == [1]
    segment_id = rows[0]["id"]

    shown = runner.invoke(app, ["segment", "show", segment_id])
    assert shown.exit_code == 0
    assert "lane 0" in shown.stdout and "versions: v1" in shown.stdout
    detail = json.loads(runner.invoke(app, ["segment", "show", segment_id, "--json"]).stdout)
    assert detail["clips"][1]["offset_sec"] == 2.0


def test_save_by_range_and_kind_as_json(project: Path) -> None:
    result = _save(project, "--range", "0:00-0:05", "--kind", "sponsor", "--json")
    assert result.exit_code == 0, result.output
    payload = json.loads(result.stdout)
    assert payload["status"] == "added" and payload["version"] == 1
    shown = json.loads(runner.invoke(app, ["segment", "show", payload["id"], "--json"]).stdout)
    assert shown["kind"] == "sponsor"


def test_saving_the_same_thing_twice_says_so(project: Path) -> None:
    _save(project, "--clips", "c1")
    again = _save(project, "--clips", "c1")
    assert again.exit_code == 0
    assert "Already in the library" in again.stdout


def test_export_then_import_into_an_empty_library(
    project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    segment_id = json.loads(_save(project, "--clips", "c1", "--json").stdout)["id"]
    out = tmp_path / "warm.sharecutseg"

    exported = runner.invoke(app, ["segment", "export", segment_id, "-o", str(out)])
    assert exported.exit_code == 0 and out.is_file()

    monkeypatch.setenv("PODCAST_CONFIG_DIR", str(tmp_path / "other-config"))
    imported = runner.invoke(app, ["segment", "import", str(out), "--json"])
    assert imported.exit_code == 0, imported.output
    assert json.loads(imported.stdout) == {"status": "added", "id": segment_id, "version": 1}
    again = runner.invoke(app, ["segment", "import", str(out)])
    assert "Already in the library" in again.stdout


def test_an_empty_library_says_how_to_start() -> None:
    result = runner.invoke(app, ["segment", "list"])
    assert result.exit_code == 0
    assert "podcast segment save" in result.stdout
    assert json.loads(runner.invoke(app, ["segment", "list", "--json"]).stdout) == []


@pytest.mark.parametrize(
    ("arguments", "code"),
    [
        (["--kind", "jingle", "--clips", "c1"], "segment_kind_invalid"),
        (["--clips", "nope"], "segment_clip_unknown"),
        (["--range", "banana"], "segment_range_invalid"),
        ([], "segment_selection_invalid"),
    ],
)
def test_save_errors_carry_a_code(project: Path, arguments: list[str], code: str) -> None:
    result = _save(project, *arguments)
    assert result.exit_code == 1
    assert f"(code {code})" in result.output


def test_show_export_and_import_errors(tmp_path: Path) -> None:
    shown = runner.invoke(app, ["segment", "show", "nope"])
    assert shown.exit_code == 1 and "(code segment_unknown)" in shown.output
    exported = runner.invoke(app, ["segment", "export", "nope", "-o", str(tmp_path / "x")])
    assert exported.exit_code == 1 and "(code segment_unknown)" in exported.output
    bad = tmp_path / "bad.sharecutseg"
    bad.write_text("nope")
    imported = runner.invoke(app, ["segment", "import", str(bad)])
    assert imported.exit_code == 1 and "(code segment_bundle_invalid)" in imported.output
