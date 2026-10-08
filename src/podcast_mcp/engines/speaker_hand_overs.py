"""Settle speaker hand-overs into pauses, so a turn keeps its whole voiced run (#1095).

The speaker split scores each 20 ms frame by the mean of the 1 s windows covering it.
A turn shorter than a window has its evidence smeared over the pauses beside it, and a
hand-over costs less in a pause than in speech, so the Viterbi pass can park a short
turn in the silence next to its own voice, or end it inside its voiced run. Both put
part of one person's words on another person's lane.

"""

from __future__ import annotations

import itertools
from collections.abc import Callable, Sequence

import numpy as np

from podcast_mcp.util.dsp import bool_runs, bridge_short_dips, frame_rms_db

FRAME_SEC = 0.02
SILENCE_DB = -200.0
QUIET_SHARE = 0.5
FLOOR_PERCENTILE = 10
MIN_RANGE_DB = 6.0
"""Less than this between floor and speech: no measurable pauses, nothing moves."""
MIN_RUN_SEC = 0.06
"""Louder blips shorter than this are clicks, not a voiced run; quieter dips shorter
than this are a stop inside a word, not a pause."""
MIN_EMBED_SEC = 0.3
"""Shorter spans are too short to embed and keep their window scores."""

Run = tuple[int, int]
OwnScores = Callable[[int, int], np.ndarray]
"""Cosine of frames ``[lo, hi)`` embedded on their own to each speaker's centroid."""


