"""usage: nice -n 10 python stage_timing.py <clone.project.json> [N=61] [IDS_FILE]   (PYTHONPATH=src, venv)

Per-stage wall time of approve_edits on an in-memory copy of a `cp -Rc` clone (#1958 PR-B1). Wraps the stage
functions with exclusive-time accumulators (a stage's time excludes the wrapped stages it calls) and prints a table
with per-edit means, plus ffmpeg launches. Never touches the original.
"""
import sys, time, threading
sys.path.insert(0, __import__("os").path.dirname(__file__))
from _common import count_ffmpeg, ids_from_file, open_clone, pending_ids, start_watchdog

n = int(sys.argv[2]) if len(sys.argv) > 2 else 61
peak = start_watchdog()
ff = count_ffmpeg()
ws, project, defaults = open_clone(sys.argv[1])

from podcast_mcp.edits import cut_application, cut_proof, cut_safety
from podcast_mcp.engines import audio_audit, track_evidence

acc, calls, stack = {}, {}, threading.local()


def wrap(mod, name, label=None):
    real = getattr(mod, name)
    label = label or f"{mod.__name__.rsplit('.', 1)[-1]}.{name}"

    def timed(*a, **k):
        frames = getattr(stack, "f", None)
        if frames is None:
            frames = stack.f = []
        frames.append(0.0)
        t0 = time.perf_counter()
        try:
            return real(*a, **k)
        finally:
            total = time.perf_counter() - t0
            child = frames.pop()
            if frames:
                frames[-1] += total
            acc[label] = acc.get(label, 0.0) + total - child
            calls[label] = calls.get(label, 0) + 1

    timed.__wrapped__ = real
    for m in list(sys.modules.values()):
        if getattr(m, "__name__", "").startswith("podcast_mcp") and getattr(m, name, None) is real:
            setattr(m, name, timed)


for mod, names in (
    (cut_application, ["_cut_copy", "_write_source_remove", "_apply_source_remove"]),
    (cut_proof, ["shared_source_audio_caches", "shared_timeline_rms_caches"]),
    (cut_safety, ["observe_source_cut"]),
    (track_evidence, ["heard", "rms", "_evaluate"]),
    (audio_audit, ["build_track_rms_caches"]),
):
    for name in names:
        if hasattr(mod, name):
            wrap(mod, name)
        else:
            print("MISSING (not wrapped):", mod.__name__, name)

ids = ids_from_file(sys.argv[3], project)[:n] if len(sys.argv) > 3 else pending_ids(project, n)
held = []
t0 = time.monotonic()
applied = cut_application.approve_edits(project, ids, defaults=defaults, held_out=held)
wall = time.monotonic() - t0
print(f"N={len(ids)} applied={applied} held={len(held)} wall={wall:.1f}s peak_rss_gb={peak[0] / 1048576:.2f}")
print(f"ffmpeg-family launches={ff['n']} by_exe={ff['by_exe']} wall_seconds_in_children={ff['seconds']:.1f}")
print("\nstage (exclusive time)                               calls   total_s   per_edit_ms")
for label, secs in sorted(acc.items(), key=lambda kv: -kv[1]):
    print(f"{label:52s} {calls[label]:5d} {secs:9.2f} {1000 * secs / max(len(ids), 1):12.1f}")
rest = wall - sum(acc.values())
print(f"{'(unwrapped: verdict python, deepcopy elsewhere, apply)':52s} {'':5s} {rest:9.2f} {1000 * rest / max(len(ids), 1):12.1f}")
print("applied ids (sorted):", sorted(set(ids) - {h.edit_id for h in held}))
