from __future__ import annotations

import math
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

from podcast_mcp.engines.media_seek import MediaSeek
from podcast_mcp.util.coded_error import CodedValueError


@dataclass(frozen=True)
class MuteSampleEnvelope:
    """A render envelope on its source sample grid."""

    first: int
    last: int
    fade_out: int
    fade_in: int
    gain: float = 0.0

    def silent_span(self) -> tuple[int, int]:
        """Half-open sample run whose generated gain is exactly zero (empty when lowered)."""
        if self.gain > 0.0:
            return self.first, self.first
        if self.fade_out + self.fade_in > self.last - self.first:
            return self.first, self.last
        return self.first + self.fade_out, self.last - self.fade_in + 1


@dataclass(frozen=True)
class RequestedExtent:
    seconds: float


@dataclass(frozen=True)
class MuteEnvelope:
    """One muted region's gain, in seconds from a render window's start.

    The gain falls to ``gain`` (zero for a mute, a linear floor for Lower) over the first
    ``fade_out_sec`` of ``[start, end)``, stays there and rises back to one over its
    last ``fade_in_sec``.
    """

    start: float
    end: float
    fade_out_sec: float
    fade_in_sec: float
    gain: float = 0.0

    def samples(
        self, sample_rate: int, *, source_start: float = 0.0, origin: int = 0
    ) -> MuteSampleEnvelope:
        return MuteSampleEnvelope(
            math.floor((self.start + source_start) * sample_rate + 0.5) - origin,
            math.floor((self.end + source_start) * sample_rate + 0.5) - origin,
            math.floor(self.fade_out_sec * sample_rate + 0.5),
            math.floor(self.fade_in_sec * sample_rate + 0.5),
            self.gain,
        )


def fade_duration(segment_duration: float, requested: float) -> float:
    """Duration used by FFmpeg's ordinary triangular edge ramp."""
    return min(requested, max(segment_duration * 0.5, 0.001))


@dataclass(frozen=True)
class SourceAudio:
    path: Path
    src_start: float
    src_end: float
    fade_in_sec: float = 0.0
    fade_out_sec: float = 0.0
    mute_spans: tuple[MuteEnvelope, ...] = ()
    fill_path: Path | None = None
    clip_id: str | None = field(default=None, compare=False)
    source_id: str | None = field(default=None, compare=False)
    is_fill: bool = False
    reach_in: float = field(default=0.0, compare=False)
    reach_out: float = field(default=0.0, compare=False)

    @property
    def nominal_start(self) -> float:
        """Source start without audio borrowed by a blending join."""
        return self.src_start + self.reach_in

    @property
    def nominal_end(self) -> float:
        """Source end without audio borrowed by a blending join."""
        return self.src_end - self.reach_out


@dataclass(frozen=True)
class SequenceAudio:
    head: Audio
    tail: tuple[Audio, ...]


@dataclass(frozen=True)
class CrossfadeAudio:
    left: Audio
    right: Audio
    overlap_sec: float


@dataclass(frozen=True)
class At:
    start_sec: float
    audio: Audio


@dataclass(frozen=True)
class MixAudio:
    head: At
    tail: tuple[At, ...]


@dataclass(frozen=True)
class SilenceAudio:
    duration_sec: float


@dataclass(frozen=True)
class MaskAudio:
    """Remove source-clock windows from a prepared body on its primary source grid."""

    body: Audio
    source_start: float
    windows: tuple[tuple[float, float], ...]
    clock: BoundaryClock | None = None
    first_source_frame: int | None = None
    source_rate: int | None = None
    source_transforms: tuple[FrameTransform, ...] = ()


@dataclass(frozen=True)
class SourceMuteEnvelope:
    start: float
    end: float
    fade_out_sec: float
    fade_in_sec: float


@dataclass(frozen=True)
class OffSpeakerAudio:
    body: Audio
    primary: SourceAudio
    envelopes: tuple[SourceMuteEnvelope, ...]
    bypass_windows: tuple[tuple[float, float], ...] = ()


Audio = (
    SourceAudio
    | SequenceAudio
    | CrossfadeAudio
    | MixAudio
    | SilenceAudio
    | MaskAudio
    | OffSpeakerAudio
)


@dataclass(frozen=True)
class GainRamp:
    start: float
    end: float
    rising: bool
    curve: str


@dataclass(frozen=True)
class PlacedSource:
    source: SourceAudio
    timeline_start: float
    ramps: tuple[GainRamp, ...]


