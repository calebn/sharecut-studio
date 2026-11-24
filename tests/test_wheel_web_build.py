"""hatch_build.py ships gui/web/dist in wheels only when the web build exists (#1085)."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

import pytest
from hatchling.builders.sdist import SdistBuilder
from hatchling.builders.wheel import WheelBuilder

import podcast_mcp
from podcast_mcp.gui.static_assets import packaged_gui_dist

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "scripts"))

import check_wheel_web_build as check  # noqa: E402

_GOOD_ENTRY_POINTS = (
    "[console_scripts]\npodcast = podcast_mcp.cli.main:app\n\n"
    "[podcast_mcp.extensions]\ncollaboration = podcast_mcp.extensions.collaboration:create\n"
)


def _source_tree(root: Path, *, web_build: bool) -> Path:
    """A minimal checkout built with the real pyproject.toml and hatch_build.py."""
    root.mkdir()
    for name in ("pyproject.toml", "hatch_build.py"):
        shutil.copy(_ROOT / name, root / name)
    (root / "README.md").write_text("readme\n", encoding="utf-8")
    shutil.copytree(_ROOT / "contracts", root / "contracts")
    shutil.copytree(_ROOT / ".agents/defaults", root / ".agents/defaults")
    skill = root / ".agents/skills/demo/SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("skill\n", encoding="utf-8")
    for package in ("podcast_mcp", "podcast_mcp/gui", "podcast_relay"):
        (root / "src" / package).mkdir(parents=True, exist_ok=True)
        (root / "src" / package / "__init__.py").write_text("", encoding="utf-8")
    if web_build:
        assets = root / "gui/web/dist/assets"
        assets.mkdir(parents=True)
        (root / "gui/web/dist/index.html").write_text("<html>app</html>", encoding="utf-8")
        (assets / "index-abc123.js").write_text("app()", encoding="utf-8")
    return root


def _wheel_names(root: Path, out: Path, version: str = "standard") -> set[str]:
    wheel = next(WheelBuilder(str(root)).build(directory=str(out), versions=[version]))
    with zipfile.ZipFile(wheel) as archive:
        return set(archive.namelist())


def test_wheel_ships_web_build_where_the_server_looks(tmp_path: Path) -> None:
    root = _source_tree(tmp_path / "src-tree", web_build=True)
    names = _wheel_names(root, tmp_path / "out")
    shipped = {
        f"podcast_mcp/contracts/{path.name}" for path in (_ROOT / "contracts").glob("*.json")
    }
    assert shipped <= names
    assert {
        "podcast_mcp/defaults/pipeline.yaml",
        "podcast_mcp/defaults/transcript_glossary.yaml",
    } <= names
    assert not [
        name for name in names if name.startswith("podcast_mcp/util/") and name.endswith(".json")
    ]
    assert "podcast_mcp/gui/web_dist/index.html" in names
    assert "podcast_mcp/gui/web_dist/assets/index-abc123.js" in names
    site_packages = Path(podcast_mcp.__file__).resolve().parents[1]
    assert packaged_gui_dist() == site_packages / "podcast_mcp/gui/web_dist"


def test_wheel_builds_without_web_build(tmp_path: Path) -> None:
    root = _source_tree(tmp_path / "src-tree", web_build=False)
    names = _wheel_names(root, tmp_path / "out")
    assert "podcast_mcp/__init__.py" in names
    assert not [name for name in names if "web_dist" in name]


def test_wheel_built_from_sdist_keeps_web_build(tmp_path: Path) -> None:
    root = _source_tree(tmp_path / "src-tree", web_build=True)
    sdist = next(SdistBuilder(str(root)).build(directory=str(tmp_path / "sdist")))
    with tarfile.open(sdist) as archive:
        archive.extractall(tmp_path / "unpacked", filter="data")
    (unpacked,) = (tmp_path / "unpacked").iterdir()
    assert (unpacked / "gui/web/dist/index.html").is_file()
    assert (unpacked / "contracts/ffmpeg-build.json").read_bytes() == (
        _ROOT / "contracts/ffmpeg-build.json"
    ).read_bytes()
    names = _wheel_names(unpacked, tmp_path / "out")
    assert "podcast_mcp/gui/web_dist/index.html" in names


def test_editable_install_does_not_snapshot_web_build(tmp_path: Path) -> None:
    root = _source_tree(tmp_path / "src-tree", web_build=True)
    names = _wheel_names(root, tmp_path / "out", version="editable")
    assert "_editable_impl_podcast_mcp.pth" in names
    assert not [name for name in names if "web_dist" in name]


def test_sdist_excludes_installed_frontend_dependencies(tmp_path):
    root = _source_tree(tmp_path / "src-tree", web_build=True)
    shutil.copy(_ROOT / ".gitignore", root / ".gitignore")
    dependency = root / "gui/web/node_modules/demo/a.js"
    dependency.parent.mkdir(parents=True)
    dependency.write_text("generated dependency\n")
    os.link(dependency, dependency.with_name("b.js"))
    sdist = next(SdistBuilder(str(root)).build(directory=str(tmp_path / "sdist")))
    with tarfile.open(sdist) as archive:
        members = archive.getmembers()
    assert not [member.name for member in members if "/node_modules/" in member.name]
    assert not [member.name for member in members if member.islnk()]
    assert any(member.name.endswith("/gui/web/dist/index.html") for member in members)


def test_agent_skills_stay_out_of_the_wheel_and_sdist(tmp_path: Path) -> None:
    root = _source_tree(tmp_path / "src-tree", web_build=False)
    sdist = next(SdistBuilder(str(root)).build(directory=str(tmp_path / "sdist")))
    with tarfile.open(sdist) as archive:
        sdist_names = {member.name.split("/", 1)[1] for member in archive.getmembers()}
    assert ".agents/defaults/pipeline.yaml" in sdist_names
    assert not [name for name in sdist_names if name.startswith(".agents/skills")]
    wheel_names = _wheel_names(root, tmp_path / "out")
    assert "podcast_mcp/defaults/pipeline.yaml" in wheel_names
    assert not [
        name for name in wheel_names if "skills" in name.split("/") or name.endswith("SKILL.md")
    ]


def test_wheel_leaves_out_the_private_provider_and_keeps_relay_static(tmp_path: Path) -> None:
    root = _source_tree(tmp_path / "src-tree", web_build=False)
    provider = root / "src/podcast_online"
    provider.mkdir()
    (provider / "__init__.py").write_text("", encoding="utf-8")
    shutil.copytree(_ROOT / "src/podcast_relay/static", root / "src/podcast_relay/static")
    names = _wheel_names(root, tmp_path / "out")
    assert not [name for name in names if name.startswith("podcast_online")]
    static = {
        f"podcast_relay/static/{path.name}"
        for path in (_ROOT / "src/podcast_relay/static").iterdir()
        if path.is_file()
    }
    assert static
    assert static <= names


def _synthetic_wheel(
    path: Path,
    *,
    extra: tuple[str, ...] = (),
    entry_points: str | None = _GOOD_ENTRY_POINTS,
    static: tuple[str, ...] = check.RELAY_STATIC,
) -> Path:
    """A zip shaped like a FOSS wheel, with the parts each boundary check reads."""
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("podcast_mcp/__init__.py", "")
        if entry_points is not None:
            archive.writestr("podcast_mcp-0.1.dist-info/entry_points.txt", entry_points)
        for name in (*static, *extra):
            archive.writestr(name, "x")
    return path


def test_wheel_boundary_passes_on_a_foss_wheel(tmp_path: Path) -> None:
    wheel = _synthetic_wheel(tmp_path / "good.whl")
    check.wheel_boundary(wheel)


def test_relay_static_list_matches_the_source_tree() -> None:
    on_disk = {
        f"podcast_relay/static/{path.name}"
        for path in (_ROOT / "src/podcast_relay/static").iterdir()
        if path.is_file()
    }
    assert set(check.RELAY_STATIC) == on_disk


@pytest.mark.parametrize(
    "entry", ["podcast_online/__init__.py", "podcast_online-0.1.dist-info/RECORD"]
)
def test_wheel_boundary_rejects_a_podcast_online_entry(tmp_path: Path, entry: str) -> None:
    wheel = _synthetic_wheel(tmp_path / "online.whl", extra=(entry,))
    with pytest.raises(SystemExit) as raised:
        check.wheel_boundary(wheel)
    assert "podcast_online" in str(raised.value)
    assert entry in str(raised.value)


@pytest.mark.parametrize(
    "entry_points",
    [
        None,
        "[console_scripts]\npodcast = podcast_mcp.cli.main:app\n",
        _GOOD_ENTRY_POINTS + "online = podcast_online.extension:create\n",
        "[podcast_mcp.extensions]\nonline = podcast_online.extension:create\n",
        "[podcast_mcp.extensions]\n",
    ],
)
def test_wheel_boundary_rejects_wrong_entry_points(
    tmp_path: Path, entry_points: str | None
) -> None:
    wheel = _synthetic_wheel(tmp_path / "ep.whl", entry_points=entry_points)
    with pytest.raises(SystemExit) as raised:
        check.wheel_boundary(wheel)
    assert "podcast_mcp.extensions" in str(raised.value) or "entry_points" in str(raised.value)


def test_wheel_boundary_rejects_missing_relay_static(tmp_path: Path) -> None:
    wheel = _synthetic_wheel(tmp_path / "static.whl", static=check.RELAY_STATIC[:-1])
    with pytest.raises(SystemExit) as raised:
        check.wheel_boundary(wheel)
    assert check.RELAY_STATIC[-1] in str(raised.value)


def _whole_release_wheel(path: Path, *, extra: tuple[str, ...] = ()) -> Path:
    """A synthetic wheel that also satisfies the web build, contracts and defaults checks."""
    wheel = _synthetic_wheel(path, extra=extra)
    with zipfile.ZipFile(wheel, "a") as archive:
        archive.writestr(f"{check.WHEEL_WEB_DIST}/index.html", '<script src="./app.js"></script>')
        archive.writestr(f"{check.WHEEL_WEB_DIST}/app.js", "app()")
        for name in check.RUNTIME_CONTRACTS:
            archive.writestr(f"{check.PACKAGED_CONTRACTS}/{name}", "{}")
        for name in check.RUNTIME_DEFAULTS:
            archive.writestr(f"{check.PACKAGED_DEFAULTS}/{name}", "")
    return wheel


def _run_script(wheel: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(_ROOT / "scripts/check_wheel_web_build.py"), str(wheel)],
        capture_output=True,
        text=True,
        check=False,
    )


def test_script_exits_zero_on_a_whole_foss_wheel(tmp_path: Path) -> None:
    result = _run_script(_whole_release_wheel(tmp_path / "ok.whl"))
    assert result.returncode == 0, result.stderr
    assert "no podcast_online" in result.stdout


def test_script_exits_non_zero_on_a_wheel_with_a_stub_podcast_online(tmp_path: Path) -> None:
    wheel = _whole_release_wheel(tmp_path / "stub.whl", extra=("podcast_online/__init__.py",))
    result = _run_script(wheel)
    assert result.returncode != 0
    assert "podcast_online/__init__.py" in result.stderr + result.stdout


def test_blocked_online_probe_starts_cli_mcp_and_gui() -> None:
    """The installed-wheel probe runs here against the checkout, as it does against the wheel."""
    result = subprocess.run(
        [sys.executable, "-c", check.BLOCK_ONLINE_PROBE],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "podcast_online blocked" in result.stdout


def test_blocked_online_probe_fails_when_the_package_is_imported() -> None:
    probe = check.BLOCK_ONLINE_PROBE.replace(
        "from podcast_mcp.cli.main import app",
        "import podcast_online\nfrom podcast_mcp.cli.main import app",
    )
    result = subprocess.run(
        [sys.executable, "-c", probe], capture_output=True, text=True, check=False
    )
    assert result.returncode != 0
