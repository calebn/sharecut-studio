"""usage: python resampler_restart_probe.py [SECONDS=120] [TRIALS=30] [SEED=1]   (PYTHONPATH=src, venv; no project, no audio files, ~1-3 min)

Gate for the #1958 PR-B splice.  Is ffmpeg's resampler (the one S1 uses, `ungated_audio.resample_stream`) a
finite-support filter, so that restarting it mid-stream gives the same output as running it continuously?
Seeded noise plus a tone burst at 48000 Hz (Daniela's dani track) and 44100 Hz (vicky) -> 8000 and 16000 Hz.
For each trial pick a restart input sample s that is a multiple of the rate-alignment unit (6 for 48k->8k, 3 for 48k->16k,
441 for 44.1k->8k, 441/... see UNIT) with a WARM warm-up prefix of W input samples, resample the suffix alone, drop the
warm-up outputs, and compare with the continuous output.  Reports the smallest W (from WARMUPS) making the whole suffix
bit-equal (np.array_equal) in every trial, also the s-not-a-multiple-of-unit result (expected NOT equal), and `ffmpeg -version`.
PASS: some W <= 4096 input samples gives array_equal in ALL trials for 48k->8k and 48k->16k.  44.1 kHz is informational
(PR-B falls back to prefix reuse there).  FAIL (no W works): the splice is off, PR-B uses prefix reuse (~2x).
"""
import subprocess, sys
import numpy as np
from podcast_mcp.engines.ungated_audio import resample_stream
from podcast_mcp.util.binaries import resolve_ffmpeg_pair

SECONDS = int(sys.argv[1]) if len(sys.argv) > 1 else 120
TRIALS = int(sys.argv[2]) if len(sys.argv) > 2 else 30
SEED = int(sys.argv[3]) if len(sys.argv) > 3 else 1
WARMUPS = (0, 64, 256, 1024, 4096, 16384)
UNIT = {(48000, 8000): 6, (48000, 16000): 3, (44100, 8000): 441, (44100, 16000): 441}
print(subprocess.run([resolve_ffmpeg_pair().ffmpeg, "-version"], capture_output=True, text=True).stdout.splitlines()[0])


def convert(x, fr, to):
    return resample_stream(iter([x[i:i + (1 << 18)] for i in range(0, len(x), 1 << 18)]), fr, to)


rng = np.random.default_rng(SEED)
overall_ok = True
for (fr, to), unit in UNIT.items():
    n = SECONDS * fr
    x = (rng.standard_normal(n) * 0.1).astype(np.float32)
    t = np.arange(n // 10) / fr
    x[n // 3: n // 3 + n // 10] += (0.3 * np.sin(2 * np.pi * 3000 * t)).astype(np.float32)
    full = convert(x, fr, to)
    ratio = fr // unit  # input samples per `unit` input samples -> out samples = unit * to / fr
    out_per_unit = unit * to // fr
    results = {}
    for w in WARMUPS:
        ok = 0
        for _ in range(TRIALS):
            s = int(rng.integers(w // unit + 2, (n - fr) // unit)) * unit  # restart point, multiple of unit
            start = s - (w // unit) * unit  # warm-up start, also a multiple of unit
            part = convert(x[start:], fr, to)
            drop = (s - start) // unit * out_per_unit
            mine = part[drop:]
            ref = full[s // unit * out_per_unit:]
            m = min(mine.size, ref.size)
            ok += int(np.array_equal(mine[:m], ref[:m]) and abs(mine.size - ref.size) <= 1)
        results[w] = ok
    bad = 0
    for _ in range(TRIALS):
        s = int(rng.integers(100, (n - fr) // unit)) * unit + 1  # NOT a multiple of unit
        part = convert(x[s:], fr, to)
        ref = full[s * to // fr:]
        m = min(part.size, ref.size)
        bad += int(not np.array_equal(part[:m], ref[:m]))
    best = next((w for w in WARMUPS if results[w] == TRIALS), None)
    print(f"{fr}->{to} unit={unit}: bit-equal trials per warm-up {results}; smallest all-equal warm-up = {best}; "
          f"off-grid restarts NOT equal in {bad}/{TRIALS}")
    if fr == 48000 and (best is None or best > 4096):
        overall_ok = False
print("RESULT:", "PASS (splice allowed, record warm-up per rate)" if overall_ok else "FAIL (use prefix reuse)")