def placed_sources(audio: Audio, *, crossfade_curve: str) -> list[PlacedSource]:
    result: list[PlacedSource] = []

    def visit(node: Audio, at: float, ramps: tuple[GainRamp, ...]) -> None:
        match node:
            case SourceAudio():
                length = duration(node)
                own = []
                if node.fade_in_sec > 0:
                    own.append(
                        GainRamp(at, at + fade_duration(length, node.fade_in_sec), True, "tri")
                    )
                if node.fade_out_sec > 0:
                    own.append(
                        GainRamp(
                            at + length - fade_duration(length, node.fade_out_sec),
                            at + length,
                            False,
                            "tri",
                        )
                    )
                result.append(
                    PlacedSource(
                        node,
                        at,
                        tuple(r for r in (*ramps, *own) if r.start < at + length and r.end > at),
                    )
                )
            case SequenceAudio():
                for child in (node.head, *node.tail):
                    visit(child, at, ramps)
                    at += duration(child)
            case CrossfadeAudio():
                seam = at + duration(node.left)
                visit(
                    node.left,
                    at,
                    (*ramps, GainRamp(seam - node.overlap_sec, seam, False, crossfade_curve)),
                )
                visit(
                    node.right,
                    seam - node.overlap_sec,
                    (*ramps, GainRamp(seam - node.overlap_sec, seam, True, crossfade_curve)),
                )
            case MixAudio():
                for placed in (node.head, *node.tail):
                    visit(placed.audio, at + placed.start_sec, ramps)
            case SilenceAudio():
                pass
            case MaskAudio() | OffSpeakerAudio():
                visit(node.body, at, ramps)

    visit(audio, 0.0, ())
    return result


def _audio_children(audio: Audio) -> tuple[Audio, ...]:
    match audio:
        case SourceAudio() | SilenceAudio():
            return ()
        case SequenceAudio():
            return (audio.head, *audio.tail)
        case CrossfadeAudio():
            return audio.left, audio.right
        case MixAudio():
            return (audio.head.audio, *(at.audio for at in audio.tail))
        case MaskAudio() | OffSpeakerAudio():
            return (audio.body,)


def postorder(audio: Audio) -> Iterator[Audio]:
    pending: list[tuple[Audio, bool]] = [(audio, False)]
    while pending:
        node, expanded = pending.pop()
        if expanded:
            yield node
            continue
        pending.append((node, True))
        pending.extend((child, False) for child in reversed(_audio_children(node)))


def duration(audio: Audio) -> float:
    durations: list[float] = []
    for node in postorder(audio):
        match node:
            case SourceAudio():
                durations.append(node.src_end - node.src_start)
            case SequenceAudio():
                child_count = len(node.tail) + 1
                child_durations = durations[-child_count:]
                del durations[-child_count:]
                durations.append(sum(child_durations))
            case CrossfadeAudio():
                right = durations.pop()
                left = durations.pop()
                durations.append(left + right - node.overlap_sec)
            case MixAudio():
                ats = (node.head, *node.tail)
                child_durations = durations[-len(ats) :]
                del durations[-len(ats) :]
                durations.append(
                    max(
                        at.start_sec + child_duration
                        for at, child_duration in zip(ats, child_durations, strict=True)
                    )
                )
            case SilenceAudio():
                durations.append(node.duration_sec)
            case MaskAudio() | OffSpeakerAudio():
                pass
    return durations[0]


def sources(audio: Audio) -> list[SourceAudio]:
    leaves: list[SourceAudio] = []
    for node in postorder(audio):
        if isinstance(node, SourceAudio):
            leaves.append(node)
    return leaves


def delay_frames(seconds: float, rate: int) -> int:
    """Whole samples a delay of ``seconds`` lands on at ``rate``, half up."""
    return math.floor(seconds * rate + 0.5)


