from __future__ import annotations

import pytest

from podcast_mcp.edits.edit_impact import ImpactKind, record_impact
from podcast_mcp.models import AppliedEditRecord


def _record(
    *,
    tracks=("host",),
    start=1.0,
    end=3.0,
    operation="approve_edits",
    **params,
) -> AppliedEditRecord:
    return AppliedEditRecord(
        id="alog_x",
        applied_at="2026-01-01T00:00:00Z",
        operation=operation,
        track_ids=list(tracks),
        timeline_start=start,
        timeline_end=end,
        params=params,
    )


def _impact(record: AppliedEditRecord):
    impact = record_impact(record)
    assert impact is not None
    return impact


def test_padded_cut_net_is_span_minus_pad():
    impact = _impact(_record(replace_gap_sec=0.4, loss_sec=1.6))
    assert impact.kind is ImpactKind.CUT
    assert impact.span_sec == pytest.approx(2.0)
    assert impact.pad_sec == pytest.approx(0.4)
    assert impact.net_sec == pytest.approx(1.6)
    assert impact.net_track_sec("host") == pytest.approx(1.6)


@pytest.mark.parametrize("params", [{"replace_gap_sec": None}, {}])
def test_unpadded_cut_net_equals_span(params):
    impact = _impact(_record(**params))
    assert impact.pad_sec == 0.0
    assert impact.net_sec == pytest.approx(2.0)


def test_pad_larger_than_span_clamps_net_at_zero():
    impact = _impact(_record(replace_gap_sec=2.5))
    assert impact.net_sec == 0.0
    assert impact.net_track_sec("host") == 0.0


def test_two_track_cut_subtracts_pad_once_per_track_and_once_for_union():
    impact = _impact(
        _record(
            tracks=("host", "guest"),
            replace_gap_sec=0.4,
            cut_spans={"host": [(1.0, 3.0)], "guest": [(1.0, 3.0)]},
        )
    )
    assert impact.span_sec == pytest.approx(2.0)
    assert impact.net_sec == pytest.approx(1.6)
    assert impact.net_track_sec("host") == pytest.approx(1.6)
    assert impact.net_track_sec("guest") == pytest.approx(1.6)


def test_multi_span_cut_subtracts_pad_once_per_record():
    impact = _impact(_record(replace_gap_sec=0.4, cut_spans={"host": [(1.0, 2.0), (5.0, 6.0)]}))
    assert impact.span_sec == pytest.approx(2.0)
    assert impact.net_sec == pytest.approx(1.6)
    assert impact.net_track_sec("host") == pytest.approx(1.6)


def test_mute_has_no_pad_and_no_net_shortening():
    impact = _impact(_record(mute=True, replace_gap_sec=0.4))
    assert impact.kind is ImpactKind.MUTE
    assert impact.pad_sec == 0.0
    assert impact.net_sec == 0.0


def test_exact_range_and_track_scope_open_no_pad():
    exact = _impact(
        _record(
            replace_gap_sec=0.4,
            exact_range={"track_ids": ["host"], "intervals": [{"start": 1.0, "end": 3.0}]},
        )
    )
    assert exact.pad_sec == 0.0
    assert exact.net_sec == pytest.approx(2.0)
    track = _impact(_record(replace_gap_sec=0.4, scope="track"))
    assert track.pad_sec == 0.0
    assert track.net_sec == pytest.approx(2.0)
