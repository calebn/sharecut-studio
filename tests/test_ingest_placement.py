from __future__ import annotations

from podcast_mcp.edits.ingest_placement import SourceGeometry, place_ingest_sources


def _geo(p):
    return [(g.source_start, g.source_end, g.timeline_start) for g in p.geometry]


def test_lead_in_trims_primary() -> None:
    p = place_ingest_sources("G", [10.0], placement_sec=-4.0)
    assert _geo(p) == [(4.0, 10.0, 0.0)] and p.warnings == []


def test_late_start_delays_primary() -> None:
    assert _geo(place_ingest_sources("G", [10.0], placement_sec=2.0)) == [(0.0, 10.0, 2.0)]


def test_trimmed_extracts_chain_sequentially() -> None:
    p = place_ingest_sources("G", [10.0, 5.0], placement_sec=None)
    assert _geo(p) == [(0.0, 10.0, 0.0), (0.0, 5.0, 10.0)] and p.warnings == []


def test_zero_duration_is_not_placed() -> None:
    assert _geo(place_ingest_sources("G", [0.0], placement_sec=-4.0)) == [(0.0, 0.0, 0.0)]


def test_geometry_type() -> None:
    assert place_ingest_sources("G", [1.0], placement_sec=0.0).geometry == [
        SourceGeometry(0.0, 1.0, 0.0)
    ]


def test_lead_past_primary_end_skips_placement_and_warns() -> None:
    p = place_ingest_sources("Guest", [10.0], placement_sec=-12.0)
    assert _geo(p) == [(0.0, 10.0, 0.0)]
    assert len(p.warnings) == 1 and "trims past the end" in p.warnings[0]


def test_skipped_placement_chains_extras_after_full_primary() -> None:
    p = place_ingest_sources("Guest", [10.0, 5.0], placement_sec=-12.0)
    assert _geo(p) == [(0.0, 10.0, 0.0), (0.0, 5.0, 10.0)]


def test_multi_source_with_placement_warns() -> None:
    p = place_ingest_sources("Guest", [10.0, 5.0], placement_sec=-4.0)
    assert _geo(p) == [(4.0, 10.0, 0.0), (0.0, 5.0, 6.0)]
    assert any("extra source(s)" in w for w in p.warnings)


def test_multi_source_without_placement_is_quiet() -> None:
    assert place_ingest_sources("Guest", [10.0, 5.0], placement_sec=0.0).warnings == []
