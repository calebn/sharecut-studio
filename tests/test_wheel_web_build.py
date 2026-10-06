"""hatch_build.py ships gui/web/dist in wheels only when the web build exists (#1085)."""

from __future__ import annotations

import shutil
import tarfile
import zipfile
from pathlib import Path

from hatchling.builders.sdist import SdistBuilder
from hatchling.builders.wheel import WheelBuilder

import podcast_mcp
from podcast_mcp.gui.static_assets import packaged_gui_dist

_ROOT = Path(__file__).resolve().parents[1]


def _source_tree(root: Path, *, web_build: bool) -> Path:
    """A minimal checkout built with the real pyproject.toml and hatch_build.py."""
    root.mkdir()
    for name in ("pyproject.toml", "hatch_build.py"):
        shutil.copy(_ROOT / name, root / name)
    (root / "README.md").write_text("readme\n", encoding="utf-8")
    for package in ("podcast_mcp", "podcast_mcp/gui", "podcast_relay"):
        (root / "src" / package).mkdir(parents=True, exist_ok=True)
        (root / "src" / package / "__init__.py").write_text("", encoding="utf-8")
    (root / "src/podcast_mcp/util").mkdir()
    (root / "src/podcast_mcp/util/bootstrap-assets.json").write_text("{}", encoding="utf-8")
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
    names = _wheel_names(unpacked, tmp_path / "out")
    assert "podcast_mcp/gui/web_dist/index.html" in names


def test_editable_install_does_not_snapshot_web_build(tmp_path: Path) -> None:
    root = _source_tree(tmp_path / "src-tree", web_build=True)
    names = _wheel_names(root, tmp_path / "out", version="editable")
    assert "_editable_impl_podcast_mcp.pth" in names
    assert not [name for name in names if "web_dist" in name]
