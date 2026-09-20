from __future__ import annotations

import re


def parse_time_sec(value: str) -> float:
    """Parse seconds as float or HH:MM:SS / MM:SS."""
    value = value.strip()
    if re.fullmatch(r"-?\d+(\.\d+)?", value):
        return float(value)
    parts = value.split(":")
    if len(parts) == 2:
        m, s = parts
        return int(m) * 60 + float(s)
    if len(parts) == 3:
        h, m, s = parts
        return int(h) * 3600 + int(m) * 60 + float(s)
    raise ValueError(f"invalid time: {value!r}")
