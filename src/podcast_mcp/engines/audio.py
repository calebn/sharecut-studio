from __future__ import annotations

import math
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class MuteSampleEnvelope:
    """A render envelope on its source sample grid."""

    first: int
    last: int
    fade_out: int
    fade_in: int

    def silent_span(self) -> tuple[int, int]:
        """Half-open sample run whose generated gain is exactly zero."""
        if self.fade_out + self.fade_in > self.last - self.first:
            return self.first, self.last
        return self.first + self.fade_out, self.last - self.fade_in + 1


@dataclass(frozen=True)
class RequestedExtent:
    seconds: float


@dataclass(frozen=True)
class MuteEnvelope:
    """One muted region's gain, in seconds from a render window's start.

    The gain falls to zero over the first ``fade_out_sec`` of ``[start, end)``, stays
    there and rises back to one over its last ``fade_in_sec``.
    """

    start: float
    end: float
    fade_out_sec: float
    fade_in_sec: float

    def samples(
        self, sample_rate: int, *, source_start: float = 0.0, origin: int = 0
    ) -> MuteSampleEnvelope:
        return MuteSampleEnvelope(
            math.floor((self.start + source_start) * sample_rate + 0.5) - origin,
            math.floor((self.end + source_start) * sample_rate + 0.5) - origin,
            math.floor(self.fade_out_sec * sample_rate + 0.5),
            math.floor(self.fade_in_sec * sample_rate + 0.5),
        )


@dataclass(frozen=True)
class SourceAudio:
    path: Path
    src_start: float
    src_end: float
    fade_in_sec: float = 0.0
    fade_out_sec: float = 0.0
    mute_spans: tuple[MuteEnvelope, ...] = ()
    fill_path: Path | None = None


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


Audio = SourceAudio | SequenceAudio | CrossfadeAudio | MixAudio | SilenceAudio


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
    return durations[0]


def sources(audio: Audio) -> list[SourceAudio]:
    leaves: list[SourceAudio] = []
    for node in postorder(audio):
        if isinstance(node, SourceAudio):
            leaves.append(node)
    return leaves
