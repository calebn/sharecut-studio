from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum
from typing import Any

from podcast_mcp.models import AppliedEditRecord
from podcast_mcp.util.intervals import merge_intervals


class ImpactKind(Enum):
    CUT = "cut"
    MUTE = "mute"


Spans = dict[str, list[tuple[float, float]]]


@dataclass(frozen=True)
class RecordImpact:
    """What one ``editorial.edit_log`` record did to the audio, per track."""

    kind: ImpactKind
    spans_by_track: Spans

    @property
    def span_sec(self) -> float:
        """Span length with overlaps across tracks counted once (a session ripple is one cut)."""
        return _spans_sec([s for spans in self.spans_by_track.values() for s in spans])

    def track_sec(self, track_id: str) -> float:
        return _spans_sec(self.spans_by_track[track_id])


def _spans_sec(spans: list[tuple[float, float]]) -> float:
    return sum(end - start for start, end in merge_intervals(spans))


def _decision_kind(record: AppliedEditRecord) -> ImpactKind:
    params = record.params
    if params.get("mute") is True or params.get("action") == "mute":
        return ImpactKind.MUTE
    return ImpactKind.CUT


def _always_cut(_record: AppliedEditRecord) -> ImpactKind:
    return ImpactKind.CUT


# Operations that change what is audible, keyed by ``AppliedEditRecord.operation``.
# Anything absent (splits, trims, moves, join rolls, gaps) is structural, not impact.
_IMPACT_KIND: dict[str, Callable[[AppliedEditRecord], ImpactKind]] = {
    "approve_edits": _decision_kind,
    "apply_prefix_edits": _decision_kind,
    "edit_selected_range": _decision_kind,
    "ripple_delete": _always_cut,
    "punch_delete": _always_cut,
    "ripple_delete_clips": _always_cut,
    "delete_clips": _always_cut,
}


def _span_pairs(raw: list[Any]) -> list[tuple[float, float]]:
    return [(float(start), float(end)) for start, end in raw]


def _record_spans(record: AppliedEditRecord) -> Spans:
    """Timeline spans per track; the source range stands in when no timeline range exists."""
    params = record.params
    exact = params.get("exact_range")
    if exact:
        spans = [(float(iv["start"]), float(iv["end"])) for iv in exact["intervals"]]
        return {tid: spans for tid in exact["track_ids"]}
    cut_spans = params.get("cut_spans")
    if cut_spans:
        return {tid: _span_pairs(raw) for tid, raw in cut_spans.items()}
    for start, end in (
        (record.timeline_start, record.timeline_end),
        (record.source_start, record.source_end),
    ):
        if start is not None and end is not None and end > start:
            return {tid: [(float(start), float(end))] for tid in record.track_ids}
    return {}


def record_impact(record: AppliedEditRecord) -> RecordImpact | None:
    """Impact of an archived edit, or ``None`` for structural operations."""
    kind_of = _IMPACT_KIND.get(record.operation)
    if kind_of is None:
        return None
    return RecordImpact(kind=kind_of(record), spans_by_track=_record_spans(record))
