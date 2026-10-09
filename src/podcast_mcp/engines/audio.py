"""Pure audio expressions with explicit connected joins and placement."""

from __future__ import annotations

import math
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


def duration(audio: Audio) -> float:
    match audio:
        case SourceAudio():
            return audio.src_end - audio.src_start
        case SequenceAudio():
            return duration(audio.head) + sum(duration(child) for child in audio.tail)
        case CrossfadeAudio():
            return duration(audio.left) + duration(audio.right) - audio.overlap_sec
        case MixAudio():
            return max(at.start_sec + duration(at.audio) for at in (audio.head, *audio.tail))
        case SilenceAudio():
            return audio.duration_sec


def sources(audio: Audio) -> list[SourceAudio]:
    match audio:
        case SourceAudio():
            return [audio]
        case SequenceAudio():
            return [leaf for child in (audio.head, *audio.tail) for leaf in sources(child)]
        case CrossfadeAudio():
            return sources(audio.left) + sources(audio.right)
        case MixAudio():
            return [leaf for at in (audio.head, *audio.tail) for leaf in sources(at.audio)]
        case SilenceAudio():
            return []
