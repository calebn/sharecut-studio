from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from podcast_mcp.engines.audio import FrameTransform, rescale_frames
from podcast_mcp.models import Clip
from podcast_mcp.util.batch_scope import scoped_by_file
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.hashing import sha256_file
from podcast_mcp.util.project_state import file_revision

RESTORE_RENDER_REV = 1


def active_restore_regions(clip: Clip, path: Path) -> tuple[tuple[float, float], ...]:
    restore = clip.bleed_restore
    if restore is None or not restore.regions:
        return ()
    path = path.resolve()
    revision = file_revision(path)
    digest = scoped_by_file("bleed_restore_sha256", path, revision, lambda: sha256_file(path))
    if file_revision(path) != revision:
        raise CodedValueError(
            "Recording changed while validating bleed Restore", code="bleed_restore_inputs_changed"
        )
    if digest != restore.source_sha256:
        return ()
    return tuple((region.start_s, region.end_s) for region in restore.regions)


@dataclass(frozen=True)
class RestoreSupport:
    saved_first_frame: int
    saved_last_frame: int
    active_first_frame: int
    active_last_frame: int
    source_first_frame: int
    source_rate: int
    placement_frame: int
    placement_rate: int
    timeline_origin_sec: float = 0.0
    transforms: tuple[FrameTransform, ...] = ()

    def output_frame(self, source_frame: int, rate: int) -> int:
        if self.transforms:
            for transform in self.transforms:
                source_frame = transform.apply(source_frame)
            frame = rescale_frames(source_frame, self.placement_rate, rate)
        else:
            frame = rescale_frames(
                self.placement_frame
                + rescale_frames(
                    source_frame - self.source_first_frame, self.source_rate, self.placement_rate
                ),
                self.placement_rate,
                rate,
            )
        return round(self.timeline_origin_sec * rate) + frame


def restore_gains_for_frames(
    supports: tuple[RestoreSupport, ...],
    first_frame: int,
    count: int,
    rate: int,
    *,
    fade_sec: float,
) -> np.ndarray:
    """Union output ramps at saved bounds, clipped only by occurrence membership."""
    result = np.zeros(count, dtype=np.float64)
    positions = np.arange(first_frame, first_frame + count)
    for support in supports:
        lo, hi = (
            support.output_frame(support.saved_first_frame, rate),
            support.output_frame(support.saved_last_frame, rate),
        )
        active = (positions >= support.output_frame(support.active_first_frame, rate)) & (
            positions < support.output_frame(support.active_last_frame, rate)
        )
        width = min(round(fade_sec * rate), (hi - lo) // 2)
        values = (
            np.ones(count)
            if not width
            else np.minimum(1, np.minimum((positions - lo) / width, (hi - 1 - positions) / width))
        )
        result[active] = np.maximum(result[active], values[active])
    return result


def restored_pcm(
    baseline: bytes,
    whole: bytes,
    without: bytes | None,
    *,
    channels: int,
    gate_gains: np.ndarray,
    restore_gains: np.ndarray,
    lifted_baseline: bytes | None = None,
    fill: np.ndarray | None = None,
) -> bytes:
    """Joint marginal of quantized bus renders, preserving exact zero-correction bytes.

    ``fill`` is the room tone (16-bit sample units, per frame) that the gate added to
    ``baseline`` over its mutes (#1734). A restored span is the recording's own sound
    again, so the fill leaves it as restoration comes in.
    """
    base = np.frombuffer(baseline, dtype="<i2").reshape(-1, channels)
    w = np.frombuffer(whole, dtype="<i2").reshape(-1, channels)
    correction = np.zeros_like(w, dtype=np.float64)
    if lifted_baseline is not None:
        lifted = np.frombuffer(lifted_baseline, dtype="<i2").reshape(-1, channels)
        correction += lifted.astype(np.float64) - base.astype(np.float64)
    if without is not None:
        v = np.frombuffer(without, dtype="<i2").reshape(-1, channels)
        correction += (1 - gate_gains)[:, None] * (w.astype(np.float64) - v.astype(np.float64))
    if fill is not None:
        correction -= fill[:, None]
    correction *= restore_gains[:, None]
    result = base.copy()
    active = correction != 0
    result[active] = np.clip(
        base.astype(np.float64)[active] + correction[active], -32768, 32767
    ).astype("<i2")
    return result.tobytes()
