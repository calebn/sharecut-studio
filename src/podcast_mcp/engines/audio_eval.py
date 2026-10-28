"""In-memory evaluation of a declarative ``Audio`` tree.

``FFmpegEngine.render_timeline`` turns an ``Audio`` tree into a filtergraph. This module
evaluates the same tree with numpy, so a caller that only needs the track's levels skips
the render. It supports the plain subset (slices, edge fades, fade and triangular
crossfade joins, delayed mixes, silence, gate-fill sums, mutes and off-speaker gain).
Anything else makes :func:`plan_audio` return ``None``, and the caller keeps the render.

The tree compiles to a :class:`Piece` per node: its length, and a ``read(start, stop)``
that produces just those samples. Nothing holds a whole track, so a caller streams the
result in chunks (``evaluate_resampled``) and a long episode costs a few megabytes, not
the length of the track in 48 kHz samples.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass
from itertools import accumulate
from pathlib import Path
from typing import Protocol

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
    delay_frames,
    fade_duration,
    postorder,
    sources,
)
from podcast_mcp.engines.media_probe import probe_media
from podcast_mcp.engines.media_seek import MediaSeek

EVAL_SAMPLE_RATE = 8000
CHUNK_SAMPLES = 1 << 20


class SourceReader(Protocol):
    """One decoded mono file: its length in samples, and any range of them."""

    @property
    def size(self) -> int: ...

    def read(self, start: int, stop: int) -> np.ndarray: ...


@dataclass(frozen=True)
class ArrayReader:
    samples: np.ndarray

    @property
    def size(self) -> int:
        return int(self.samples.size)

    def read(self, start: int, stop: int) -> np.ndarray:
        return self.samples[start:stop].astype(np.float32, copy=True)


@dataclass(frozen=True)
class Piece:
    """``size`` samples of a node's output, read on demand (``0 <= start <= stop <= size``)."""

    size: int
    read: Callable[[int, int], np.ndarray]


def evaluate_audio(
    audio: Audio,
    *,
    crossfade_curve: str,
    load_source: Callable[[Path], np.ndarray],
    sample_rate: int = EVAL_SAMPLE_RATE,
) -> np.ndarray | None:
    """Mono samples the render of ``audio`` decodes to, or None when it is not plain.

    ``load_source`` returns a file's mono decode at ``sample_rate``. This holds the whole
    result; a long track goes through :func:`evaluate_resampled`.
    """
    cache: dict[Path, ArrayReader] = {}

    def reader(path: Path) -> SourceReader:
        if path not in cache:
            cache[path] = ArrayReader(load_source(path))
        return cache[path]

    piece = plan_audio(
        audio, crossfade_curve=crossfade_curve, reader=reader, sample_rate=sample_rate
    )
    if piece is None:
        return None
    return piece.read(0, piece.size)


def evaluate_resampled(
    audio: Audio,
    *,
    crossfade_curve: str,
    reader: Callable[[Path], SourceReader],
    sample_rate: int,
    target_rates: Sequence[int],
    resample: Callable[[Iterator[np.ndarray], int, Sequence[int]], dict[int, np.ndarray]],
) -> dict[int, np.ndarray] | None:
    """Evaluate the tree in chunks at ``sample_rate`` and return its samples at each of ``target_rates``.

    One pass over the tree feeds every rate, so a rate's result does not depend on which
    other rates are requested.
    """
    piece = plan_audio(
        audio, crossfade_curve=crossfade_curve, reader=reader, sample_rate=sample_rate
    )
    if piece is None or piece.size == 0:
        return None

    def chunks() -> Iterator[np.ndarray]:
        for start in range(0, piece.size, CHUNK_SAMPLES):
            yield piece.read(start, min(piece.size, start + CHUNK_SAMPLES))

    return resample(chunks(), sample_rate, target_rates)


def plan_audio(
    audio: Audio,
    *,
    crossfade_curve: str,
    reader: Callable[[Path], SourceReader],
    sample_rate: int,
) -> Piece | None:
    if crossfade_curve != "tri" or _rereads_earlier_source(audio):
        return None
    seek = MediaSeek.at(0, lead_sec=0.0)
    stack: list[Piece] = []
    for node in postorder(audio):
        match node:
            case SourceAudio():
                stack.append(_source(node, reader, seek, sample_rate))
            case SilenceAudio():
                size = int(node.duration_sec * sample_rate)
                stack.append(Piece(size, lambda a, b: np.zeros(b - a, dtype=np.float32)))
            case SequenceAudio():
                count = len(node.tail) + 1
                parts = stack[-count:]
                del stack[-count:]
                stack.append(_sequence(parts))
            case CrossfadeAudio():
                right, left = stack.pop(), stack.pop()
                # acrossfade parses d= in microseconds and rounds its sample count half up.
                joined = _crossfade(left, right, seek.first_sample(node.overlap_sec, sample_rate))
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


