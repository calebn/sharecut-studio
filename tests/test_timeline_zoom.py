from __future__ import annotations

import pytest

from podcast_mcp.util import timeline_zoom
from podcast_mcp.util.timeline_zoom import (
    base_samples_per_bin,
    bins_per_data_tile,
    level_factor,
    load_timeline_zoom,
    max_tiles_per_request,
    max_zoom_px_per_sec,
    min_zoom_px_per_sec,
    paint_dpr_cap,
    pcm_block_frames,
    waveform_format_version,
    zoom_step,
)


def test_load_timeline_zoom_contract():
    data = load_timeline_zoom()
    assert data["min_zoom_px_per_sec"] == 0.05
    assert data["max_zoom_px_per_sec"] == 200
    assert data["max_content_px"] == 15000000
    assert data["zoom_step"] == 1.25
    assert "peaks" not in data  # the legacy overview block is gone


def test_zoom_getters():
    assert min_zoom_px_per_sec() == 0.05
    assert max_zoom_px_per_sec() == 200
    assert zoom_step() == 1.25
    assert paint_dpr_cap() == 2


def test_packaged_timeline_zoom_matches_contract():
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    contract = (root / "contracts" / "timeline-zoom.json").read_text(encoding="utf-8")
    bundled = (root / "src" / "podcast_mcp" / "util" / "timeline-zoom.json").read_text(
        encoding="utf-8"
    )
    assert contract == bundled


def test_waveform_contract_keys():
    waveform = load_timeline_zoom()["waveform"]
    assert waveform == {
        "format_version": 1,
        "base_samples_per_bin": 64,
        "level_factor": 4,
        "bins_per_data_tile": 4096,
        "max_tiles_per_request": 16,
        "pcm_block_frames": 65536,
        "render_tile_css_px": 512,
        "overscan_css_px": 512,
        "paint_dpr_cap": 2,
        "min_clip_css_px": 6,
        "line_mode_max_samples_per_px": 4,
        "quiet_amp": 0.04,
        "quiet_min_duration_sec": 0.12,
        "quiet_wash_min_zoom_px_per_sec": 8,
    }


def test_waveform_getters():
    assert waveform_format_version() == 1
    assert base_samples_per_bin() == 64
    assert level_factor() == 4
    assert bins_per_data_tile() == 4096
    assert max_tiles_per_request() == 16
    assert pcm_block_frames() == 65536
    for getter in (
        waveform_format_version,
        base_samples_per_bin,
        level_factor,
        bins_per_data_tile,
        max_tiles_per_request,
        pcm_block_frames,
    ):
        assert isinstance(getter(), int)


def test_waveform_getters_require_waveform_object(monkeypatch):
    monkeypatch.setattr(timeline_zoom, "load_timeline_zoom", lambda: {"peaks": {}})
    with pytest.raises(ValueError, match="waveform"):
        base_samples_per_bin()
