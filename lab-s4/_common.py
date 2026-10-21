"""Shared helpers for the S4 Mac lab scripts. Read-only: works on an in-memory copy of a project clone."""
import os, subprocess, sys, threading, time
from pathlib import Path

RSS_CAP_KB = 6 * 1024 * 1024  # 6 GB, per the Mac lab rule


def start_watchdog(cap_kb=RSS_CAP_KB):
    pid = os.getpid()
    peak = [0]

    def run():
        while True:
            out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
            rss = int(out or 0)
            peak[0] = max(peak[0], rss)
            if rss > cap_kb:
                print(f"WATCHDOG: RSS {rss / 1048576:.1f} GB over cap, exiting", flush=True)
                os._exit(3)
            time.sleep(1)

    threading.Thread(target=run, daemon=True).start()
    return peak


def count_ffmpeg():
    """Patch subprocess.Popen to count ffmpeg/ffprobe launches and their wall seconds."""
    stats = {"n": 0, "seconds": 0.0, "by_exe": {}}
    real = subprocess.Popen

    class Counting(real):
        def __init__(self, args, *a, **k):
            exe = os.path.basename(args[0] if isinstance(args, (list, tuple)) else str(args).split()[0])
            self._lab = exe if exe.startswith("ff") else None
            self._t0 = time.monotonic()
            if self._lab:
                stats["n"] += 1
                stats["by_exe"][exe] = stats["by_exe"].get(exe, 0) + 1
            super().__init__(args, *a, **k)

        def wait(self, *a, **k):
            r = super().wait(*a, **k)
            if self._lab and self._t0:
                stats["seconds"] += time.monotonic() - self._t0
                self._t0 = 0
            return r

    subprocess.Popen = Counting
    return stats


def open_clone(path):
    """Open the clone; every edit is forced programmatic, as in the S1 lab recipe."""
    from podcast_mcp.models.episode import CutIntent
    from podcast_mcp.services.app import ProjectWorkspace

    ws = ProjectWorkspace.open(Path(path))
    project = ws.project.model_copy(deep=True)
    for e in project.edit_decisions:
        e.boundary_intent = CutIntent.PROGRAMMATIC
    return ws, project, ws.effective_config()


def pending_ids(project, n):
    return [e.id for e in project.edit_decisions if not e.applied][:n]
