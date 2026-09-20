"""Shared brand assets remain synchronized with the local product surfaces."""

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
