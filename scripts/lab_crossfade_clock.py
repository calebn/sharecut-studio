"""Lab A/B for #1888: does a crossfade still move a lane's clock? Run on main, then on PR 2017.

    nice -n 10 python scripts/lab_crossfade_clock.py PROJECT.json OUT_DIR [--label main]

PROJECT.json is a COPY of the project (never the live Studio's file). Renders every
dialogue lane to OUT_DIR/<label>/<track>.wav and writes OUT_DIR/<label>/report.json:
per lane the stem length, the authored end, the drift (authored minus stem less the
closed join gaps), the crossfade join count, and the quietest 10 ms window within
50 ms of each blending seam relative to the lane's median (a dip means the blend is bad).
One heavy job at a time; run under the 6 GB RSS watchdog.
"""

from __future__ import annotations

import json
import statistics
import sys
import wave
from pathlib import Path

import numpy as np

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines.clips_ops import (
    JOIN_GAP_TOLERANCE_SEC,
    clips_for_track,
    uses_crossfade_join,
)
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.timeline_render import render_track_from_timeline
from podcast_mcp.models import TrackRole, load_project


def _pcm(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as w:
        rate, ch = w.getframerate(), w.getnchannels()
        raw = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32)
    return raw.reshape(-1, ch).mean(axis=1) / 32768.0, rate


def main() -> None:
    project_path, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    label = sys.argv[sys.argv.index("--label") + 1] if "--label" in sys.argv else "run"
    out = out_dir / label
    out.mkdir(parents=True, exist_ok=True)
    project = load_project(project_path)
    eng, defaults = FFmpegEngine(), load_defaults()
    report: dict[str, dict] = {}
    for track in project.tracks:
        if track.role != TrackRole.DIALOGUE:
            continue
        clips = clips_for_track(project, track.id)
        if not clips:
            continue
        target = out / f"{track.id}.wav"
        render_track_from_timeline(project, track, target, defaults, engine=eng)
        samples, rate = _pcm(target)
        joins = list(zip(clips, clips[1:], strict=False))
        closed = sum(
            max(0.0, b.timeline_start - a.timeline_end)
            for a, b in joins
            if 0 < b.timeline_start - a.timeline_end <= JOIN_GAP_TOLERANCE_SEC
        )
        seams = [a.timeline_end for a, b in joins if uses_crossfade_join(a, b)]
        win = int(0.010 * rate)
        rms = lambda s: float(np.sqrt(np.mean(np.square(s)) + 1e-12))  # noqa: E731
        median = statistics.median(
            rms(samples[i : i + win]) for i in range(0, max(1, len(samples) - win), win * 50)
        )
        dips = []
        for seam in seams:
            lo = max(0, int((seam - 0.05) * rate))
            hi = min(len(samples) - win, int((seam + 0.05) * rate))
            if hi > lo:
                dips.append(
                    min(rms(samples[i : i + win]) for i in range(lo, hi, win // 2)) / (median or 1)
                )
        authored_end = max(c.timeline_end for c in clips)
        stem = len(samples) / rate
        report[track.id] = {
            "stem_sec": round(stem, 4),
            "authored_end_sec": round(authored_end, 4),
            "drift_sec": round(authored_end - stem - closed, 4),
            "crossfade_joins": len(seams),
            "worst_seam_dip_ratio": round(min(dips), 4) if dips else None,
        }
    (out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
