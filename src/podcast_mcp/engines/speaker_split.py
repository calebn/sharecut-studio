"""Who talks when on one recording of several speakers, for a split into lanes (#1095).

The speaker count is known (the user says it), so attribution is a k-way clustering of
voice embeddings, not diarization that has to guess how many people there are:

1. The bundled voice detector marks voiced 20 ms frames.
2. Windows of ``window_sec`` every ``HOP_SEC`` that are at least ``MIN_VOICED_SHARE``
   voiced are embedded by the speaker backend (ECAPA or Resemblyzer).
3. One centroid per speaker. An enrolled speaker (a few seconds the user confirmed)
   starts from their spans; every other speaker from k-means++ seeds placed away from
   those, so enrolling some speakers and not others still works. Either way k-means
   then refines them over the whole recording, so a short enrollment only names and
   seeds the speakers.
4. Each frame scores every speaker by the mean cosine of the windows covering it.
5. A Viterbi pass over the frame scores picks one speaker per frame. Changing speaker
   costs ``VOICED_SWITCH`` inside voiced frames and ``PAUSE_SWITCH`` in a pause.
Turns are runs of one speaker and cover the recording with no gaps: a pause belongs to
the turn the passes put it in, so splitting along turns sums back to the input.

A speaker count higher than the people talking makes k-means split one voice in two.
Two speakers whose centroids sit much closer together than the other speakers' do
(``SAME_VOICE_RATIO`` of the median distance between the other pairs, measured in this
recording) are reported in ``SpeakerAttribution.same_voice`` as likely one person. With
two speakers there is no other pair to compare against, so nothing is reported.

Crosstalk is a turn where the runner-up sounds present as well (``_presence``) for at
least ``window_sec``, or a hand-over settlement left inside a voiced run. A turn's confidence is how far its winner stands above the
runner-up on that same scale. On the lab tape this evidence was weak (see
docs/multitrack-ingest.md § Split one recording by speaker): two voices at once look
like neither speaker to a voice embedding, and most overlap there is shorter than any
window that can still name a speaker.
"""

from __future__ import annotations

import itertools
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

import numpy as np

from podcast_mcp.engines.speaker_hand_overs import frame_levels, settle_hand_overs, voice_runs
from podcast_mcp.engines.speaker_id import SpeakerBackend
from podcast_mcp.util.dsp import bool_runs
from podcast_mcp.util.progress import ProgressReporter, resolve_progress_task

RATE = 16000
FRAME_SEC = 0.02
HOP_SEC = 0.25
WINDOW_SEC = 1.0
MIN_VOICED_SHARE = 0.3
VOICED_PROB = 0.5
# Cosine is scaled by 1/TEMPERATURE into log-odds per frame; switch costs are in the
# same units, so a hand-over inside speech needs about 0.4 of cosine margin summed
# over its frames, and in a pause about 0.05.
TEMPERATURE = 0.05
VOICED_SWITCH = 8.0
PAUSE_SWITCH = 1.0
# A runner-up at least halfway from its absent level to its present level, held for a
# whole window, is talking too.
CROSSTALK_PRESENCE = 0.5
KMEANS_RESTARTS = 10
KMEANS_ITERATIONS = 50
# One voice split in two sits at a fraction of the distance between different people;
# two similar voices beside a third stay above it (docs/multitrack-ingest.md).
SAME_VOICE_RATIO = 0.4

Span = tuple[float, float]


@dataclass(frozen=True)
class SpeakerTurn:
    """``[start, end)`` source seconds; ``speakers`` most likely first, two or more = crosstalk."""

    start: float
    end: float
    speakers: tuple[int, ...]
    confidence: float

    @property
    def crosstalk(self) -> bool:
        return len(self.speakers) > 1


@dataclass(frozen=True)
class SameVoice:
    """Two speakers who likely are one person: cosine distances between centroids."""

    speakers: tuple[int, int]
    distance: float
    others: float
    """Median distance between every other pair of speakers in the recording."""


@dataclass(frozen=True)
class SpeakerAttribution:
    speaker_count: int
    duration: float
    turns: tuple[SpeakerTurn, ...]
    backend: str
    method: Literal["enroll", "cluster"]
    same_voice: tuple[SameVoice, ...] = ()


def _unit(x: np.ndarray) -> np.ndarray:
    return x / (np.linalg.norm(x, axis=-1, keepdims=True) + 1e-9)


