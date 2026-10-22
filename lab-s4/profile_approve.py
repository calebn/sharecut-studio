"""usage: nice -n 10 python profile_approve.py <clone.project.json> [N=102] [IDS_FILE]   (PYTHONPATH=src, venv)

cProfile of approve_edits for the first N pending edits on the project as saved (current main).
Prints top 25 by cumulative and by tottime, ffmpeg/ffprobe process count and seconds, wall time,
peak RSS, approved/held counts. Never touches the original: operates on an in-memory copy.
Run ONLY on a `cp -Rc` clone, one heavy job at a time (RSS watchdog 6 GB).
"""
import cProfile, logging, pstats, sys, time
sys.path.insert(0, __import__("os").path.dirname(__file__))
from _common import count_ffmpeg, ids_from_file, open_clone, pending_ids, start_watchdog

n = int(sys.argv[2]) if len(sys.argv) > 2 else 102
peak = start_watchdog()
renders = []


class _Count(logging.Handler):
    def emit(self, record):
        msg = record.getMessage()
        if "ffmpeg render" in msg:
            renders.append(msg)


logging.getLogger().addHandler(_Count())
logging.getLogger().setLevel(logging.INFO)
ff = count_ffmpeg()
ws, project, defaults = open_clone(sys.argv[1])
from podcast_mcp.edits.cut_application import approve_edits

ids = ids_from_file(sys.argv[3], project)[:n] if len(sys.argv) > 3 else pending_ids(project, n)
held = []
pr = cProfile.Profile()
t0 = time.monotonic()
pr.enable()
applied = approve_edits(project, ids, defaults=defaults, held_out=held)
pr.disable()
wall = time.monotonic() - t0
print(f"N={len(ids)} applied={applied} held={len(held)} wall={wall:.1f}s peak_rss_gb={peak[0] / 1048576:.2f}")
print("held (sorted, for the main-vs-head diff):")
for h in sorted(held, key=lambda h: h.edit_id):
    print("  HELD", h.edit_id, getattr(h, "reason", ""))
print("applied ids (sorted):", sorted(set(ids) - {h.edit_id for h in held}))
print(f"log lines mentioning an ffmpeg render fallback={len(renders)} (informational; the ffmpeg launch count below is the metric)")
print(f"ffmpeg-family launches={ff['n']} by_exe={ff['by_exe']} wall_seconds_in_children={ff['seconds']:.1f}")
for key in ("cumulative", "tottime"):
    print(f"\n=== top 25 by {key} ===")
    pstats.Stats(pr).sort_stats(key).print_stats(25)
