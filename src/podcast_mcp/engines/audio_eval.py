"""In-memory evaluation of a declarative ``Audio`` tree, at the evidence sample rate.

``FFmpegEngine.render_timeline`` turns an ``Audio`` tree into a filtergraph. This module
evaluates the same tree with numpy on the 8 kHz mono decode of each source, so a caller
that only needs the track's levels skips the render and the wav decode. It supports the
plain subset (slices, edge fades, fade and triangular crossfade joins, delayed mixes,
silence, gate-fill sums). Anything else makes :func:`evaluate_audio` return ``None``, and
the caller keeps the ffmpeg render.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from pathlib import Path

import numpy as np

from podcast_mcp.engines.audio import (
    Audio,
    CrossfadeAudio,
    MaskAudio,
    MixAudio,
    OffSpeakerAudio,
    SequenceAudio,
    SilenceAudio,
    SourceAudio,
    delay_milliseconds,
    fade_duration,
    postorder,
    sources,
)
from podcast_mcp.engines.media_probe import probe_media
from podcast_mcp.engines.media_seek import MediaSeek

EVAL_SAMPLE_RATE = 8000


def evaluate_audio(
    audio: Audio,
    *,
    crossfade_curve: str,
    load_source: Callable[[Path], np.ndarray],
    sample_rate: int = EVAL_SAMPLE_RATE,
) -> np.ndarray | None:
    """Mono samples the render of ``audio`` decodes to, or None when it is not plain.

    ``load_source`` returns a file's mono decode at ``sample_rate``.
    """
    if crossfade_curve != "tri":
        return None
    if _rereads_earlier_source(audio):
        return None
    loaded: dict[Path, np.ndarray] = {}

    def source(path: Path) -> np.ndarray:
        if path not in loaded:
            loaded[path] = load_source(path)
        return loaded[path]

    seek = MediaSeek.at(0)
    stack: list[np.ndarray] = []
    for node in postorder(audio):
        match node:
            case SourceAudio():
                piece = _slice(source(node.path), node, seek, sample_rate)
                if node.fill_path is not None:
                    piece = _with_fill(piece, source(node.fill_path), node, seek, sample_rate)
                stack.append(_muted(_edge_fades(piece, node, sample_rate), node, seek, sample_rate))
            case SilenceAudio():
                stack.append(np.zeros(int(node.duration_sec * sample_rate), dtype=np.float32))
            case SequenceAudio():
                count = len(node.tail) + 1
                parts = stack[-count:]
                del stack[-count:]
                stack.append(np.concatenate(parts))
            case CrossfadeAudio():
                right, left = stack.pop(), stack.pop()
                joined = _crossfade(left, right, round(node.overlap_sec * sample_rate))
                if joined is None:
                    return None
                stack.append(joined)
            case MixAudio():
                ats = (node.head, *node.tail)
                parts = stack[-len(ats) :]
                del stack[-len(ats) :]
                stack.append(_mix([at.start_sec for at in ats], parts, sample_rate))
            case OffSpeakerAudio():
                stack.append(_off_speaker(stack.pop(), node, seek, sample_rate))
            case MaskAudio():
                return None
    return stack[0]


def _slice(samples: np.ndarray, node: SourceAudio, seek: MediaSeek, sample_rate: int) -> np.ndarray:
    first = seek.first_sample(node.src_start, sample_rate)
    last = seek.first_sample(node.src_end, sample_rate)
    return samples[first:last]


def _with_fill(
    piece: np.ndarray, fill: np.ndarray, node: SourceAudio, seek: MediaSeek, sample_rate: int
) -> np.ndarray:
    under = _slice(fill, node, seek, sample_rate)[: piece.size]
    summed = piece.copy()
    summed[: under.size] += under
    return summed


def _edge_fades(piece: np.ndarray, node: SourceAudio, sample_rate: int) -> np.ndarray:
    if node.fade_in_sec <= 0 and node.fade_out_sec <= 0:
        return piece
    length = node.src_end - node.src_start
    faded = piece.astype(np.float32, copy=True)
    if node.fade_in_sec > 0:
        count = min(faded.size, round(fade_duration(length, node.fade_in_sec) * sample_rate))
        faded[:count] *= _ramp(count, rising=True)
    if node.fade_out_sec > 0:
        d = fade_duration(length, node.fade_out_sec)
        start = round(max(0.0, length - d) * sample_rate)
        count = min(faded.size - start, round(d * sample_rate))
        if count > 0:
            faded[start : start + count] *= _ramp(count, rising=False)
        faded[start + max(count, 0) :] = 0.0
    return faded


def _muted(piece: np.ndarray, node: SourceAudio, seek: MediaSeek, sample_rate: int) -> np.ndarray:
    """``piece`` under each mute span's gain, as ``FFmpegEngine.mute_gain_expression`` builds it."""
    if not node.mute_spans:
        return piece
    origin = seek.first_sample(node.src_start, sample_rate)
    gain = np.ones(piece.size, dtype=np.float32)
    for span in node.mute_spans:
        if (
            span.end <= span.start + 1e-6
            or span.end <= 0
            or span.start >= node.src_end - node.src_start
        ):
            continue
        env = span.samples(sample_rate, source_start=node.src_start, origin=origin)
        first, last = max(env.first, 0), min(env.last, piece.size)
        if last <= first:
            continue
        n = np.arange(first, last, dtype=np.float32)
        floor = np.float32(env.gain)
        if env.fade_out + env.fade_in > env.last - env.first:
            curve = np.full(last - first, floor, dtype=np.float32)
        else:
            curve = np.full(last - first, floor, dtype=np.float32)
            rise = env.last - env.fade_in
            if env.fade_out > 0:
                out = n < env.first + env.fade_out
                curve[out] = 1.0 - (1.0 - floor) * (n[out] - env.first) / env.fade_out
            if env.fade_in > 0:
                back = n >= rise
                curve[back] = floor + (1.0 - floor) * (n[back] - rise) / env.fade_in
        gain[first:last] = np.minimum(gain[first:last], curve)
    return piece * gain


