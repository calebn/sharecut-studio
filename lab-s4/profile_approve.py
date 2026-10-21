"""usage: nice -n 10 python profile_approve.py <clone.project.json> [N=102]   (PYTHONPATH=src, venv)

cProfile of approve_edits for the first N pending edits on the project as saved (current main).
Prints top 25 by cumulative and by tottime, ffmpeg/ffprobe process count and seconds, wall time,
peak RSS, approved/held counts. Never touches the original: operates on an in-memory copy.
Run ONLY on a `cp -Rc` clone, one heavy job at a time (RSS watchdog 6 GB).
"""
import cProfile, pstats, sys, time
sys.path.insert(0, __import__("os").path.dirname(__file__))
from _common import count_ffmpeg, open_clone, pending_ids, start_watchdog

n = int(sys.argv[2]) if len(sys.argv) > 2 else 102
peak = start_watchdog()
ff = count_ffmpeg()
ws, project, defaults = open_clone(sys.argv[1])
from podcast_mcp.edits.cut_application import approve_edits

ids = pending_ids(project, n)
held = []
pr = cProfile.Profile()
t0 = time.monotonic()
pr.enable()
applied = approve_edits(project, ids, defaults=defaults, held_out=held)
pr.disable()
wall = time.monotonic() - t0
print(f"N={len(ids)} applied={applied} held={len(held)} wall={wall:.1f}s peak_rss_gb={peak[0] / 1048576:.2f}")
print(f"ffmpeg-family launches={ff['n']} by_exe={ff['by_exe']} wall_seconds_in_children={ff['seconds']:.1f}")
for key in ("cumulative", "tottime"):
    print(f"\n=== top 25 by {key} ===")
    pstats.Stats(pr).sort_stats(key).print_stats(25)
