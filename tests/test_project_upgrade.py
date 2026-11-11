from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.models import load_project
from podcast_mcp.models.project_format import SUPPORTED_PROJECT_VERSION
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.project.upgrade import upgrade_workspace
from podcast_mcp.util.coded_error import CodedValueError
from script_loader import load_script

compat = load_script("project_compat", register=True)
ROOT = Path(__file__).resolve().parents[1]
DEVELOPMENT = ROOT / compat.CORPUS / "development"
PROJECT = compat.PROJECT


@pytest.fixture(autouse=True)
def _dispatcher_grant():
    with write_grant(WriteGrantKind.DISPATCHER):
        yield


def synthetic_old(tmp_path: Path, version: str = "2.0") -> Path:
    source = tmp_path / "old"
    shutil.copytree(DEVELOPMENT, source)
    document = json.loads((source / PROJECT).read_text(encoding="utf-8"))
    document["version"] = version
    (source / PROJECT).write_text(json.dumps(document, indent=2), encoding="utf-8")
    return source


def test_the_project_version_is_2_1_everywhere() -> None:
    schema = json.loads((ROOT / "schemas/episode.project.schema.json").read_text(encoding="utf-8"))
    assert SUPPORTED_PROJECT_VERSION == "2.1"
    assert schema["properties"]["version"]["const"] == "2.1"
    fields = schema["$defs"]["TimelineSection"]["properties"]["join_fade_max_ms"]
    assert (fields["minimum"], fields["maximum"]) == (0, 200)
    assert load_project(DEVELOPMENT / PROJECT).version == "2.1"


def test_ordinary_loading_rejects_the_old_version_and_names_the_upgrade(tmp_path: Path) -> None:
    source = synthetic_old(tmp_path)
    with pytest.raises(ValueError, match=r"Unsupported project file version '2\.0'") as refusal:
        load_project(source / PROJECT)
    assert "episode upgrade" in str(refusal.value)


def test_the_cli_upgrades_a_2_0_workspace_and_leaves_the_source_alone(tmp_path: Path) -> None:
    source = synthetic_old(tmp_path)
    before = compat.inventory(source)
    output = tmp_path / "new" / "workspace"
    result = CliRunner().invoke(
        app,
        [
            "--no-progress",
            "episode",
            "upgrade",
            "--project",
            str(source / PROJECT),
            "--output",
            str(output),
        ],
    )
    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == {
        "project": str(output.resolve() / PROJECT),
        "from_version": "2.0",
        "to_version": "2.1",
    }
    assert compat.inventory(source, ignore_locks=True) == before

    upgraded = load_project(output / PROJECT)
    current = load_project(DEVELOPMENT / PROJECT)
    assert upgraded.version == "2.1"
    assert upgraded.timeline.join_fade_max_ms is None
    assert (
        "join_fade_max_ms"
        not in json.loads((output / PROJECT).read_text(encoding="utf-8"))["timeline"]
    )
    assert upgraded.model_dump(exclude={"meta"}) == current.model_dump(exclude={"meta"})
    for name in ("raw", "history"):
        assert compat.inventory(output / name) == compat.inventory(source / name)
    compat.assert_workspace(output / PROJECT)


def test_the_guard_accepts_the_upgrade_for_an_unsupported_released_fixture(tmp_path: Path) -> None:
    compat.assert_upgrade(synthetic_old(tmp_path))


def test_an_upgrade_rewrites_the_version_and_adds_no_value(tmp_path: Path) -> None:
    source = synthetic_old(tmp_path)
    output = tmp_path / "out"
    upgrade_workspace(source / PROJECT, output)
    written = json.loads((output / PROJECT).read_text(encoding="utf-8"))
    assert written["version"] == "2.1"
    assert "join_fade_max_ms" not in written["timeline"]
    assert json.loads((source / PROJECT).read_text(encoding="utf-8"))["version"] == "2.0"
    assert load_project(output / PROJECT).timeline.join_fade_max_ms is None


def test_the_source_is_read_and_copied_under_the_project_commit_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from contextlib import contextmanager

    from podcast_mcp.project import upgrade

    source = synthetic_old(tmp_path)
    events: list[str] = []

    @contextmanager
    def lock(_project):
        events.append("lock")
        yield
        events.append("unlock")

    read, copy = upgrade._read_document, upgrade.shutil.copytree

    def spy_read(path):
        events.append("read")
        return read(path)

    def spy_copy(*args, **kwargs):
        events.append("copy")
        return copy(*args, **kwargs)

    monkeypatch.setattr(upgrade, "project_commit_lock", lock)
    monkeypatch.setattr(upgrade, "_read_document", spy_read)
    monkeypatch.setattr(upgrade.shutil, "copytree", spy_copy)
    upgrade_workspace(source / PROJECT, tmp_path / "out")
    assert events[:2] == ["lock", "read"]
    assert events[-1] == "unlock"
    assert set(events[2:-1]) == {"copy"}
    assert not list((tmp_path / "out").rglob("*.lock"))


@pytest.mark.parametrize(
    ("version", "code"),
    [("2.1", "upgrade_not_needed"), ("1.0", "upgrade_unsupported_version")],
)
def test_versions_that_cannot_be_upgraded_publish_nothing(tmp_path: Path, version, code) -> None:
    source = synthetic_old(tmp_path, version)
    output = tmp_path / "out"
    with pytest.raises(CodedValueError) as refusal:
        upgrade_workspace(source / PROJECT, output)
    assert refusal.value.code == code
    assert not output.exists()
    assert [p.name for p in tmp_path.iterdir()] == ["old"]


def test_the_output_must_be_new_and_outside_the_source(tmp_path: Path) -> None:
    source = synthetic_old(tmp_path)
    existing = tmp_path / "exists"
    existing.mkdir()
    for bad in (existing, source / "inside", tmp_path):
        with pytest.raises(CodedValueError) as refusal:
            upgrade_workspace(source / PROJECT, bad)
        assert refusal.value.code == "upgrade_output_invalid"


def test_the_source_must_be_a_project_file(tmp_path: Path) -> None:
    (tmp_path / "other.json").write_text("{}", encoding="utf-8")
    with pytest.raises(CodedValueError) as wrong_name:
        upgrade_workspace(tmp_path / "other.json", tmp_path / "out")
    assert wrong_name.value.code == "upgrade_source_invalid"
    broken = tmp_path / "broken"
    broken.mkdir()
    (broken / PROJECT).write_text("not json", encoding="utf-8")
    with pytest.raises(CodedValueError) as unreadable:
        upgrade_workspace(broken / PROJECT, tmp_path / "out")
    assert unreadable.value.code == "upgrade_source_invalid"
