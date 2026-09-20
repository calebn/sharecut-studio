"""Spectral join-cost measures from concatenative TTS literature (FOSS reimpl).

Citations (algorithms reimplemented in numpy; no proprietary deps):

- Vepa, King et al., ICSLP / TTS workshops 2002-2006 - MFCC / LSF / MCA join
  costs vs perceived discontinuity.
- Weighted fusion starting weights from Vepa TTS 2002 (0.15 MFCC + 0.35 LSF +
  0.5 MCA).

These scores are 0..1 “badness” proxies for fusion into join_continuity.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


def _clamp01(x: float) -> float:
    return float(max(0.0, min(1.0, x)))


def _preemph(x: np.ndarray, a: float = 0.97) -> np.ndarray:
    y = x.astype(np.float64).copy()
    if y.size < 2:  # pragma: no cover
        return y
    y[1:] = y[1:] - a * y[:-1]
    return y


def _pad_frame(x: np.ndarray, n: int) -> np.ndarray:
    if x.size >= n:
        return x.astype(np.float64)
    pad = np.zeros(n, dtype=np.float64)  # pragma: no cover
    pad[: x.size] = x
    return pad


def lpc_burg(x: np.ndarray, order: int) -> np.ndarray:
    """Burg LPC coefficients a[1..order] (a[0]=1 implied). Pure numpy."""
    x = np.asarray(x, dtype=np.float64)
    n = x.size
    if n <= order + 2:
        return np.zeros(order, dtype=np.float64)
    f = x.copy()
    b = x.copy()
    a = np.zeros(order, dtype=np.float64)
    e = float(np.dot(x, x) / n)
    for m in range(order):
        num = -2.0 * float(np.dot(f[m + 1 :], b[m : n - 1]))
        den = float(np.dot(f[m + 1 :], f[m + 1 :]) + np.dot(b[m : n - 1], b[m : n - 1]))
        if den <= 1e-20:
            break
        k = num / den
        a_prev = a[:m].copy()
        a[m] = k
        if m > 0:
            a[:m] = a_prev + k * a_prev[::-1]
        f_new = f[m + 1 :] + k * b[m : n - 1]
        b_new = b[m : n - 1] + k * f[m + 1 :]
        f = np.concatenate([f[: m + 1], f_new])
        b = np.concatenate([b[:m], b_new, b[n - 1 :]])
        e *= 1.0 - k * k
    return a


def lpc_to_lsf(a: np.ndarray) -> np.ndarray:
    """Convert LPC a[1..p] to line spectral frequencies in (0, pi)."""
    p = a.size
    # Polynomial A(z) = 1 + a1 z^-1 + ... + ap z^-p
    aa = np.concatenate([[1.0], a])
    # P(z) = A(z) + z^-(p+1) A(z^-1); Q(z) = A(z) - z^-(p+1) A(z^-1)
    p_poly = np.zeros(p + 2, dtype=np.float64)
    q_poly = np.zeros(p + 2, dtype=np.float64)
    for i in range(p + 1):
        p_poly[i] += aa[i]
        p_poly[p + 1 - i] += aa[i]
        q_poly[i] += aa[i]
        q_poly[p + 1 - i] -= aa[i]
    # Roots on unit circle via Chebyshev / polynomial roots on cos
    # Evaluate odd/even polynomials via FFT-style frequency grid
    n_fft = 512
    w = np.linspace(0, np.pi, n_fft, endpoint=False)
    z = np.exp(1j * w)
    # Evaluate P and Q on unit circle
    pz = np.polyval(p_poly[::-1], z)
    qz = np.polyval(q_poly[::-1], z)
    # Find zero crossings of imag/real parts as LSF candidates
    lsfs: list[float] = []
    for arr in (np.real(pz), np.real(qz)):
        for i in range(len(arr) - 1):
            if arr[i] == 0:
                lsfs.append(float(w[i]))
            elif arr[i] * arr[i + 1] < 0:
                t = arr[i] / (arr[i] - arr[i + 1])
                lsfs.append(float(w[i] + t * (w[i + 1] - w[i])))
    lsfs = sorted(set(round(x, 8) for x in lsfs if 0 < x < np.pi))
    # Pad/truncate to order
    out = np.zeros(p, dtype=np.float64)
    take = lsfs[:p]
    out[: len(take)] = take
    if len(take) < p:
        # fill evenly
        fill = np.linspace(0.1, np.pi - 0.1, p)
        out[len(take) :] = fill[len(take) :]
    return out


def mfcc_vector(frame: np.ndarray, sr: int, n_mfcc: int = 13, n_fft: int = 256) -> np.ndarray:
    """Simple MFCC (c0..c_{n-1}) for one window."""
    if frame.size < 8:  # pragma: no cover
        return np.zeros(n_mfcc, dtype=np.float64)
    n = min(n_fft, frame.size)
    win = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(n) / max(n - 1, 1))
    x = frame[:n].astype(np.float64) * win
    if n < n_fft:  # pragma: no cover
        pad = np.zeros(n_fft, dtype=np.float64)
        pad[:n] = x
        x = pad
    mag = np.abs(np.fft.rfft(x))
    # Mel filterbank
    n_mels = 26

    def hz_to_mel(f: float) -> float:
        return 2595.0 * float(np.log10(1.0 + f / 700.0))

    def mel_to_hz(m: float) -> float:
        return 700.0 * (10.0 ** (m / 2595.0) - 1.0)

    mels = np.linspace(hz_to_mel(0.0), hz_to_mel(sr / 2.0), n_mels + 2)
    hz = np.array([mel_to_hz(m) for m in mels])
    bins = np.floor((n_fft + 1) * hz / sr).astype(int)
    fb = np.zeros((n_mels, n_fft // 2 + 1), dtype=np.float64)
    for i in range(n_mels):
        left, center, right = bins[i], bins[i + 1], bins[i + 2]
        if center <= left:  # pragma: no cover
            center = left + 1
        if right <= center:  # pragma: no cover
            right = center + 1
        for j in range(left, min(center, fb.shape[1])):
            fb[i, j] = (j - left) / (center - left)
        for j in range(center, min(right, fb.shape[1])):
            fb[i, j] = (right - j) / (right - center)
    mel = fb @ mag
    log_mel = np.log(mel + 1e-10)
    mfcc = np.empty(n_mfcc, dtype=np.float64)
    n_m = log_mel.size
    for k in range(n_mfcc):
        mfcc[k] = np.sum(log_mel * np.cos(np.pi * k * (np.arange(n_m) + 0.5) / n_m))
    return mfcc


def mca_coefficients(frame: np.ndarray, sr: int, n_cent: int = 6) -> np.ndarray:
    """Multiple Centroid Analysis - energy-weighted spectral centroids in bands.

    Simplified FOSS proxy of MCA used in Vepa/King join-cost studies: split the
    magnitude spectrum into ``n_cent`` bands and return each band's centroid (Hz)
    plus relative band energy.
    """
    n_fft = 256
    n = min(n_fft, max(frame.size, 1))
    win = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(n) / max(n - 1, 1))
    x = frame[:n].astype(np.float64) * win
    if n < n_fft:
        pad = np.zeros(n_fft, dtype=np.float64)
        pad[:n] = x
        x = pad
    mag = np.abs(np.fft.rfft(x))
    freqs = np.fft.rfftfreq(n_fft, d=1.0 / sr)
    edges = np.linspace(0, mag.size, n_cent + 1, dtype=int)
    out = np.zeros(n_cent * 2, dtype=np.float64)
    total = float(np.sum(mag) + 1e-20)
    for i in range(n_cent):
        s, e = edges[i], edges[i + 1]
        if e <= s:
            continue
        band = mag[s:e]
        fr = freqs[s:e]
        wsum = float(np.sum(band) + 1e-20)
        out[i] = float(np.sum(fr * band) / wsum)
        out[n_cent + i] = wsum / total
    return out


@dataclass(frozen=True)
class SpectralJoinScores:
    mfcc: float
    lsf: float
    mca: float
    weighted: float


def score_spectral_join(
    left: np.ndarray,
    right: np.ndarray,
    *,
    sample_rate: int,
    lpc_order: int = 16,
) -> SpectralJoinScores:
    """Return 0..1 discontinuity scores for left|right splice sides."""
    # Use ~25 ms frames at ends
    n = max(32, int(0.025 * sample_rate))
    left_f = left[-n:] if left.size >= n else _pad_frame(left, n)
    right_f = right[:n] if right.size >= n else _pad_frame(right, n)
    left_f = _preemph(left_f)
    right_f = _preemph(right_f)

    # MFCC (skip c0 for energy - level handled elsewhere)
    ma = mfcc_vector(left_f, sample_rate)
    mb = mfcc_vector(right_f, sample_rate)
    mfcc_dist = float(np.linalg.norm(ma[1:] - mb[1:]))
    mfcc_score = _clamp01(mfcc_dist / 35.0)

    # LSF Mahalanobis with identity / diagonal scale
    try:
        a_l = lpc_burg(left_f, lpc_order)
        a_r = lpc_burg(right_f, lpc_order)
        lsf_l = lpc_to_lsf(a_l)
        lsf_r = lpc_to_lsf(a_r)
        diff = lsf_l - lsf_r
        # Diagonal cov ~ (pi/order)^2
        var = (np.pi / max(lpc_order, 1)) ** 2
        mahal = float(np.sqrt(np.sum((diff * diff) / var)))
        lsf_score = _clamp01(mahal / 8.0)
    except Exception:  # pragma: no cover
        lsf_score = 0.5

    # MCA multi-frame: 3 frames each side averaged
    hop = max(16, n // 2)

    def mca_side(sig: np.ndarray, from_end: bool) -> np.ndarray:
        vecs = []
        for k in range(3):
            if from_end:
                i1 = sig.size - k * hop
                i0 = i1 - n
                if i0 < 0:
                    break
                fr = sig[i0:i1]
            else:
                i0 = k * hop
                i1 = i0 + n
                if i1 > sig.size:
                    break
                fr = sig[i0:i1]
            if fr.size >= 16:
                vecs.append(mca_coefficients(fr, sample_rate))
        if not vecs:
            return mca_coefficients(sig[:n] if not from_end else sig[-n:], sample_rate)
        return np.mean(np.stack(vecs), axis=0)

    mca_l = mca_side(left, from_end=True)
    mca_r = mca_side(right, from_end=False)
    mca_dist = float(np.linalg.norm(mca_l - mca_r))
    # Centroids in Hz → scale
    mca_score = _clamp01(mca_dist / 2500.0)

    weighted = _clamp01(0.15 * mfcc_score + 0.35 * lsf_score + 0.5 * mca_score)
    return SpectralJoinScores(mfcc=mfcc_score, lsf=lsf_score, mca=mca_score, weighted=weighted)
