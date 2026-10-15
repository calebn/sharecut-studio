"""Whether a mic's sound carries another voice's fine spectrum, read at the copy lag.

A room copy keeps the harmonic and formant detail of the voice it copies; another
voice speaking into the mic does not. Frames are the copy grid of
``envelope_lag.copy_levels_db`` (100 ms on 10 ms hops). The bleed gate judges
fifth-of-a-second windows with it, and reconcile judges a word before reading
the word as another speaker's (#1052). Both confirm a copy lag with it first
(#1070).
"""

from __future__ import annotations

from functools import lru_cache

import numpy as np

from podcast_mcp.engines.envelope_lag import (
    COPY_FRAME_SEC,
    COPY_HOP_SEC,
    MIN_NULL_MARGIN,
    NULL_SHIFTS_SEC,
)

TIMBRE_BAND_HZ = (80, 3000)
TIMBRE_SMOOTH_BINS = 15
# A copy's likeness is this percentile of its frames' match, sampled on at most
# LIKENESS_FRAMES frames: the room and the call software blur and spread the match.
LIKENESS_PERCENTILE = 40
LIKENESS_FRAMES = 400
# A copy's timbre confirms its lag from at least MIN_CONFIRM_FRAMES frames (half a
# second at the copy's level): a percentile of fewer, against nulls of fewer still, is
# chance. True copies in the #1070 trials had 90 or more; one co-timed own voice
# passed on 6.
MIN_CONFIRM_FRAMES = 50
# A peer silent at every NULL_SHIFTS_SEC null (short bursts seconds apart) is compared
# against its speech at these farther shifts instead, pooled into one null because each
# shift reaches only a few of its frames; with no speech there, the lag is unconfirmed.
FAR_NULL_SHIFTS_SEC = tuple(float(sign * second) for second in range(3, 11) for sign in (-1, 1))
# The level lag is read on COPY_FRAME_SEC frames, and a call app's gate that opens late
# on every word moves its peak later; the timbre confirms it from the lag up to half a
# frame earlier where the copy's fine spectrum matches best.
TIMBRE_LAG_REACH = round(COPY_FRAME_SEC / 2 / COPY_HOP_SEC)
_SIMILARITY_CHUNK = 4096


@lru_cache(maxsize=8)
def _smoothing_matrix(bins: int) -> np.ndarray:
    """The moving average over ``TIMBRE_SMOOTH_BINS`` bins, zero beyond the band's edges.

    One matrix product smooths every frame at once; it is the same filter as convolving
    each frame's row with a flat kernel in ``same`` mode, to rounding.
    """
    index = np.arange(bins)
    reach = TIMBRE_SMOOTH_BINS // 2
    return (np.abs(index[:, None] - index[None, :]) <= reach) / TIMBRE_SMOOTH_BINS


def fine_spectra(samples: np.ndarray, frames: np.ndarray, *, sample_rate: int) -> np.ndarray:
    """Unit vectors of each level frame's log spectrum less its smooth envelope.

    What is left is the harmonic and formant detail of whoever is speaking, which a
    room copy keeps and another voice does not.
    """
    width = round(COPY_FRAME_SEC * sample_rate)
    hop = round(COPY_HOP_SEC * sample_rate)
    index = np.clip(frames[:, None] * hop + np.arange(width)[None, :], 0, max(0, samples.size - 1))
    band = slice(
        round(TIMBRE_BAND_HZ[0] * COPY_FRAME_SEC), round(TIMBRE_BAND_HZ[1] * COPY_FRAME_SEC)
    )
    window = np.hanning(width)
    padded = samples if samples.size else np.zeros(1)
    spectra = np.log(np.abs(np.fft.rfft(padded[index] * window, axis=1))[:, band] + 1e-9)
    smooth = spectra @ _smoothing_matrix(spectra.shape[1])
    fine = spectra - smooth
    fine -= fine.mean(axis=1, keepdims=True)
    return fine / (np.linalg.norm(fine, axis=1, keepdims=True) + 1e-12)


# Own spectra kept across a confirmation's lags and nulls: 230 float64 bins a frame, so at
# most about 40 MB. Longer frame runs read the own side again at each lag.
_OWN_FINE_MAX_FRAMES = 20_000


def _own_fine_spectra(
    own: np.ndarray, frames: np.ndarray, *, sample_rate: int
) -> np.ndarray | None:
    if frames.size > _OWN_FINE_MAX_FRAMES:
        return None
    return np.concatenate(
        [
            fine_spectra(own, chunk, sample_rate=sample_rate)
            for chunk in np.split(frames, range(_SIMILARITY_CHUNK, frames.size, _SIMILARITY_CHUNK))
        ]
    )


