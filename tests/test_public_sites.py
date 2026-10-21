"""Shared brand assets remain synchronized with the local product surfaces."""

import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_brand_css_copies_match_source() -> None:
    brand = ROOT / "deploy/brand"
    copies = {
        brand / "brand-tokens.css": (
            ROOT / "gui/web/src/styles/theme/brand-tokens.css",
            ROOT / "gui/web/public/brand-tokens.css",
            ROOT / "gui/desktop/splash/brand-tokens.css",
            ROOT / "src/podcast_relay/static/brand-tokens.css",
        ),
        brand / "cover-layout.css": (ROOT / "gui/web/src/styles/partials/cover-layout.css",),
    }
    for source, destinations in copies.items():
        expected = source.read_text(encoding="utf-8")
        for destination in destinations:
            assert destination.read_text(encoding="utf-8") == expected, f"{destination} != {source}"


def test_brand_mark_svg_copies_match_source() -> None:
    source = ROOT / "gui/desktop/src-tauri/app-icon.svg"
    expected = source.read_bytes()
    for destination in (
        ROOT / "gui/web/public/favicon.svg",
        ROOT / "gui/desktop/src-tauri/icons/icon.svg",
    ):
        assert destination.read_bytes() == expected, f"{destination} != {source}"


def _png_size(path: Path) -> tuple[int, int]:
    header = path.read_bytes()[:24]
    assert header[:8] == b"\x89PNG\r\n\x1a\n", f"{path} is not a PNG"
    return int.from_bytes(header[16:20], "big"), int.from_bytes(header[20:24], "big")


def test_home_screen_icons_match_the_manifest() -> None:
    """Each manifest icon exists at its declared size (#1077)."""
    app = ROOT / "gui/web/public/assets/app"
    manifest = json.loads((app / "manifest.webmanifest").read_text(encoding="utf-8"))
    assert manifest["display"] == "standalone"
    for icon in manifest["icons"]:
        path = app / icon["src"]
        assert path.is_file(), path
        if icon["type"] == "image/png":
            width, height = (int(n) for n in icon["sizes"].split("x"))
            assert _png_size(path) == (width, height), path
    assert _png_size(app / "apple-touch-icon.png") == (180, 180)


LOGO = ROOT / "deploy/brand/logo"


def _path_data(path: Path) -> list[str]:
    return re.findall(r' d="([^"]+)"', path.read_text(encoding="utf-8"))


def _git_blob_sha(path: Path) -> str:
    data = path.read_bytes()
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def test_vendored_logo_masters_match_their_recorded_provenance() -> None:
    """The lockup SVGs are the approved masters, byte for byte (#1923)."""
    provenance = (LOGO / "PROVENANCE.md").read_text(encoding="utf-8")
    for name in ("logo-dark.svg", "logo-light.svg"):
        assert _git_blob_sha(LOGO / name) in provenance, name


def test_every_icon_and_the_splash_draw_the_master_symbol() -> None:
    """The app icons and the splash reuse the master's symbol paths without redrawing them."""
    symbol = _path_data(LOGO / "logo-dark.svg")[:4]
    assert len(symbol) == 4
    for path in (
        ROOT / "gui/desktop/src-tauri/app-icon.svg",
        ROOT / "gui/desktop/src-tauri/app-icon-macos.svg",
        ROOT / "gui/web/public/assets/app/icon.svg",
        LOGO / "symbol-dark.svg",
        LOGO / "symbol-light.svg",
        LOGO / "symbol-mono.svg",
        ROOT / "gui/desktop/splash/index.html",
    ):
        assert _path_data(path) == symbol, path
    assert _path_data(LOGO / "logo-light.svg")[:4] == symbol


def test_derived_brand_assets_are_current() -> None:
    """`scripts/build_brand_assets.py` has been rerun after any master or icon change."""
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts/build_brand_assets.py"), "--check"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
