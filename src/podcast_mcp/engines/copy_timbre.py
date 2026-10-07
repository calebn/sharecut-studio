"""Whether a mic's sound carries another voice's fine spectrum, read at the copy lag.

A room copy keeps the harmonic and formant detail of the voice it copies; another
voice speaking into the mic does not. Frames are the copy grid of
``envelope_lag.copy_levels_db`` (100 ms on 10 ms hops). The bleed gate judges
fifth-of-a-second windows with it, and reconcile judges a word before reading
the word as another speaker's (#1052). Both confirm a copy lag with it first
(#1070).
"""

from __future__ import annotations

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
_SIMILARITY_CHUNK = 4096


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
    kernel = np.ones(TIMBRE_SMOOTH_BINS) / TIMBRE_SMOOTH_BINS
    smooth = np.apply_along_axis(np.convolve, 1, spectra, kernel, mode="same")
    fine = spectra - smooth
    fine -= fine.mean(axis=1, keepdims=True)
    return fine / (np.linalg.norm(fine, axis=1, keepdims=True) + 1e-12)


def copy_similarity(
    own: np.ndarray, peer: np.ndarray, frames: np.ndarray, lag: int, *, sample_rate: int
) -> np.ndarray:
    """Per ``own`` frame, how much its fine spectrum matches ``peer``'s ``lag`` hops later."""
    chunks = np.split(frames, range(_SIMILARITY_CHUNK, frames.size, _SIMILARITY_CHUNK))
    return np.concatenate(
        [
            np.sum(
                fine_spectra(own, chunk, sample_rate=sample_rate)
                * fine_spectra(peer, chunk + lag, sample_rate=sample_rate),
                axis=1,
            )
            for chunk in chunks
        ]
    )


def copy_likeness(similarity: np.ndarray) -> float:
    """The match a typical stretch of the copy reaches, from frames known to carry it."""
    return float(np.percentile(similarity, LIKENESS_PERCENTILE))


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
    laughing or chanting together do. A copy is the peer's voice, so it matches the
    peer's fine spectrum at the lag and not the peer's other syllables. Own sound
    matches both alike: another voice neither, a steady hum both. So the likeness must
    beat, by ``MIN_NULL_MARGIN`` as the level match must, the likeness the same frames
    reach against the peer's speech at the shifted nulls, read only where the peer
    talks at ``loud_db`` or more there too. A null where the peer is silent is the
    match against silence, 0.0.
    """
    likeness = copy_likeness(copy_similarity(own, peer, frames, lag, sample_rate=sample_rate))
    null = 0.0
    for shift in NULL_SHIFTS_SEC:
        moved = lag + round(shift / COPY_HOP_SEC)
        at = frames + moved
        inside = (at >= 0) & (at < peer_levels.size)
        talking = frames[inside][peer_levels[at[inside]] >= loud_db]
        if talking.size:
            similarity = copy_similarity(own, peer, talking, moved, sample_rate=sample_rate)
            null = max(null, copy_likeness(similarity))
    return likeness if likeness - null >= MIN_NULL_MARGIN else None
