"""Whether a mic's sound carries another voice's fine spectrum, read at the copy lag.

A room copy keeps the harmonic and formant detail of the voice it copies; another
voice speaking into the mic does not. Frames are the copy grid of
``envelope_lag.copy_levels_db`` (100 ms on 10 ms hops). The bleed gate judges
fifth-of-a-second windows with it, and reconcile judges a word before reading
the word as another speaker's (#1052).
"""

from __future__ import annotations

import numpy as np

from podcast_mcp.engines.envelope_lag import COPY_FRAME_SEC, COPY_HOP_SEC

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
