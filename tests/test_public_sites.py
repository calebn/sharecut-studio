"""Shared brand assets remain synchronized with the local product surfaces."""

import json
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


def test_home_screen_icon_keeps_the_brand_mark() -> None:
    """The full-bleed Home Screen icon draws the same mark as the app icon."""

    def mark(path: Path) -> list[str]:
        lines = path.read_text(encoding="utf-8").splitlines()
        return [line.strip() for line in lines if line.strip().startswith(("<path", "<circle"))]

    source = mark(ROOT / "gui/desktop/src-tauri/app-icon.svg")
    assert source
    assert mark(ROOT / "gui/web/public/assets/app/icon.svg") == source
