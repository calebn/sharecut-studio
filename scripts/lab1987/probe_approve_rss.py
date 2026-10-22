"""Approve-all memory probe (#1987). Run from the repo root with the project venv:

    PYTHONPATH=src:tests PERIOD=10 nice -n 10 python scripts/lab1987/probe_approve_rss.py <clone dir containing episode.project.json> [EVERY]

Copies the project to a temp dir (never touches the original), analyzes pauses if no removes are pending,
approves every EVERY-th pending remove in one batch, and logs RSS, live EpisodeProject count and live
ndarray MB every PERIOD seconds. Exits (code 3) if RSS passes LIMIT_MB (default 6000).
"""

import gc
import os
import shutil
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, "tests")
import numpy as np

from podcast_mcp.edits.transcript_refine_status import REFINE_GATE
from podcast_mcp.models import EpisodeProject, load_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService
from podcast_mcp.services.pipeline.service import PipelineService

REFINE_GATE.mode = lambda defaults=None: "off"
src = Path(sys.argv[1])
every = int(sys.argv[2]) if len(sys.argv) > 2 else 1
limit = int(os.environ.get("LIMIT_MB", "6000"))
work = Path(tempfile.mkdtemp(prefix="probe1987-")) / "proj"
shutil.copytree(src, work)
path = work / "episode.project.json"


def pending() -> list[str]:
    return [
        d.id
        for d in load_project(path).edit_decisions
        if not d.applied and d.type.value == "remove"
    ]


if not pending():
    PipelineService(ProjectWorkspace.open(path)).run(
        only_step="analyze_fillers_pauses",
        config={"tighten": {"enabled": True, "intensity": "medium"}},
    )
ids = pending()[::every]
print("pending removes selected", len(ids), flush=True)
ws = ProjectWorkspace.open(path)


def rss() -> int:
    import resource

    if sys.platform == "darwin":
        out = os.popen(f"ps -o rss= -p {os.getpid()}").read().strip()
        return int(out) // 1024
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024


stop = False
t0 = time.time()


def sampler() -> None:
    while not stop:
        objs = gc.get_objects()
        projects = sum(1 for o in objs if isinstance(o, EpisodeProject))
        nd = sum(o.nbytes for o in objs if isinstance(o, np.ndarray)) >> 20
        del objs
        r = rss()
        print(f"SAMPLE t={time.time() - t0:.0f} rss={r}MB projects={projects} ndarray={nd}MB", flush=True)
        if r > limit:
            print("RSS limit passed; exiting", flush=True)
            os._exit(3)
        time.sleep(float(os.environ.get("PERIOD", "10")))


threading.Thread(target=sampler, daemon=True).start()
n = EditService(ws).approve(ids, held_out=[], asked_out=[])
stop = True
print(f"approved {n} wall {time.time() - t0:.0f}s", flush=True)
shutil.rmtree(work.parent, ignore_errors=True)
