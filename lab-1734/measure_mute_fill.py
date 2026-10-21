#!/usr/bin/env python3
"""Measure a bleed mute before/after (#1734). numpy + stdlib only; audio never leaves the Mac.

  measure_mute_fill.py --before host_main.wav --after host_pr.wav --peer vicky.wav \
      --spans spans.json --pauses pauses.json --out report.json

spans.json:  [[start_sec, end_sec], ...]  the muted (foreign-copy) spans, timeline seconds
pauses.json: [[start_sec, end_sec], ...]  the lane's own quiet stretches (no voice, no copy)
All WAVs are 16-bit PCM of the same length/rate (stems rendered on main and on the PR head).
Exit 0 = PASS, 1 = FAIL. Report lists every check.
"""
from __future__ import annotations

import argparse
import json
import sys
import wave

import numpy as np

MIN_CORR_SEC = 0.25
EDGE_SEC = 0.05          # spans are judged inside this margin (the 20 ms ramps are excluded)
BAND_EDGES = 1000.0 * 2.0 ** (np.arange(-7, 4) / 3.0)   # 1/3 octave, ~100 Hz .. ~8 kHz
OVERALL_DB, BAND_DB = 2.0, 3.0   # same rubric as the gate-fill harness
SILENCE_DBFS = -100.0


def read(path: str) -> tuple[np.ndarray, int]:
    with wave.open(path, "rb") as w:
        assert w.getsampwidth() == 2, "16-bit PCM only"
        raw = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
        ch = w.getnchannels()
        return raw.reshape(-1, ch).astype(np.float64).mean(axis=1) / 32768.0, w.getframerate()


def cut(x: np.ndarray, rate: int, spans, trim: float = 0.0) -> list[np.ndarray]:
    out = []
    for a, b in spans:
        lo, hi = int((a + trim) * rate), int((b - trim) * rate)
        if hi - lo >= rate // 20:
            out.append(x[lo:hi])
    return out


def longest_zero_run(x: np.ndarray) -> int:
    z = np.concatenate(([0], (x == 0).astype(np.int8), [0]))
    edges = np.flatnonzero(np.diff(z))
    return int((edges[1::2] - edges[::2]).max()) if edges.size else 0


def lower_half(chunks: list[np.ndarray], rate: int) -> np.ndarray:
    """The quietest half of the pauses' 10 ms blocks: the room, not breaths or word tails.

    Pauses picked by a level threshold also hold breaths, lip noise and decaying word tails.
    The gate's bed is a median for the same reason, so the reference is the lower half."""
    block = rate // 100
    blocks = [c[i:i + block] for c in chunks for i in range(0, len(c) - block + 1, block)]
    if not blocks:
        return np.zeros(0)
    level = np.array([np.mean(b * b) for b in blocks])
    keep = level <= np.median(level)
    return np.concatenate([b for b, k in zip(blocks, keep) if k])


def dbfs(x: np.ndarray) -> float:
    r = float(np.sqrt(np.mean(np.square(x)))) if x.size else 0.0
    return 20 * np.log10(r) if r > 0 else SILENCE_DBFS


