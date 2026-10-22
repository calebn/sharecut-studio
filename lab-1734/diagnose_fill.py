#!/usr/bin/env python3
"""Why is the mute fill at the level it is? (#1734) Run in the PR head's venv, on a scratch copy.

  python diagnose_fill.py <project dir or episode.json> <track id> [--pauses pauses.json]

Prints, for the lane: the gate's bed (dB re the lane's voice level) and the voice level in
dBFS (so the bed in dBFS), the room the fill was read from (quiet runs: how many seconds,
how many frames are digital silence, their level percentiles), the fill chosen, and, for the
harness's pauses, the same level percentiles, so the two references can be compared.
"""
from __future__ import annotations

import argparse
import json

import numpy as np

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import bleed_fill
from podcast_mcp.engines.bleed_gate import build_bleed_gate_plan
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.level_profile import track_profile
from podcast_mcp.project.io import open_project
from podcast_mcp.util.dsp import DIGITAL_SILENCE_DB, frame_rms_db_stream
from podcast_mcp.util.workspace_paths import resolve_under_workspace

RATE, FRAME = 16_000, 160   # 10 ms frames


def percentiles(db: np.ndarray) -> dict[str, float | None]:
    live = db[db > DIGITAL_SILENCE_DB]
    out: dict[str, float | None] = {"frames": int(db.size),
                                     "digital_silence_fraction": float(1 - live.size / max(db.size, 1))}
    for q in (5, 10, 25, 50, 75, 90):
        out[f"p{q}_dbfs"] = float(np.percentile(live, q)) if live.size else None
    return out


def slice_frames(db: np.ndarray, spans) -> np.ndarray:
    parts = [db[int(a * 100):int(b * 100)] for a, b in spans]
    return np.concatenate(parts) if parts else np.zeros(0)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("project")
    p.add_argument("track")
    p.add_argument("--pauses")
    a = p.parse_args()
    _, project = open_project(a.project)
    defaults = load_defaults()
    seen: dict[str, object] = {}
    real = bleed_fill.measure_bleed_fill

    def spy(proj, track, quiet_runs=None):
        seen["quiet_runs"] = list(quiet_runs or [])
        return real(proj, track, quiet_runs)

    bleed_fill.measure_bleed_fill = spy   # type: ignore[assignment]
    plan = build_bleed_gate_plan(project, a.track, defaults=defaults)
    track = project.track_by_id(a.track)
    path = resolve_under_workspace(project, track.media.path)
    def levels(wav) -> tuple[np.ndarray, np.ndarray]:
        x = np.concatenate(list(FFmpegEngine().stream_mono_f32(wav, sample_rate=RATE)))
        return x, frame_rms_db_stream(iter([x]), FRAME, FRAME, floor_db=DIGITAL_SILENCE_DB)

    # Two clocks: the quiet runs are on the source media's clock, the pause list on the
    # stem's (cuts removed). Read each on its own clock.
    mono, db = levels(path)
    voice_dbfs = -20 * np.log10(float(track_profile(mono, RATE).voice_gain))
    stem = project.artifacts_dir() / "tracks" / f"{a.track}.wav"
    stem_db = levels(stem)[1] if stem.exists() else None
    runs = seen.get("quiet_runs", [])
    report = {
        "reduction": str(plan.reduction),
        "bed_db_re_voice": plan.bed_db,
        "voice_level_dbfs": round(voice_dbfs, 2),
        "bed_dbfs_implied": None if plan.bed_db is None else round(plan.bed_db + voice_dbfs, 2),
        "fill": plan.fill.describe() if plan.fill else None,
        "fill_reason": plan.fill_reason,
        "whole_lane_frames": percentiles(db),
        "quiet_runs": {"count": len(runs), "seconds": round(sum(b - x for x, b in runs), 1),
                       "frames": percentiles(slice_frames(db, runs))},
    }
    if a.pauses:
        if stem_db is None:
            report["harness_pauses"] = "no stem to read the pause list on"
        else:
            report["harness_pauses_on_stem"] = percentiles(
                slice_frames(stem_db, json.load(open(a.pauses))))
    print(json.dumps(report, indent=2, default=str))


if __name__ == "__main__":
    main()