def voiced_frames(samples: np.ndarray) -> np.ndarray | None:
    """Actual detector decisions per 20 ms frame, or ``None`` when unavailable."""
    from podcast_mcp.engines.vad_silero import get_shared_vad

    count = samples.size // round(FRAME_SEC * RATE)
    vad = get_shared_vad()
    if vad is None:
        return None
    if count == 0:
        return np.zeros(0, dtype=bool)
    probs = vad.speech_probs(samples.astype(np.float32))
    step = vad.WINDOW_SAMPLES / RATE
    index = np.minimum((np.arange(count) * FRAME_SEC / step).astype(int), probs.size - 1)
    return probs[index] >= VOICED_PROB


def _window_centers(voiced: np.ndarray, duration: float, window_sec: float) -> np.ndarray:
    centers = np.arange(window_sec / 2, duration - window_sec / 2 + 1e-9, HOP_SEC)
    if centers.size == 0:
        return np.array([duration / 2]) if duration > 0 else centers
    half = round(window_sec / 2 / FRAME_SEC)
    mid = np.round(centers / FRAME_SEC).astype(int)
    cumulative = np.concatenate([[0], np.cumsum(voiced)])
    lo, hi = np.clip(mid - half, 0, voiced.size), np.clip(mid + half, 0, voiced.size)
    share = (cumulative[hi] - cumulative[lo]) / np.maximum(hi - lo, 1)
    return centers[share >= MIN_VOICED_SHARE]


def _embed(
    samples: np.ndarray, centers: np.ndarray, window_sec: float, backend: SpeakerBackend
) -> np.ndarray:
    width = round(window_sec * RATE)
    starts = np.clip(np.round((centers - window_sec / 2) * RATE).astype(int), 0, None)
    return _unit(np.stack([backend.embed(samples[s : s + width], RATE) for s in starts]))


def _enrollment_centroids(
    samples: np.ndarray,
    enrollment: Mapping[int, Sequence[Span]],
    window_sec: float,
    backend: SpeakerBackend,
) -> dict[int, np.ndarray]:
    centroids = {}
    for speaker, spans in enrollment.items():
        centers = [
            c
            for start, end in spans
            for c in np.arange(
                start + window_sec / 2, end - window_sec / 2 + 1e-9, HOP_SEC
            ).tolist()
            or [(start + end) / 2]
        ]
        if centers:
            embeddings = _embed(samples, np.array(centers), window_sec, backend)
            centroids[speaker] = _unit(embeddings.mean(axis=0))
    return centroids


def _kmeans_seeds(
    embeddings: np.ndarray, fixed: list[np.ndarray], count: int, rng: np.random.Generator
) -> list[np.ndarray]:
    """k-means++ seeds after ``fixed`` up to ``count``; returns only the new ones."""
    seeds = list(fixed) or [embeddings[rng.integers(len(embeddings))]]
    while len(seeds) < count:
        distance = np.maximum(1 - np.max(embeddings @ np.stack(seeds).T, axis=1), 0) ** 2
        total = distance.sum()
        pick = rng.choice(len(embeddings), p=distance / total) if total > 0 else 0
        seeds.append(embeddings[pick])
    return seeds[len(fixed) :]


def _refine(embeddings: np.ndarray, centroids: np.ndarray) -> tuple[np.ndarray, float]:
    """Spherical k-means from ``centroids``; returns them and their total distance."""
    for _ in range(KMEANS_ITERATIONS):
        labels = np.argmax(embeddings @ centroids.T, axis=1)
        moved = np.stack(
            [
                _unit(embeddings[labels == j].mean(axis=0)) if (labels == j).any() else c
                for j, c in enumerate(centroids)
            ]
        )
        if np.allclose(moved, centroids):
            break
        centroids = moved
    return centroids, float(np.sum(1 - np.max(embeddings @ centroids.T, axis=1)))


def _cluster(embeddings: np.ndarray, count: int, enrolled: Mapping[int, np.ndarray]) -> np.ndarray:
    """Enrolled speakers start from their own centroid, the rest from k-means++ seeds."""
    free = [s for s in range(count) if s not in enrolled]
    rng = np.random.default_rng(0)
    best: tuple[float, np.ndarray] | None = None
    for _ in range(KMEANS_RESTARTS if free else 1):
        seeds = np.zeros((count, embeddings.shape[1]), dtype=embeddings.dtype)
        for speaker, centroid in enrolled.items():
            seeds[speaker] = centroid
        if free:
            seeds[free] = np.stack(_kmeans_seeds(embeddings, list(enrolled.values()), count, rng))
        centroids, cost = _refine(embeddings, seeds)
        if best is None or cost < best[0]:
            best = (cost, centroids)
    assert best is not None
    return best[1]