def rescale_frames(frames: int, source_rate: int, target_rate: int) -> int:
    magnitude = (abs(frames) * target_rate + source_rate // 2) // source_rate
    return magnitude if frames >= 0 else -magnitude


@dataclass(frozen=True)
class ObservedAudio:
    sample_rate: int
    frames: int
    sample_fmt: str
    channel_layout: str


@dataclass(frozen=True)
class BoundaryClock:
    producer: ObservedAudio
    consumer: ObservedAudio


@dataclass(frozen=True)
class RenderClock:
    trims: tuple[BoundaryClock, ...]
    nodes: tuple[BoundaryClock, ...]
    seek_us: tuple[int, ...]
    output: ObservedAudio
    delays: tuple[tuple[int, int, BoundaryClock], ...] = ()


@dataclass(frozen=True)
class FrameTransform:
    source_rate: int
    target_rate: int
    offset: int = 0

    def apply(self, frame: int) -> int:
        return rescale_frames(frame, self.source_rate, self.target_rate) + self.offset


@dataclass(frozen=True)
class SourceFrameMapping:
    sample_rate: int
    origin: int
    transforms: tuple[FrameTransform, ...]

    def endpoint(self, seconds: float, *, ceil: bool = False) -> int:
        frame = (
            math.ceil(seconds * self.sample_rate)
            if ceil
            else math.floor(seconds * self.sample_rate + 0.5)
        ) - self.origin
        for transform in self.transforms:
            frame = transform.apply(frame)
        return frame


@dataclass(frozen=True)
class RenderedSource:
    source: SourceAudio
    source_first_frame: int
    source_last_frame: int
    source_sample_rate: int
    transforms: tuple[FrameTransform, ...]

    def frame(self, source_frame: int) -> int:
        for transform in self.transforms:
            source_frame = transform.apply(source_frame)
        return source_frame


@dataclass(frozen=True)
class _FrameLayout:
    clock: ObservedAudio
    sources: tuple[RenderedSource, ...]


def rendered_sources(audio: Audio, clock: RenderClock) -> tuple[RenderedSource, ...]:
    """Carry source coordinates through observed prepared counts and ordered placements."""
    expected = tuple(node for node in postorder(audio) if not isinstance(node, MaskAudio))
    if (
        len(clock.nodes) != len(expected)
        or len(clock.trims) != len(sources(audio))
        or len(clock.seek_us) != len(clock.trims)
    ):
        raise CodedValueError(
            "Bleed Restore clock entries are missing", code="bleed_restore_clock_invalid"
        )
    layouts: list[_FrameLayout] = []
    leaf_index = 0
    node_index = 0
    delays = {(node, child): boundary for node, child, boundary in clock.delays}

    def translated(
        placed: tuple[RenderedSource, ...], source_rate: int, rate: int, offset: int = 0
    ) -> tuple[RenderedSource, ...]:
        return tuple(
            RenderedSource(
                source.source,
                source.source_first_frame,
                source.source_last_frame,
                source.source_sample_rate,
                (*source.transforms, FrameTransform(source_rate, rate, offset)),
            )
            for source in placed
        )

    def require_rate(actual: int, expected: int) -> None:
        if actual != expected:
            raise CodedValueError(
                "Bleed Restore consumer clock differs", code="bleed_restore_clock_invalid"
            )

    for node in postorder(audio):
        if isinstance(node, MaskAudio):
            continue
        boundary = clock.nodes[node_index]
        current_index = node_index
        node_index += 1
        rate = boundary.producer.sample_rate
        placed: tuple[RenderedSource, ...]
        entries: list[RenderedSource] = []
        match node:
            case SourceAudio():
                trim = clock.trims[leaf_index].producer
                trim_rate = trim.sample_rate
                seek = MediaSeek(0, clock.seek_us[leaf_index], 0)
                first = seek.first_sample(node.src_start, trim_rate)
                last = min(seek.first_sample(node.src_end, trim_rate), first + trim.frames)
                leaf_index += 1
                placed = (
                    RenderedSource(
                        node,
                        first,
                        last,
                        trim_rate,
                        (
                            FrameTransform(trim_rate, trim_rate, -first),
                            FrameTransform(
                                trim_rate, clock.trims[leaf_index - 1].consumer.sample_rate
                            ),
                            FrameTransform(clock.trims[leaf_index - 1].consumer.sample_rate, rate),
                        ),
                    ),
                )
            case SilenceAudio():
                placed = ()
            case OffSpeakerAudio():
                child = layouts.pop()
                require_rate(child.clock.sample_rate, rate)
                placed = translated(child.sources, child.clock.sample_rate, rate)
            case SequenceAudio():
                count = len(node.tail) + 1
                children = layouts[-count:]
                del layouts[-count:]
                offset = 0
                entries = []
                for child in children:
                    require_rate(child.clock.sample_rate, rate)
                    entries.extend(translated(child.sources, child.clock.sample_rate, rate, offset))
                    offset += child.clock.frames
                placed = tuple(entries)
            case CrossfadeAudio():
                right, left = layouts.pop(), layouts.pop()
                require_rate(left.clock.sample_rate, rate)
                require_rate(right.clock.sample_rate, rate)
                overlap = MediaSeek.at(0, lead_sec=0.0).first_sample(node.overlap_sec, rate)
                placed = (
                    *translated(left.sources, left.clock.sample_rate, rate),
                    *translated(
                        right.sources, right.clock.sample_rate, rate, left.clock.frames - overlap
                    ),
                )
            case MixAudio():
                ats = (node.head, *node.tail)
                children = layouts[-len(ats) :]
                del layouts[-len(ats) :]
                entries = []
                for child_index, (at, child) in enumerate(zip(ats, children, strict=True)):
                    if at.start_sec > 0:
                        delay = delays[current_index, child_index]
                        require_rate(child.clock.sample_rate, delay.producer.sample_rate)
                        offset = delay_frames(at.start_sec, delay.producer.sample_rate)
                        delayed = translated(
                            child.sources,
                            child.clock.sample_rate,
                            delay.producer.sample_rate,
                            offset,
                        )
                        delayed = translated(
                            delayed, delay.producer.sample_rate, delay.consumer.sample_rate
                        )
                        require_rate(delay.consumer.sample_rate, rate)
                        entries.extend(translated(delayed, delay.consumer.sample_rate, rate))
                    else:
                        require_rate(child.clock.sample_rate, rate)
                        entries.extend(translated(child.sources, child.clock.sample_rate, rate))
                placed = tuple(entries)
        layouts.append(
            _FrameLayout(
                boundary.consumer,
                translated(placed, rate, boundary.consumer.sample_rate),
            )
        )
    return layouts[0].sources
