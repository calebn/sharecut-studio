"""usage: nice -n 10 python select_ok_ids.py <clone.project.json> OUT_IDS [N=40] [MAX_TRIED=120]   (PYTHONPATH=src, venv)

OK-heavy set for the #1958 A/B: walk the pending edits in order, compute each one's verdict with
assess_offer on the untouched project, and write the ids of the first N whose verdict is OK (no holds) to OUT_IDS.
Run once, on MAIN (the slow arm); both arms then use the same ids file.  Tries at most MAX_TRIED edits.
Read-only; in-memory copy; RSS watchdog 6 GB.
"""
import sys
sys.path.insert(0, __import__("os").path.dirname(__file__))
from _common import open_clone, pending_ids, start_watchdog

n = int(sys.argv[3]) if len(sys.argv) > 3 else 40
tried_max = int(sys.argv[4]) if len(sys.argv) > 4 else 120
peak = start_watchdog()
ws, project, defaults = open_clone(sys.argv[1])
from podcast_mcp.edits.cut_application import assess_offer

ok, tried = [], 0
for eid in pending_ids(project, tried_max):
    tried += 1
    edit = next(e for e in project.edit_decisions if e.id == eid)
    if not assess_offer(project.model_copy(deep=True), edit, defaults=defaults):
        ok.append(eid)
        if len(ok) >= n:
            break
open(sys.argv[2], "w").write("\n".join(ok) + "\n")
print(f"tried {tried}, OK {len(ok)} written to {sys.argv[2]}; peak_rss_gb={peak[0] / 1048576:.2f}")