def bands(chunks: list[np.ndarray], rate: int, n: int = 8192) -> np.ndarray:
    """Mean power per 1/3-octave band, dB (Welch-style, Hann, 8192 pts)."""
    acc = np.zeros(n // 2 + 1)
    count = 0
    win = np.hanning(n)
    for c in chunks:
        for i in range(0, len(c) - n + 1, n // 2):
            acc += np.abs(np.fft.rfft(c[i:i + n] * win)) ** 2
            count += 1
    freqs = np.fft.rfftfreq(n, 1.0 / rate)
    acc /= max(count, 1)
    out = []
    for lo, hi in zip(BAND_EDGES[:-1], BAND_EDGES[1:]):
        sel = (freqs >= lo) & (freqs < hi) & (freqs < rate / 2)
        out.append(10 * np.log10(acc[sel].mean() + 1e-30) if sel.any() else np.nan)
    return np.array(out)


def seam(x: np.ndarray, rate: int, spans) -> float:
    """Largest sample-to-sample step at span edges, relative to the median step nearby (click metric)."""
    worst = 0.0
    for a, b in spans:
        for t in (a, b):
            c = int(t * rate)
            win = np.abs(np.diff(x[max(c - 960, 0):c + 960]))
            if win.size:
                worst = max(worst, float(win.max() / (np.median(win) + 1e-12)))
    return worst


def main() -> int:
    p = argparse.ArgumentParser()
    for k in ("before", "after", "peer", "spans", "pauses", "out"):
        p.add_argument(f"--{k}", required=(k != "peer" and k != "out"))
    a = p.parse_args()
    spans = json.load(open(a.spans))
    pauses = json.load(open(a.pauses))
    before, rate = read(a.before)
    after, rate2 = read(a.after)
    assert rate == rate2 and before.shape == after.shape, "stems must match in rate and length"

    checks: dict[str, object] = {}
    inside_b = np.concatenate(cut(before, rate, spans, EDGE_SEC))
    inside_a = np.concatenate(cut(after, rate, spans, EDGE_SEC))
    checks["before_rms_dbfs"] = dbfs(inside_b)
    checks["after_rms_dbfs"] = dbfs(inside_a)
    checks["before_longest_zero_run_samples"] = longest_zero_run(inside_b)
    checks["after_longest_zero_run_samples"] = longest_zero_run(inside_a)

    own_pause = cut(after, rate, pauses)
    all_pause_db = dbfs(np.concatenate(own_pause)) if own_pause else None
    room = lower_half(own_pause, rate)
    pause_db = dbfs(room) if room.size else None
    checks["lane_pauses_all_rms_dbfs"] = all_pause_db      # informational: includes breaths and tails
    checks["lane_room_rms_dbfs"] = pause_db                # quietest half of the pauses: the reference
    checks["pause_seconds"] = round(sum(len(c) for c in own_pause) / rate, 1)
    overall = None if pause_db is None else abs(checks["after_rms_dbfs"] - pause_db)
    checks["overall_delta_db"] = overall
    band_delta = bands(cut(after, rate, spans, EDGE_SEC), rate, 2048) - bands([room], rate, 2048)
    checks["band_delta_db"] = [None if np.isnan(d) else round(float(d), 2) for d in band_delta]
    checks["seam_ratio_before"] = seam(before, rate, spans)
    checks["seam_ratio_after"] = seam(after, rate, spans)

    # Audio outside the spans (with a 50 ms margin for the ramps) must be identical.
    keep = np.ones(len(after), dtype=bool)
    for s, e in spans:
        keep[max(int((s - EDGE_SEC) * rate), 0):int((e + EDGE_SEC) * rate)] = False
    checks["outside_spans_max_abs_diff"] = float(np.abs(after[keep] - before[keep]).max()) * 32768.0

    if a.peer:
        peer, prate = read(a.peer)
        n = min(len(peer), len(after))
        if prate == rate:
            # Short windows correlate by chance (2 samples correlate at +-1), so only spans
            # with at least MIN_CORR_SEC left after the edge margin count.
            c = []
            for s0, e0 in spans:
                lo, hi = int((s0 + EDGE_SEC) * rate), int((e0 - EDGE_SEC) * rate)
                if hi - lo >= MIN_CORR_SEC * rate and hi <= n:
                    c.append(np.corrcoef(peer[lo:hi], after[lo:hi])[0, 1])
            checks["peer_correlation_spans_used"] = len(c)
            checks["peer_correlation_max_abs"] = float(np.nanmax(np.abs(c))) if c else None

    fails = []
    if checks["after_longest_zero_run_samples"] > rate // 100:   # > 10 ms of exact zeros
        fails.append("muted spans still hold digital silence")
    if overall is None:
        fails.append("no pauses to compare against")
    elif overall > OVERALL_DB:
        fails.append(f"overall level {overall:.1f} dB from the lane's pauses (> {OVERALL_DB})")
    worst_band = max((abs(d) for d in band_delta if not np.isnan(d)), default=0.0)
    if worst_band > BAND_DB:
        fails.append(f"a 1/3-octave band is {worst_band:.1f} dB off the lane's pauses (> {BAND_DB})")
    if checks["outside_spans_max_abs_diff"] > 1.0:
        fails.append("audio outside the muted spans changed (> 1 LSB)")
    pc = checks.get("peer_correlation_max_abs")
    if pc is not None and pc > 0.2:
        fails.append(f"peer correlation {pc:.2f}: the other speaker is audible in the fill")
    if checks["seam_ratio_after"] > max(3 * checks["seam_ratio_before"], 50.0):
        fails.append("click at a span edge")
    checks["verdict"] = "PASS" if not fails else "FAIL"
    checks["failures"] = fails
    text = json.dumps(checks, indent=2, default=float)
    print(text)
    if a.out:
        open(a.out, "w").write(text)
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
