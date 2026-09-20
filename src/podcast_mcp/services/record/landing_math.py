"""Pure clock math for record-session timeline landing."""

from __future__ import annotations

from podcast_mcp.services.record.state import TakeState, take_recording_duration_ms
from podcast_mcp.services.record.upload import KEEPER_SAMPLE_RATE

TAKE_GAP_MS = 2000
ALIGN_DRIFT_MS = 50
DRIFT_WINDOW_S = 60.0


def pad_samples(join_offset_ms: int, sample_rate: int = KEEPER_SAMPLE_RATE) -> int:
    """Leading zeros when encoding segment 0 as clip@0 (optional; not default)."""
    return round(join_offset_ms * sample_rate / 1000)


def origin_pad_samples(
    *,
    segment_index: int,
    join_offset_ms: int,
    sample_rate: int = KEEPER_SAMPLE_RATE,
) -> int:
    """In-file pad is only legal for segment 0. Later segments stay unpadded."""
    if segment_index != 0:
        return 0
    return pad_samples(join_offset_ms, sample_rate)


def duration_s(samples_written: int, sample_rate: int = KEEPER_SAMPLE_RATE) -> float:
    if samples_written <= 0 or sample_rate <= 0:
        return 0.0
    return samples_written / sample_rate


def expected_span_s(
    join_offset_ms: int,
    *,
    take_duration_ms: int,
    next_join_offset_ms: int | None = None,
) -> float:
    """Recording-clock length this segment should occupy."""
    start = max(0, join_offset_ms)
    end = take_duration_ms
    if next_join_offset_ms is not None:
        end = min(end, next_join_offset_ms)
    if end <= start:
        return 0.0
    return (end - start) / 1000.0


def duration_error_ms(actual_s: float, expected_s: float) -> float | None:
    """File duration minus recording-clock span, in milliseconds."""
    if expected_s <= 0:
        return None
    return (actual_s - expected_s) * 1000.0


def clip_timeline_s(take_offset_s: float, join_offset_ms: int) -> float:
    return take_offset_s + join_offset_ms / 1000.0


def take_offsets_s(
    takes: list[TakeState],
    *,
    tombstoned: set[int] | frozenset[int] | None = None,
    take_gap_ms: int = TAKE_GAP_MS,
) -> dict[int, float]:
    """Sequential take origins. Tombstoned takes do not consume timeline."""
    skipped = tombstoned or set()
    offsets: dict[int, float] = {}
    acc_ms = 0
    alive = [
        take
        for take in sorted(takes, key=lambda row: row.take_index)
        if take.take_index not in skipped
    ]
    for i, take in enumerate(alive):
        offsets[take.take_index] = acc_ms / 1000.0
        acc_ms += take_recording_duration_ms(take)
        if i < len(alive) - 1:
            acc_ms += take_gap_ms
    return offsets


def session_start_present(take: TakeState) -> bool:
    return bool(str(take.session_start_iso or "").strip())


def needs_align_fallback(
    takes: list[TakeState],
    *,
    tombstoned: set[int] | frozenset[int] | None = None,
    drift_ms: float | None = None,
) -> bool:
    """Hint that pipeline ``align_tracks`` should run after transcripts exist.

    Land does not invoke conversation align (no ASR yet). ``drift_ms`` is a
    sample-count vs recording-clock error, not GCC-PHAT of dry keepers.
    """
    skipped = tombstoned or set()
    relevant = [take for take in takes if take.take_index not in skipped]
    if any(not session_start_present(take) for take in relevant):
        return True
    return drift_ms is not None and abs(drift_ms) > ALIGN_DRIFT_MS


def overlap_window_s(
    join_a_ms: int,
    duration_a_s: float,
    join_b_ms: int,
    duration_b_s: float,
    *,
    window_s: float = DRIFT_WINDOW_S,
) -> tuple[float, float] | None:
    """Return ``(start_s, duration_s)`` on the recording clock for a bounded overlap."""
    start = max(join_a_ms, join_b_ms) / 1000.0
    end = min(join_a_ms / 1000.0 + duration_a_s, join_b_ms / 1000.0 + duration_b_s)
    span = end - start
    if span < 0.05 or window_s <= 0:
        return None
    return start, min(span, window_s)
