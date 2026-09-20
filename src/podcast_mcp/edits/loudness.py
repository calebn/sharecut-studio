from __future__ import annotations

from pathlib import Path

from podcast_mcp.config import load_defaults
from podcast_mcp.engines.ffmpeg import FFmpegEngine


def check_loudness(
    audio_path: Path,
    *,
    target_lufs: float | None = None,
    true_peak_db: float | None = None,
) -> dict:
    defaults = load_defaults()
    master = defaults.get("master", {})
    target = target_lufs if target_lufs is not None else float(master.get("integrated_lufs", -16.0))
    peak_limit = (
        true_peak_db if true_peak_db is not None else float(master.get("true_peak_db", -1.5))
    )

    eng = FFmpegEngine()
    measured = eng.measure_loudness(audio_path)
    lufs_ok = measured is not None and abs(measured - target) <= 1.5
    return {
        "path": str(audio_path),
        "measured_lufs": measured,
        "target_lufs": target,
        "true_peak_limit_db": peak_limit,
        "lufs_pass": lufs_ok,
        "pass": lufs_ok,
    }