def _source(
    node: SourceAudio,
    reader: Callable[[Path], SourceReader],
    seek: MediaSeek,
    sample_rate: int,
) -> Piece:
    body = reader(node.path)
    first = seek.first_sample(node.src_start, sample_rate)
    last = seek.first_sample(node.src_end, sample_rate)
    size = max(0, min(last, body.size) - first)
    fill = reader(node.fill_path) if node.fill_path is not None else None
    under = 0 if fill is None else min(size, max(0, min(last, fill.size) - first))

    def read(start: int, stop: int) -> np.ndarray:
        out = body.read(first + start, first + stop)
        if fill is not None and under > start:
            end = min(stop, under)
            out[: end - start] += fill.read(first + start, first + end)
        out = _edge_fades(out, start, size, node, sample_rate)
        return _muted(out, start, node, seek, sample_rate)

    return Piece(size, read)


def _sequence(parts: list[Piece]) -> Piece:
    ends = list(accumulate(part.size for part in parts))
    starts = [end - part.size for end, part in zip(ends, parts, strict=True)]

    def read(start: int, stop: int) -> np.ndarray:
        pieces = [
            part.read(max(start, at) - at, min(stop, end) - at)
            for part, at, end in zip(parts, starts, ends, strict=True)
            if max(start, at) < min(stop, end)
        ]
        if not pieces:
            return np.zeros(0, dtype=np.float32)
        return pieces[0] if len(pieces) == 1 else np.concatenate(pieces)

    return Piece(ends[-1], read)


def _edge_fades(
    piece: np.ndarray, start: int, size: int, node: SourceAudio, sample_rate: int
) -> np.ndarray:
    """``piece`` (samples ``start`` on of a ``size``-sample slice) under the slice's edge ramps."""
    if node.fade_in_sec <= 0 and node.fade_out_sec <= 0:
        return piece
    length = node.src_end - node.src_start
    index = np.arange(start, start + piece.size)
    if node.fade_in_sec > 0:
        count = min(size, round(fade_duration(length, node.fade_in_sec) * sample_rate))
        head = index < count
        piece[head] *= index[head].astype(np.float32) / max(count, 1)
    if node.fade_out_sec > 0:
        d = fade_duration(length, node.fade_out_sec)
        fade_start = round(max(0.0, length - d) * sample_rate)
        count = min(size - fade_start, round(d * sample_rate))
        if count > 0:
            tail = (index >= fade_start) & (index < fade_start + count)
            piece[tail] *= 1.0 - (index[tail] - fade_start).astype(np.float32) / max(count, 1)
        piece[index >= fade_start + max(count, 0)] = 0.0
    return piece


def _muted(
    piece: np.ndarray, start: int, node: SourceAudio, seek: MediaSeek, sample_rate: int
) -> np.ndarray:
    """``piece`` under each mute span's gain, as ``FFmpegEngine.mute_gain_expression`` builds it."""
    if not node.mute_spans:
        return piece
    origin = seek.first_sample(node.src_start, sample_rate)
    stop = start + piece.size
    gain = np.ones(piece.size, dtype=np.float32)
    for span in node.mute_spans:
        if (
            span.end <= span.start + 1e-6
            or span.end <= 0
            or span.start >= node.src_end - node.src_start
        ):
            continue
        env = span.samples(sample_rate, source_start=node.src_start, origin=origin)
        first, last = max(env.first, 0, start), min(env.last, stop)
        if last <= first:
            continue
        n = np.arange(first, last, dtype=np.float32)
        floor = np.float32(env.gain)
        curve = np.full(last - first, floor, dtype=np.float32)
        if env.fade_out + env.fade_in <= env.last - env.first:
            rise = env.last - env.fade_in
            if env.fade_out > 0:
                out = n < env.first + env.fade_out
                curve[out] = 1.0 - (1.0 - floor) * (n[out] - env.first) / env.fade_out
            if env.fade_in > 0:
                back = n >= rise
                curve[back] = floor + (1.0 - floor) * (n[back] - rise) / env.fade_in
        window = slice(first - start, last - start)
        gain[window] = np.minimum(gain[window], curve)
    return piece * gain


