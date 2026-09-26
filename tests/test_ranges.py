from podcast_mcp.edits.ranges import clamp_spans


def test_clamp_spans_keeps_overlap_and_drops_empty() -> None:
    spans = [(0.0, 2.0), (3.0, 4.0), (9.0, 12.0), (5.0, 5.0)]
    assert clamp_spans(spans, 1.0, 10.0) == [(1.0, 2.0), (3.0, 4.0), (9.0, 10.0)]
    assert clamp_spans([(0.0, 1.0)], 1.0, 2.0) == []
