"""Throwaway (#1546): time vad_speech_intervals before and after, and compare the intervals.

Usage: python scripts/_vad_timing.py OLD_ALIGNMENT_AUDIT.py START DURATION TRACK ...
Get the old file with: git show e0e3356a:src/podcast_mcp/engines/alignment_audit.py > /tmp/old_audit.py
"""

import importlib.util
import sys
import time
from pathlib import Path

from podcast_mcp.engines import alignment_audit as new

spec = importlib.util.spec_from_file_location("old_audit", sys.argv[1])
old = importlib.util.module_from_spec(spec)
sys.modules["old_audit"] = old
spec.loader.exec_module(old)
start, duration = float(sys.argv[2]), float(sys.argv[3])
for name in sys.argv[4:]:
    path = Path(name)
    t = time.time()
    a = old.vad_speech_intervals(path, start_sec=start, duration_sec=duration)
    ta = time.time() - t
    t = time.time()
    b = new.vad_speech_intervals(path, start_sec=start, duration_sec=duration)
    tb = time.time() - t
    print(f"{path.name}: n={len(a)}/{len(b)} identical={a == b} old={ta:.1f}s new={tb:.1f}s")
    if a != b:
        print("  differ:", sorted(set(a) ^ set(b))[:10])
