"""usage: python lab-s2/autocorr_hits.py <episode.project.json> <N> -- approve the first N pending removes in-process.

Prints wall seconds, applied and held ids, and how many autocorrelation frames were distinct (the hit rate
of PR 1950 on real audio). Run on a throwaway `cp -Rc` clone; it saves the project. Daniela audio stays on the Mac.
"""
import collections, hashlib, json, sys, time
from pathlib import Path

import numpy as np

from podcast_mcp.models import load_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService
from podcast_mcp.util import dsp

path, count = Path(sys.argv[1]), int(sys.argv[2])
ws = ProjectWorkspace.open(path)
ids = [
    d.id for d in load_project(path).edit_decisions if not d.applied and d.type.value == "remove"
][:count]
real = dsp.autocorr_peak
seen: collections.Counter = collections.Counter()
calls = [0]


def counting(samples, rate, *, fmin, fmax, interior=False):
    calls[0] += 1
    digest = hashlib.blake2b(np.ascontiguousarray(samples).tobytes(), digest_size=16).digest()
    seen[(rate, fmin, fmax, interior, samples.shape, str(samples.dtype), digest)] += 1
    return real(samples, rate, fmin=fmin, fmax=fmax, interior=interior)


for module in ("podcast_mcp.util.dsp", "podcast_mcp.edits.voiced_runs", "podcast_mcp.edits.acoustic_gap",
               "podcast_mcp.edits.join_continuity", "podcast_mcp.edits.join_speech"):
    mod = __import__(module, fromlist=["x"])
    mod.autocorr_peak = counting
held, asked = [], []
start = time.time()
approved = EditService(ws).approve(ids, held_out=held, asked_out=asked)
print(json.dumps({
    "pending_requested": len(ids), "approved": approved, "held": sorted((h.edit_id, h.reason) for h in held),
    "wall_sec": round(time.time() - start, 1), "autocorr_calls": calls[0],
    "autocorr_distinct": len(seen),
    "load_avg": __import__("os").getloadavg(),
}))