def frame_levels(samples: np.ndarray, hop: int) -> np.ndarray:
    """dB level of each whole ``hop``-sample frame; digital silence reads ``SILENCE_DB``."""
    return frame_rms_db(samples[: samples.size // hop * hop], hop, hop, floor_db=SILENCE_DB)


def voice_runs(levels: np.ndarray, labels: np.ndarray, detected: np.ndarray | None) -> list[Run]:
    """Fixed voiced spans from global levels, provisional clusters, and actual VAD.

    All arrays share the frame shape. ``None`` means the detector is unavailable.
    Global and cluster midpoints use non-digital floor samples and median speech
    levels. Actual detector-positive sound joins their union when contrast is
    measurable. Without a detector, a cluster must supply its own level contrast.
    Dips under ``MIN_RUN_SEC`` bridge and shorter runs disappear.
    """
    sound = levels > SILENCE_DB
    if not sound.any():
        return []
    least = max(1, round(MIN_RUN_SEC / FRAME_SEC))
    floor = float(np.percentile(levels[sound], FLOOR_PERCENTILE))
    eligible = sound if detected is None else sound & detected
    talk = levels[eligible]
    speech = float(np.median(talk)) if talk.size else float(np.percentile(levels[sound], 90))
    measurable = speech - floor >= MIN_RANGE_DB
    voice = (
        sound & (levels >= floor + QUIET_SHARE * (speech - floor))
        if measurable
        else np.zeros(levels.size, dtype=bool)
    )
    within_cluster_contrast = False
    for speaker in np.unique(labels):
        member = sound & (labels == speaker)
        local_talk = levels[member & eligible]
        if local_talk.size < least:
            continue
        local_floor = float(np.percentile(levels[member], FLOOR_PERCENTILE))
        local_speech = float(np.median(local_talk))
        within_cluster_contrast |= local_speech - local_floor >= MIN_RANGE_DB
        shared_floor = min(floor, local_floor)
        if local_speech - shared_floor >= MIN_RANGE_DB:
            measurable = True
            voice |= member & (levels >= shared_floor + QUIET_SHARE * (local_speech - shared_floor))
    if not measurable or (detected is None and not within_cluster_contrast):
        return []
    if detected is not None:
        voice |= sound & detected
    voice = bridge_short_dips(voice, least - 1)
    return [(lo, hi) for lo, hi in bool_runs(voice) if hi - lo >= least]


def _next_change(labels: np.ndarray, start: int) -> int:
    """First frame at or after ``start`` whose speaker differs from the frame before it."""
    found = np.flatnonzero(labels[start:] != labels[start - 1 : -1])
    return start + int(found[0]) if found.size else labels.size


def _quietest_cut(levels: np.ndarray, first: int, last: int, near: int) -> int:
    """Cut in ``[first, last]`` with the quietest frames either side; ties go nearest ``near``."""
    cuts = np.arange(first, last + 1)
    loudness = np.round(np.maximum(levels[cuts - 1], levels[np.minimum(cuts, levels.size - 1)]))
    return int(cuts[np.lexsort((np.abs(cuts - near), loudness))[0]])


class _Settler:
    """One left-to-right pass over the hand-overs; see the module docstring."""

    def __init__(
        self,
        labels: np.ndarray,
        scores: np.ndarray,
        levels: np.ndarray,
        runs: Sequence[Run],
        own: OwnScores,
    ) -> None:
        self.labels = labels.copy()
        self.scores = scores
        self.levels = levels
        self.runs = list(runs)
        self.own = own
        self.run_of = np.full(labels.size, -1, dtype=np.int64)
        for index, (lo, hi) in enumerate(self.runs):
            self.run_of[lo:hi] = index
        self.voice = self.run_of >= 0
        self.pause_runs = bool_runs(~self.voice)
        self.pause_starts = np.array([lo for lo, _ in self.pause_runs], dtype=np.int64)
        self.overlap = np.full(labels.size, -1, dtype=np.int64)
        self._evidence: dict[int, np.ndarray] = {}

    def span(self, lo: int, hi: int) -> np.ndarray:
        """Cosine of frames ``[lo, hi)`` to each speaker (see the module docstring)."""
        windows = self.scores[lo:hi].mean(axis=0)
        if hi - lo < round(MIN_EMBED_SEC / FRAME_SEC):
            return windows
        return (np.asarray(self.own(lo, hi)) + windows) / 2

    def evidence(self, run: int) -> np.ndarray:
        if run not in self._evidence:
            self._evidence[run] = self.span(*self.runs[run])
        return self._evidence[run]

    def gain(self, at: int, cut: int, left: int, right: int) -> float:
        """Evidence for the voice between ``at`` and ``cut`` changing sides."""
        lo, hi = sorted((at, cut))
        old, new = (right, left) if cut > at else (left, right)
        runs, counts = np.unique(self.run_of[lo:hi][self.voice[lo:hi]], return_counts=True)
        return float(
            sum(
                count * (self.evidence(int(run))[new] - self.evidence(int(run))[old])
                for run, count in zip(runs, counts, strict=True)
            )
        )

    def pause(self, cut: int) -> Run:
        """``[first, last]`` cuts of the pause holding ``cut``, which is not inside a run.

        A pause of frames ``[lo, hi)`` takes cuts ``lo`` (just after the run before it)
        to ``hi`` (just before the run after it).
        """
        frame = cut - 1 if not self.voice[cut - 1] else cut
        index = int(np.searchsorted(self.pause_starts, frame, side="right")) - 1
        return self.pause_runs[index]

    def pauses(self, first: int, last: int) -> list[Run]:
        """Cut ranges of the pauses with a cut in ``[first, last]``, clipped to it."""
        found = []
        start = max(int(np.searchsorted(self.pause_starts, first, side="right")) - 1, 0)
        for lo, hi in self.pause_runs[start:]:
            if lo > last:
                break
            if max(first, lo) <= min(last, hi):
                found.append((max(first, lo), min(last, hi)))
        return found

    def settle(self, reach: int) -> tuple[np.ndarray, np.ndarray]:
        labels, voice = self.labels, self.voice
        previous, at = 0, _next_change(labels, 1)
        while at < labels.size:
            left, right = int(labels[at - 1]), int(labels[at])
            after = _next_change(labels, at + 1)
            first, last = max(previous + 1, at - reach), min(after - 1, at + reach)
            if voice[at - 1] and voice[at]:
                cut = self.out_of_run(at, first, last, left, right)
                if cut is None:
                    self.flag_overlap(at, reach // 4, previous, after)
                    cut = at
            elif min(voice[previous:at].sum(), voice[at:after].sum()) < reach:
                cut = self.short_turn(at, first, last, left, right)
            else:
                cut = self.snap(at, first, last)
            if cut < at:
                labels[cut:at] = right
            elif cut > at:
                labels[at:cut] = left
            previous, at = cut, after
        self.dissolve_voiceless()
        return labels, self.overlap

    def out_of_run(self, at: int, first: int, last: int, left: int, right: int) -> int | None:
        """The pause beside the run holding ``at`` that its pieces' evidence favours.

        Moving the cut before the run gives the run's left piece to ``right``; after it,
        the right piece to ``left``. None when neither move gains (each piece sounds
        like its own side) or neither pause is within reach.
        """
        lo, hi = self.runs[int(self.run_of[at])]
        options = []
        before, after = self.pauses(first, lo), self.pauses(hi, last)
        if before and before[-1][1] == lo:
            evidence = self.span(lo, at)
            gain = (at - lo) * float(evidence[right] - evidence[left])
            options.append((gain, _quietest_cut(self.levels, *before[-1], at)))
        if after and after[0][0] == hi:
            evidence = self.span(at, hi)
            gain = (hi - at) * float(evidence[left] - evidence[right])
            options.append((gain, _quietest_cut(self.levels, *after[0], at)))
        best = max(options, default=None)
        if best is None:
            return None
        too_short_for_two = hi - lo < round(MIN_EMBED_SEC / FRAME_SEC)
        return best[1] if best[0] > 0 or too_short_for_two else None

    def short_turn(self, at: int, first: int, last: int, left: int, right: int) -> int:
        """Move a hand-over beside a short turn only where the moved runs' evidence gains."""
        options = [
            (self.gain(at, cut, left, right), cut)
            for cut in (_quietest_cut(self.levels, a, b, at) for a, b in self.pauses(first, last))
        ]
        gain, cut = max(options, key=lambda option: (option[0], -abs(option[1] - at)))
        return cut if gain > 0 else self.snap(at, first, last)

    def snap(self, at: int, first: int, last: int) -> int:
        lo, hi = self.pause(at)
        return _quietest_cut(self.levels, max(first, lo), min(last, hi), at)

    def flag_overlap(self, at: int, reach: int, previous: int, after: int) -> None:
        """Mark the other speaker on the run's frames within ``reach`` of cut ``at``."""
        lo, hi = self.runs[int(self.run_of[at])]
        self.overlap[max(lo, previous, at - reach) : at] = self.labels[at]
        self.overlap[at : min(hi, after, at + reach)] = self.labels[at - 1]

    def dissolve_voiceless(self) -> None:
        """A turn without voice carries no evidence of who talks: it joins its neighbours."""
        labels = self.labels
        bounds = [0, *(np.flatnonzero(np.diff(labels) != 0) + 1).tolist(), labels.size]
        for lo, hi in itertools.pairwise(bounds):
            if self.voice[lo:hi].any() or (lo == 0 and hi == labels.size):
                continue
            left = int(labels[lo - 1]) if lo > 0 else int(labels[hi])
            right = int(labels[hi]) if hi < labels.size else left
            cut = hi if left == right else _quietest_cut(self.levels, lo, hi, (lo + hi) // 2)
            labels[lo:cut], labels[cut:hi] = left, right


def settle_hand_overs(
    labels: np.ndarray,
    scores: np.ndarray,
    levels: np.ndarray,
    runs: Sequence[Run],
    own: OwnScores,
    reach: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Speaker per frame with hand-overs in pauses, and the crosstalk this leaves.

    ``labels`` is the speaker per frame, ``scores`` each frame's window cosine to each
    speaker, ``levels`` the dB level per frame and ``runs`` the voiced runs
    (:func:`voice_runs`). ``reach`` is how far, in frames, a hand-over may move: one
    window, the attribution's resolution. The second array names, per frame, the other
    speaker of a hand-over that stayed inside a run with no pause near it (-1 for none).
    """
    if not runs or labels.size < 2:
        return labels.copy(), np.full(labels.size, -1, dtype=np.int64)
    return _Settler(labels, scores, levels, runs, own).settle(reach)