def _same_voice(centroids: np.ndarray) -> tuple[SameVoice, ...]:
    """Pairs of speakers far closer together than the other pairs: one voice split in two."""
    distance = 1 - centroids @ centroids.T
    pairs = list(itertools.combinations(range(len(centroids)), 2))
    found = []
    for a, b in pairs:
        others = [float(distance[p]) for p in pairs if p != (a, b)]
        if others and distance[a, b] < SAME_VOICE_RATIO * float(np.median(others)):
            found.append(
                SameVoice(
                    speakers=(a, b),
                    distance=round(float(distance[a, b]), 3),
                    others=round(float(np.median(others)), 3),
                )
            )
    return tuple(found)


def _frame_scores(
    centers: np.ndarray, scores: np.ndarray, frames: int, window_sec: float
) -> np.ndarray:
    """Mean score of the windows covering each frame, else of the nearest window."""
    t = (np.arange(frames) + 0.5) * FRAME_SEC
    lo = np.searchsorted(centers, t - window_sec / 2)
    hi = np.searchsorted(centers, t + window_sec / 2)
    cumulative = np.vstack([np.zeros((1, scores.shape[1])), np.cumsum(scores, axis=0)])
    covered = (hi - lo)[:, None]
    mean = (cumulative[hi] - cumulative[lo]) / np.maximum(covered, 1)
    nearest = np.clip(np.searchsorted(centers, t), 1, len(centers) - 1) if len(centers) > 1 else 0
    if len(centers) > 1:
        left = np.abs(t - centers[nearest - 1]) <= np.abs(centers[nearest] - t)
        nearest = np.where(left, nearest - 1, nearest)
    return np.where(covered > 0, mean, scores[nearest])


def _viterbi(log_odds: np.ndarray, switch: np.ndarray) -> np.ndarray:
    frames, states = log_odds.shape
    back = np.zeros((frames, states), dtype=np.int32)
    value = log_odds[0].copy()
    for i in range(1, frames):
        leader = int(np.argmax(value))
        move = value[leader] - switch[i]
        jump = move > value
        back[i] = np.where(jump, leader, np.arange(states))
        value = np.where(jump, move, value) + log_odds[i]
    path = np.zeros(frames, dtype=np.int32)
    path[-1] = int(np.argmax(value))
    for i in range(frames - 1, 0, -1):
        path[i - 1] = back[i, path[i]]
    return path


def _presence(labels: np.ndarray, scores: np.ndarray) -> np.ndarray:
    """Scores rescaled per speaker: 0 at their median where they are not chosen, 1 where they are.

    Each speaker's cosine levels depend on the voice and the backend, so a runner-up is
    judged against its own levels in this recording, not a fixed cosine.
    """
    presence = np.zeros_like(scores)
    for speaker in range(scores.shape[1]):
        mine = labels == speaker
        present = float(np.median(scores[mine, speaker])) if mine.any() else 1.0
        absent = float(np.median(scores[~mine, speaker])) if (~mine).any() else 0.0
        presence[:, speaker] = (scores[:, speaker] - absent) / max(present - absent, 1e-6)
    return presence


def _turns(
    labels: np.ndarray,
    scores: np.ndarray,
    duration: float,
    window_sec: float,
    overlap: np.ndarray,
) -> tuple[SpeakerTurn, ...]:
    """Runs of one speaker, with the runner-up added where it sounds present too.

    ``overlap`` names, per frame, the other speaker of a hand-over left inside a voiced
    run (-1 for none): those frames are crosstalk with that speaker.
    """
    rows = np.arange(labels.size)
    presence = _presence(labels, scores)
    best = presence[rows, labels]
    others = presence.copy()
    others[rows, labels] = -np.inf
    runner = np.argmax(others, axis=1)
    least = round(window_sec / FRAME_SEC)
    crosstalk = np.zeros(labels.size, dtype=bool)
    for lo, hi in bool_runs(others[rows, runner] >= CROSSTALK_PRESENCE):
        if hi - lo >= least:
            crosstalk[lo:hi] = True
    crosstalk |= overlap >= 0
    runner = np.where(overlap >= 0, overlap, runner)
    second = others[rows, runner]
    change = np.flatnonzero(
        (np.diff(labels) != 0)
        | (np.diff(crosstalk) != 0)
        | (crosstalk[1:] & (np.diff(runner) != 0))
    )
    bounds = [0, *(change + 1).tolist(), labels.size]
    turns = []
    for lo, hi in itertools.pairwise(bounds):
        speaker = int(labels[lo])
        margin = float(np.mean(best[lo:hi] - second[lo:hi]))
        turns.append(
            SpeakerTurn(
                start=round(lo * FRAME_SEC, 3),
                end=round(duration if hi == labels.size else hi * FRAME_SEC, 3),
                speakers=(speaker, int(runner[lo])) if crosstalk[lo] else (speaker,),
                confidence=float(np.clip(margin, 0.0, 1.0)),
            )
        )
    return tuple(turns)


