"""Architecture guards: clip time math must stay in session_timeline (and Clip.timeline_end)."""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src" / "podcast_mcp"

# Modules allowed to contain source<->timeline mapping arithmetic.
_MAPPING_ALLOWLIST = frozenset(
    {
        "engines/session_timeline.py",
        "models/episode.py",  # Clip.timeline_end property only
    }
)

# Inline mapping patterns that must not appear outside the allowlist.
_MAPPING_PATTERNS = (
    re.compile(r"source_start\s*\+\s*\([^)]*-\s*[^)]*timeline_start"),
    re.compile(r"timeline_start\s*\+\s*\([^)]*-\s*[^)]*source_start"),
    re.compile(r"timeline_start\s*\+\s*\(\s*\w+\.source_end\s*-\s*\w+\.source_start\s*\)"),
)


def _py_files() -> list[Path]:
    return sorted(SRC_ROOT.rglob("*.py"))


def test_mapping_formula_only_in_allowlist() -> None:
    """Ad-hoc clip mapping must go through session_timeline helpers."""
    violations: list[str] = []
    for path in _py_files():
        rel = path.relative_to(SRC_ROOT).as_posix()
        if rel in _MAPPING_ALLOWLIST:
            continue
        text = path.read_text(encoding="utf-8")
        for i, line in enumerate(text.splitlines(), start=1):
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            for pat in _MAPPING_PATTERNS:
                if pat.search(line):
                    violations.append(f"{rel}:{i}: {stripped[:100]}")
    assert not violations, (
        "Clip mapping arithmetic found outside session_timeline.py / Clip.timeline_end.\n"
        "Use SessionTimeline, map_timeline_spans_over_clips, or "
        "clip_timeline_overlap_to_source instead:\n" + "\n".join(violations[:20])
    )