def _off_speaker(body: Piece, node: OffSpeakerAudio, seek: MediaSeek, sample_rate: int) -> Piece:
    """``body`` under the automatic off-speaker mute gain (``automatic_gain_expression``)."""
    if not node.envelopes:
        return body
    origin = seek.first_sample(node.primary.src_start, sample_rate)

    def at(seconds: float, *, ceil: bool = False) -> int:
        frame = (
            math.ceil(seconds * sample_rate) if ceil else math.floor(seconds * sample_rate + 0.5)
        )
        return frame - origin

    def read(start: int, stop: int) -> np.ndarray:
        samples = body.read(start, stop)
        n = np.arange(start, stop, dtype=np.float64)
        gain = np.ones(samples.size, dtype=np.float64)
        for env in node.envelopes:
            first, fall = at(env.start), at(env.start + env.fade_out_sec)
            rise, last = at(env.end - env.fade_in_sec), at(env.end)
            if fall > rise:
                fall, rise = first, last
            part = np.ones(samples.size, dtype=np.float64)
            falling = (n >= first) & (n < fall)
            part[falling] = (fall - n[falling]) / max(fall - first, 1)
            part[(n >= fall) & (n < rise)] = 0.0
            rising = (n >= rise) & (n < last)
            part[rising] = (n[rising] - rise) / max(last - rise, 1)
            gain = np.minimum(gain, part)
        for window_start, window_end in node.bypass_windows:
            gain[(n >= at(window_start, ceil=True)) & (n < at(window_end, ceil=True))] = 1.0
        return (samples * gain).astype(np.float32)

    return Piece(body.size, read)


def _ramp(index: np.ndarray, count: int, *, rising: bool) -> np.ndarray:
    up = index.astype(np.float32) / max(count, 1)
    return up if rising else 1.0 - up


def _crossfade(left: Piece, right: Piece, overlap: int) -> Piece | None:
    if overlap < 1 or left.size < overlap or right.size < overlap:
        return None
    seam_start = left.size - overlap
    size = left.size + right.size - overlap

    def read(start: int, stop: int) -> np.ndarray:
        out = np.empty(stop - start, dtype=np.float32)
        head = (max(start, 0), min(stop, seam_start))
        if head[0] < head[1]:
            out[head[0] - start : head[1] - start] = left.read(*head)
        seam = (max(start, seam_start), min(stop, left.size))
        if seam[0] < seam[1]:
            index = np.arange(seam[0] - seam_start, seam[1] - seam_start)
            faded = left.read(*seam) * _ramp(index, overlap, rising=False)
            out[seam[0] - start : seam[1] - start] = faded + right.read(
                seam[0] - seam_start, seam[1] - seam_start
            ) * _ramp(index, overlap, rising=True)
        tail = (max(start, left.size), min(stop, size))
        if tail[0] < tail[1]:
            out[tail[0] - start : tail[1] - start] = right.read(
                tail[0] - seam_start, tail[1] - seam_start
            )
        return out

    return Piece(size, read)


def _mix(starts: list[float], parts: list[Piece], rate: int) -> Piece:
    offsets = [delay_frames(start, rate) for start in starts]
    size = max(o + p.size for o, p in zip(offsets, parts, strict=True))

    def read(start: int, stop: int) -> np.ndarray:
        mixed = np.zeros(stop - start, dtype=np.float32)
        for offset, part in zip(offsets, parts, strict=True):
            first, last = max(start, offset), min(stop, offset + part.size)
            if first < last:
                mixed[first - start : last - start] += part.read(first - offset, last - offset)
        return mixed

    return Piece(size, read)


def _rereads_earlier_source(audio: Audio) -> bool:
    """Whether a crossfade's right side starts a file at or before where its left side does.

    Handles that overlap the next slice read forward and render as the sum of their slices,
    and a duplicated or reordered slice in a plain sequence or mix does too (pads and fills
    are such slices). Across a crossfade the render reads the file once and splits it, and
    that read is cut short when the right side comes first in the file.
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


def common_rate(audio: Audio) -> int | None:
    """The one sample rate every source and fill is stored at, or None when they differ.

    A track at one rate renders at that rate, so its tree evaluates at the same rate. Sources
    at different rates are resampled slice by slice inside the filtergraph, which only the
    render reproduces.
    """
    rates = set()
    for node in postorder(audio):
        if isinstance(node, SourceAudio):
            for path in (node.path, node.fill_path):
                if path is None:
                    continue
                probe = probe_media(path)
                if probe is None:
                    return None
                rates.add(probe.sample_rate)
    return rates.pop() if len(rates) == 1 else None


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