def _first_appearance_order(labels: np.ndarray, count: int, enrolled: Sequence[int]) -> np.ndarray:
    """Old speaker per new index: enrolled speakers keep theirs, the rest go by who talks first."""
    free = [s for s in range(count) if s not in enrolled]
    firsts = {s: np.flatnonzero(labels == s) for s in free}
    order = np.arange(count)
    order[free] = sorted(free, key=lambda s: firsts[s][0] if firsts[s].size else math.inf)
    return order


def attribute_speakers(
    samples: np.ndarray,
    *,
    speaker_count: int,
    backend: SpeakerBackend,
    enrollment: Mapping[int, Sequence[Span]] | None = None,
    window_sec: float = WINDOW_SEC,
    progress: ProgressReporter | None = None,
) -> SpeakerAttribution:
    """Speaker turns of mono ``samples`` at :data:`RATE`, covering the whole recording.

    ``enrollment`` maps a speaker index to spans that are only that speaker, for some
    or all speakers; speaker ``i`` is then the enrolled one. The other speakers take
    the remaining indices in the order they first talk.
    """
    if speaker_count < 2:
        raise ValueError("a speaker split needs at least two speakers")
    if enrollment and not set(enrollment) <= set(range(speaker_count)):
        raise ValueError(f"enrolled speakers must be numbered 0 to {speaker_count - 1}")
    duration = samples.size / RATE
    frames = samples.size // round(FRAME_SEC * RATE)
    if frames == 0:
        raise ValueError("recording is too short to split")
    with resolve_progress_task(
        "speaker-split", "Speaker split", total=3, prefer_parent=True, progress=progress
    ) as task:
        detected = voiced_frames(samples)
        voiced = np.ones(frames, dtype=bool) if detected is None else detected
        centers = _window_centers(voiced, duration, window_sec)
        if centers.size < speaker_count:
            raise ValueError("too little speech to tell the speakers apart")
        task.message(f"Embedding {centers.size} windows")
        embeddings = _embed(samples, centers, window_sec, backend)
        task.advance(1)
        enrolled = _enrollment_centroids(samples, enrollment or {}, window_sec, backend)
        centroids = _cluster(embeddings, speaker_count, enrolled)
        task.advance(1)
        scores = _frame_scores(centers, embeddings @ centroids.T, frames, window_sec)
        switch = np.where(voiced, VOICED_SWITCH, PAUSE_SWITCH)
        labels = _viterbi(scores / TEMPERATURE, switch)
        hop = round(FRAME_SEC * RATE)
        levels = frame_levels(samples, hop)

        def own(lo: int, hi: int) -> np.ndarray:
            embedding = _unit(np.asarray(backend.embed(samples[lo * hop : hi * hop], RATE)))
            return np.asarray(embedding @ centroids.T)

        labels, overlap = settle_hand_overs(
            labels,
            scores,
            levels,
            voice_runs(levels, labels, detected),
            own,
            reach=round(window_sec / FRAME_SEC),
        )
        order = _first_appearance_order(labels, speaker_count, list(enrolled))
        rename = np.argsort(order)
        labels, scores = rename[labels], scores[:, order]
        overlap = np.where(overlap >= 0, rename[np.maximum(overlap, 0)], -1)
        task.advance(1)
    return SpeakerAttribution(
        speaker_count=speaker_count,
        duration=duration,
        turns=_turns(labels, scores, duration, window_sec, overlap),
        backend=backend.name(),
        method="enroll" if enrolled else "cluster",
        same_voice=_same_voice(centroids[order]),
    )
