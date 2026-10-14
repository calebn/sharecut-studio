"""Throwaway (#1533): print each track's level profile and the VAD intervals at candidate gates.

Usage: python scripts/_vad_gate_sweep.py START_SEC DURATION_SEC TRACK.wav [TRACK.wav ...]
Prints numbers only (no audio, no paths beyond the name you pass).
"""

from __future__ import annotations

import sys
from pathlib import Path

from podcast_mcp.engines.alignment_audit import vad_speech_intervals
from podcast_mcp.engines.level_profile import file_level_profile
from podcast_mcp.util.dsp import db_to_amplitude


def main() -> None:
    start, dur = float(sys.argv[1]), float(sys.argv[2])
    for arg in sys.argv[3:]:
        path = Path(arg)
        prof = file_level_profile(path, sample_rate=8000)
        print(
            f"{path.name}: room {prof.room_db:.1f} speech {prof.speech_db:.1f} "
            f"loud {prof.loud_db:.1f} reach {prof.voice_reach_db:.1f} dB"
        )
        gates = {"main 0.015": 0.015}
        gates["voice_reach"] = db_to_amplitude(prof.voice_reach_db)
        for k in (18, 21, 24, 27, 30):
            gates[f"speech-{k}"] = db_to_amplitude(prof.speech_db - k)
        for label, gate in gates.items():
            iv = vad_speech_intervals(path, start_sec=start, duration_sec=dur, rms_threshold=gate)
            total = sum(b - a for a, b in iv)
            print(f"  {label:12s} gate {gate:.5f}  n={len(iv):3d}  speech={total:6.2f}s")


if __name__ == "__main__":
    main()
