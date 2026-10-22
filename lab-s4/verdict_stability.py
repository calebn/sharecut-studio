"""usage: nice -n 10 python verdict_stability.py <clone.project.json> [N=102] [APPLY=10] [IDS_FILE]   (PYTHONPATH=src, venv)

Does applying a few cuts change the safety verdicts of the others?  Computes the verdict
(assess_offer: list of CutScopeHold) of each of N pending edits against the saved project, applies
the first APPLY of them, recomputes the remaining verdicts, and counts how many changed.
Records each hold's repr (the measured values, i.e. margins, where the hold carries them), the
seconds per verdict, and whether the changed ones sit near the applied cuts (distance in seconds
on the same track).  Read-only: in-memory copy of a clone; one heavy job, RSS watchdog 6 GB.
"""
import sys, time
sys.path.insert(0, __import__("os").path.dirname(__file__))
from _common import count_ffmpeg, ids_from_file, open_clone, pending_ids, start_watchdog

n = int(sys.argv[2]) if len(sys.argv) > 2 else 102
k = int(sys.argv[3]) if len(sys.argv) > 3 else 10
peak = start_watchdog()
ff = count_ffmpeg()
ws, project, defaults = open_clone(sys.argv[1])
from podcast_mcp.edits.cut_application import approve_edits, assess_offer

ids = ids_from_file(sys.argv[4], project)[:n] if len(sys.argv) > 4 else pending_ids(project, n)


def verdicts(proj, which):
    out, secs = {}, {}
    for eid in which:
        edit = next((e for e in proj.edit_decisions if e.id == eid), None)
        if edit is None:
            out[eid] = ("GONE", ()); continue
        t0 = time.monotonic()
        holds = assess_offer(proj.model_copy(deep=True), edit, defaults=defaults)
        secs[eid] = time.monotonic() - t0
        out[eid] = ("HELD" if holds else "OK", tuple(repr(h) for h in holds))
    return out, secs


before, s0 = verdicts(project, ids)
print(f"before: {sum(v[0] == 'OK' for v in before.values())} ok, {sum(v[0] == 'HELD' for v in before.values())} held, "
      f"mean {sum(s0.values()) / max(len(s0), 1):.2f}s/verdict, ffmpeg launches {ff['n']}", flush=True)
applied_ids = ids[:k]
held = []
approve_edits(project, applied_ids, defaults=defaults, held_out=held)
rest = ids[k:]
after, s1 = verdicts(project, rest)
changed = [e for e in rest if before[e] != after[e]]
flipped = [e for e in rest if before[e][0] != after[e][0]]
print(f"applied {k} (held {len(held)}); of {len(rest)} remaining: {len(changed)} changed (hold detail), "
      f"{len(flipped)} flipped OK<->HELD; peak_rss_gb={peak[0] / 1048576:.2f}")


def where(eid):
    e = next((x for x in project.edit_decisions if x.id == eid), None)
    return (getattr(e, "track_id", "?"), round(getattr(e, "start", 0.0), 2)) if e else ("gone", 0)


for e in changed:
    print("CHANGED", e, where(e), "\n   before:", before[e], "\n   after: ", after[e])
print("applied cuts:", [where(e) for e in applied_ids])
print("unchanged margins sample (first 10 holds):")
for e in [x for x in rest if before[x][1]][:10]:
    print(" ", e, before[e][1])