def _off_speaker(
    body: np.ndarray, node: OffSpeakerAudio, seek: MediaSeek, sample_rate: int
) -> np.ndarray:
    """``body`` under the automatic off-speaker mute gain (``automatic_gain_expression``)."""
    if not node.envelopes:
        return body
    origin = seek.first_sample(node.primary.src_start, sample_rate)

    def at(seconds: float, *, ceil: bool = False) -> int:
        frame = (
            math.ceil(seconds * sample_rate) if ceil else math.floor(seconds * sample_rate + 0.5)
        )
        return frame - origin

    n = np.arange(body.size, dtype=np.float64)
    gain = np.ones(body.size, dtype=np.float64)
    for env in node.envelopes:
        first, fall = at(env.start), at(env.start + env.fade_out_sec)
        rise, last = at(env.end - env.fade_in_sec), at(env.end)
        if fall > rise:
            fall, rise = first, last
        part = np.ones(body.size, dtype=np.float64)
        part[(n >= first) & (n < fall)] = (fall - n[(n >= first) & (n < fall)]) / max(
            fall - first, 1
        )
        part[(n >= fall) & (n < rise)] = 0.0
        part[(n >= rise) & (n < last)] = (n[(n >= rise) & (n < last)] - rise) / max(last - rise, 1)
        gain = np.minimum(gain, part)
    for start, end in node.bypass_windows:
        gain[(n >= at(start, ceil=True)) & (n < at(end, ceil=True))] = 1.0
    return (body * gain).astype(np.float32)


def _ramp(count: int, *, rising: bool) -> np.ndarray:
    up = np.arange(count, dtype=np.float32) / max(count, 1)
    return up if rising else 1.0 - up


def _crossfade(left: np.ndarray, right: np.ndarray, overlap: int) -> np.ndarray | None:
    if overlap < 1 or left.size < overlap or right.size < overlap:
        return None
    seam = left[left.size - overlap :] * _ramp(overlap, rising=False)
    seam = seam + right[:overlap] * _ramp(overlap, rising=True)
    return np.concatenate((left[: left.size - overlap], seam, right[overlap:]))


def _rereads_earlier_source(audio: Audio) -> bool:
    """Whether a crossfade's right side starts a file at or before where its left side does.

    Handles that overlap the next slice read forward and render as the sum of their slices,
    and a duplicated or reordered slice in a plain sequence or mix does too (pads and fills
    are such slices). Across a crossfade the render reads the file once and splits it, and
    that read is cut short on ffmpeg 6.1 when the right side comes first in the file.
    """
    for node in postorder(audio):
        if isinstance(node, CrossfadeAudio):
            left_starts: dict[Path, float] = {}
            for leaf in sources(node.left):
                left_starts[leaf.path] = max(left_starts.get(leaf.path, -1.0), leaf.src_start)
            if any(
                leaf.src_start <= left_starts.get(leaf.path, -1.0) for leaf in sources(node.right)
            ):
                return True
    return False


def single_layout(audio: Audio) -> bool:
    """Whether every source and fill has one channel count: ffmpeg's stereo-to-mono matrix
    differs from the mean the 8 kHz decode takes, so a mixed track keeps the render."""
    channels = set()
    for node in postorder(audio):
        if isinstance(node, SourceAudio):
            for path in (node.path, node.fill_path):
                if path is None:
                    continue
                probe = probe_media(path)
                if probe is None:
                    return False
                channels.add(probe.channels)
    return len(channels) <= 1


def _mix(starts: list[float], parts: list[np.ndarray], rate: int) -> np.ndarray:
    offsets = [delay_milliseconds(start) * rate // 1000 for start in starts]
    mixed = np.zeros(max(o + p.size for o, p in zip(offsets, parts, strict=True)), dtype=np.float32)
    for offset, part in zip(offsets, parts, strict=True):
        mixed[offset : offset + part.size] += part
    return mixed
