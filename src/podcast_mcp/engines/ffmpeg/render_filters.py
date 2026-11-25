from __future__ import annotations

import math

from podcast_mcp.engines.audio import (
    AFADE_CURVE_NAMES,
    FrameTransform,
    MuteSampleEnvelope,
    SourceFrameMapping,
    SourceMuteEnvelope,
    delay_frames,
)
from podcast_mcp.engines.effect_filters import format_effect
from podcast_mcp.models import FadeCurve, ProcessingEffect

ENVELOPE_FRAME_SAMPLES = 256


def mute_gain_expression(envelopes: tuple[MuteSampleEnvelope, ...]) -> str:
    gains: list[tuple[str, str]] = []
    for samples in envelopes:
        first, last = samples.first, samples.last
        fade_out, fade_in = samples.fade_out, samples.fade_in
        floor = samples.gain
        if fade_out + fade_in > last - first:
            gains.append((str(first), f"if(gte(n,{first})*lt(n,{last}),{floor:g},1)"))
            continue
        span = 1.0 - floor
        expr = "1"
        if fade_in > 0:
            expr = (
                f"if(between(n,{last - fade_in},{last}),"
                f"{floor:g}+{span:g}*(n-({last - fade_in}))/{fade_in},1)"
            )
        expr = f"if(between(n,{first + fade_out},{last - fade_in}),{floor:g},{expr})"
        if fade_out > 0:
            expr = (
                f"if(between(n,{first},{first + fade_out}),"
                f"1-{span:g}*(n-({first}))/{fade_out},{expr})"
            )
        gains.append((str(first), expr))
    if not gains:
        return "1"

    def interval_tree(items: list[tuple[str, str]]) -> str:
        if len(items) == 1:
            return items[0][1]
        middle = len(items) // 2
        return (
            f"if(lt(n,{items[middle][0]}),"
            f"{interval_tree(items[:middle])},{interval_tree(items[middle:])})"
        )

    return interval_tree(gains)


def automatic_gain_expression(
    envelopes: tuple[SourceMuteEnvelope, ...],
    mapping: SourceFrameMapping,
    bypass_windows: tuple[tuple[float, float], ...] = (),
) -> str:
    gains = []
    for envelope in envelopes:
        first, fall, rise, last = (
            mapping.endpoint(envelope.start),
            mapping.endpoint(envelope.start + envelope.fade_out_sec),
            mapping.endpoint(envelope.end - envelope.fade_in_sec),
            mapping.endpoint(envelope.end),
        )
        if fall > rise:
            fall, rise = first, last
        falling = f"({fall}-n)/{fall - first}" if fall > first else "0"
        rising = f"(n-{rise})/{last - rise}" if last > rise else "1"
        gains.append(
            f"if(lt(n,{first}),1,if(lt(n,{fall}),{falling},if(lt(n,{rise}),0,if(lt(n,{last}),{rising},1))))"
        )
    gain = gains[0] if gains else "1"
    for other in gains[1:]:
        gain = f"min({gain},{other})"
    if bypass_windows:
        selected = "+".join(
            f"gte(n,{mapping.endpoint(start, ceil=True)})*lt(n,{mapping.endpoint(end, ceil=True)})"
            for start, end in bypass_windows
        )
        gain = f"if({selected},1,{gain})"
    return gain


# 3: use the completed graph's true-peak summary for headroom trim (#855).
# 4: premixes cached with trim 0.0 from an unmeasured peak must re-mix (#2890).
MIX_SEMANTICS_REV = 4

MASTER_SEMANTICS_REV = 1


def _sample_frame_expression(offset: int, source_rate: int) -> str:
    sign = "-" if offset < 0 else ""
    return f"{sign}floor({abs(offset)}*s/{source_rate}+0.5)"


def _delay_filter(delay_sec: float, sample_rate: int) -> str:
    """Silence of ``delay_sec`` in front of the audio, with timestamps renumbered by sample.

    Placed on ``round(delay_sec * rate)`` samples, as the evaluation does (#2025, #2456).
    ``sample_rate`` is the rate the render graph negotiates at this delay: the leading
    ``aformat`` resamples the audio to it before ``adelay``, so the pin never moves the rate
    the mix runs at.
    The trailing ``aformat`` keeps ``adelay``'s out-link at that rate when a filter downstream
    of the mix forces another rate and the dry run disagrees with the real run (#2082).

    When ``atrim`` has cut the first frame on a seeked input, ``adelay`` emits its lead-in
    frames with no timestamp (``NOPTS``), and a later ``apad`` or ``atrim`` drops them: a
    1 s lead-in shrinks to 2048 samples. ``asetpts=N/SR/TB`` restamps every frame from
    its sample count, so the silence keeps its length.
    """
    pin = f"aformat=sample_rates={sample_rate}"
    frames = delay_frames(delay_sec, sample_rate)
    return f"{pin},adelay=delays={frames}S:all=1,asetpts=N/SR/TB,{pin}"


def _afade_curve_option(curve: FadeCurve) -> str:
    return "" if curve is FadeCurve.LINEAR else f":curve={AFADE_CURVE_NAMES[curve]}"


def _effect_filter(fx: ProcessingEffect) -> str | None:
    """Format one supported processing effect; preserve order in the caller."""
    return format_effect(fx.effect, fx.params)


def _mask_endpoint(
    seconds: float, rate: int, origin: int, transforms: tuple[FrameTransform, ...]
) -> str:
    if transforms:
        return str(SourceFrameMapping(rate, 0, transforms).endpoint(seconds, ceil=True))
    return _sample_frame_expression(math.ceil(seconds * rate) - origin, rate)