def copy_similarity(
    own: np.ndarray,
    peer: np.ndarray,
    frames: np.ndarray,
    lag: int,
    *,
    sample_rate: int,
    own_fine: np.ndarray | None = None,
) -> np.ndarray:
    """Per ``own`` frame, how much its fine spectrum matches ``peer``'s ``lag`` hops later.

    ``own_fine`` is ``fine_spectra(own, frames)`` when the caller already has it: the own
    side does not depend on the lag, so a caller that reads the same frames at several
    lags computes it once.
    """
    chunks = np.split(frames, range(_SIMILARITY_CHUNK, frames.size, _SIMILARITY_CHUNK))
    first = 0
    parts = []
    for chunk in chunks:
        mine = (
            fine_spectra(own, chunk, sample_rate=sample_rate)
            if own_fine is None
            else own_fine[first : first + chunk.size]
        )
        parts.append(
            np.sum(mine * fine_spectra(peer, chunk + lag, sample_rate=sample_rate), axis=1)
        )
        first += chunk.size
    return np.concatenate(parts)


def copy_likeness(similarity: np.ndarray) -> float:
    """The match a typical stretch of the copy reaches, from frames known to carry it."""
    return float(np.percentile(similarity, LIKENESS_PERCENTILE))


def _null_similarities(
    own: np.ndarray,
    peer: np.ndarray,
    frames: np.ndarray,
    lag: int,
    peer_levels: np.ndarray,
    loud_db: float,
    shifts: tuple[float, ...],
    *,
    sample_rate: int,
    own_fine: np.ndarray | None = None,
) -> list[np.ndarray]:
    """Per shift where the peer talks, ``frames``' match with it ``shift`` s off the lag."""
    matches = []
    for shift in shifts:
        moved = lag + round(shift / COPY_HOP_SEC)
        at = frames + moved
        inside = (at >= 0) & (at < peer_levels.size)
        talks = inside.copy()
        talks[inside] = peer_levels[at[inside]] >= loud_db
        talking = frames[talks]
        if talking.size:
            matches.append(
                copy_similarity(
                    own,
                    peer,
                    talking,
                    moved,
                    sample_rate=sample_rate,
                    own_fine=None if own_fine is None else own_fine[talks],
                )
            )
    return matches


def confirmed_likeness(
    own: np.ndarray,
    peer: np.ndarray,
    frames: np.ndarray,
    lag: int,
    peer_levels: np.ndarray,
    loud_db: float,
    *,
    sample_rate: int,
) -> float | None:
    """The copy's likeness on ``frames`` at ``lag``, or None when its timbre does not prove it.

    ``frames`` are ``own`` frames that carry the copy if there is one: the peer, at the
    lag, talks at ``loud_db`` or more (``peer_levels`` on the copy grid). Level alone
    cannot tell a copy from own sound that starts and stops with the peer's, as people
    laughing together do. A copy is the peer's voice, so it matches the peer's fine
    spectrum at the lag and not the peer's other syllables. Own sound at its own pitch
    matches both alike: another voice neither, a steady hum both. So the likeness must
    beat, by ``MIN_NULL_MARGIN`` as the level match must, the likeness the same frames
    reach against the peer's speech at the shifted nulls, read only where the peer
    talks at ``loud_db`` or more there too. A null under 0 counts as 0, so the likeness
    itself must reach the margin. When the peer is silent at every null a second or two
    away (it speaks in short bursts far apart), the comparison is its speech 3 to 10 s
    away, pooled into one null; with no peer speech there either, nothing proves the
    lag and there is no copy. Nor is there one on fewer than ``MIN_CONFIRM_FRAMES``
    frames.

    The level lag is only as sharp as a level frame, and the peer's gate opening late on
    every word moves it later (60 ms for a synthetic gate 180 ms late on every word). A
    gate never opens early, so the likeness and its nulls are read at the lag from half
    a frame before ``lag`` up to ``lag`` where the likeness is highest. The likeness
    returned is the one at ``lag``, where the gate reads the copy.

    Own sound whose pitch follows the peer's (singing in unison, speaking along at the
    peer's pitch) matches the peer's fine spectrum at the lag as a copy does, and passes
    (#1190). A copy of a peer whose other syllables share its spectrum (a near-monotone
    talker, a repeated phrase) can fail; the bleed is then kept, the safe side.
    """
    if frames.size < MIN_CONFIRM_FRAMES:
        return None
    own_fine = _own_fine_spectra(own, frames, sample_rate=sample_rate)
    likenesses = {
        shifted: copy_likeness(
            copy_similarity(own, peer, frames, shifted, sample_rate=sample_rate, own_fine=own_fine)
        )
        for shifted in range(lag - TIMBRE_LAG_REACH, lag + 1)
    }
    best = max(likenesses, key=likenesses.__getitem__)
    args = (own, peer, frames, best, peer_levels, loud_db)
    near = _null_similarities(*args, NULL_SHIFTS_SEC, sample_rate=sample_rate, own_fine=own_fine)
    if near:
        null = max(copy_likeness(match) for match in near)
    else:
        far = _null_similarities(
            *args, FAR_NULL_SHIFTS_SEC, sample_rate=sample_rate, own_fine=own_fine
        )
        if not far:
            return None
        null = copy_likeness(np.concatenate(far))
    confirmed = likenesses[best] - max(0.0, null) >= MIN_NULL_MARGIN
    return likenesses[lag] if confirmed else None
