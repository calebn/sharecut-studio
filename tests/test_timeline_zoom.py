from __future__ import annotations

from podcast_mcp.util.timeline_zoom import (
    detail_bins_per_sec,
    edit_focus_bins_per_sec,
    finest_bins_per_sec,
    load_timeline_zoom,
    max_zoom_px_per_sec,
    overview_bins_per_sec,
    overview_decode_hz,
    overview_samples_per_pixel,
    paint_dpr_cap,
    zoom_step,
)


def test_load_timeline_zoom_contract():
    data = load_timeline_zoom()
    assert data["min_zoom_px_per_sec"] == 0.05
    assert data["max_zoom_px_per_sec"] == 200
    assert data["zoom_step"] == 1.25
    peaks = data["peaks"]
    assert peaks["overview_bins_per_sec"] == 16
    assert peaks["overview_decode_hz"] == 8000
    assert peaks["dpr_headroom"] == 2


def test_derived_rates_are_not_magic_400():
    finest = finest_bins_per_sec()
    assert finest == max_zoom_px_per_sec() * 2
    assert finest == max_zoom_px_per_sec() * load_timeline_zoom()["peaks"]["dpr_headroom"]
    spp = overview_samples_per_pixel()
    assert spp == overview_decode_hz() // int(overview_bins_per_sec())
    assert spp == 500


def test_detail_and_edit_focus_caps():
    assert paint_dpr_cap() == 2
    assert detail_bins_per_sec(200, 3) == finest_bins_per_sec()
    assert detail_bins_per_sec(40, 1) == 40
    loupe = edit_focus_bins_per_sec(200, 2)
    assert loupe <= overview_decode_hz()
    assert loupe >= detail_bins_per_sec(200, 2)
    assert zoom_step() == 1.25
    assert detail_bins_per_sec(40, 0.5) == detail_bins_per_sec(40, 1.0)


def test_packaged_timeline_zoom_matches_contract():
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    contract = (root / "contracts" / "timeline-zoom.json").read_text(encoding="utf-8")
    bundled = (root / "src" / "podcast_mcp" / "util" / "timeline-zoom.json").read_text(
        encoding="utf-8"
    )
    assert contract == bundled
