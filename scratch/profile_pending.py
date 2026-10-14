"""Where does one cold Play around spend its time? (#1558, throwaway; not for merge)

usage: .venv/bin/python scratch/profile_pending.py <project dir> <edit id> [--other <edit id>]

Warms the mix and both level profiles first (what the pre-measure does), then profiles
play_pending_preview(edit, mode="ab") cold, and prints wall time per phase and the top
functions. Run it on a clone (it writes play_cache). Prints no audio paths or text.
"""
import cProfile, pstats, sys, time
from podcast_mcp.services.app.workspace import ProjectWorkspace
from podcast_mcp.services.document import PlayService
from podcast_mcp.services.document import play as P

root, edit = sys.argv[1], sys.argv[2]
ws = ProjectWorkspace.open(root)
svc = PlayService(ws)

t = time.perf_counter(); svc.mix_trim_db(); print(f"mix_trim_db (cold) {time.perf_counter()-t:.2f}s")
t = time.perf_counter(); svc.mix_trim_db(); print(f"mix_trim_db (warm) {time.perf_counter()-t:.2f}s")
t = time.perf_counter(); svc._mix_key(); print(f"_mix_key {time.perf_counter()-t:.2f}s")
t = time.perf_counter()
import hashlib; hashlib.sha256(ws.project.transcript_data.model_dump_json().encode()).hexdigest()
print(f"transcript digest {time.perf_counter()-t:.2f}s")

timings = {}
def wrap(owner, name):
    fn = getattr(owner, name)
    def inner(*a, **k):
        s = time.perf_counter()
        try: return fn(*a, **k)
        finally: timings.setdefault(name, []).append(time.perf_counter() - s)
    setattr(owner, name, inner)
wrap(P, "render_track_segment"); wrap(P, "snapshot_project"); wrap(P, "apply_for_suggested")
wrap(P, "resolve_pending_preview")

pr = cProfile.Profile(); t = time.perf_counter(); pr.enable()
svc.play_pending_preview(edit, mode="ab", dry_run=True)
pr.disable(); print(f"play_pending_preview ab (cold) {time.perf_counter()-t:.2f}s")
for k, v in timings.items(): print(f"  {k}: n={len(v)} total={sum(v):.2f}s max={max(v):.2f}s")
st = pstats.Stats(pr)
print("--- top by cumulative"); st.sort_stats("cumulative").print_stats(25)
print("--- top by own time"); st.sort_stats("tottime").print_stats(15)
