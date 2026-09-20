from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from podcast_mcp.util.binaries import resolve_ffmpeg
from podcast_mcp.util.process import run


@dataclass(frozen=True)
class SilenceInterval:
    start: float
    end: float

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


def detect_silence(
    audio_path: Path,
    *,
    threshold_db: float = -40.0,
    min_duration_sec: float = 0.5,
    ffmpeg: str | None = None,
) -> list[SilenceInterval]:
    """Find silence intervals in source media time using FFmpeg silencedetect."""
    noise = threshold_db
    dur = min_duration_sec
    filt = f"silencedetect=noise={noise}dB:d={dur}"
    cmd = [
        ffmpeg or resolve_ffmpeg(),
        "-i",
        str(audio_path),
        "-af",
        filt,
        "-f",
        "null",
        "-",
    ]
    r = run(cmd, capture_output=True, text=True)
    text = (r.stderr or "") + (r.stdout or "")
    intervals: list[SilenceInterval] = []
    start: float | None = None
    for line in text.splitlines():
        m_start = re.search(r"silence_start:\s*([\d.]+)", line)
        if m_start:
            start = float(m_start.group(1))
            continue
        m_end = re.search(r"silence_end:\s*([\d.]+)", line)
        if m_end and start is not None:
            end = float(m_end.group(1))
            if end > start:
                intervals.append(SilenceInterval(start=start, end=end))
            start = None
    return intervals
