#!/usr/bin/env python3
"""Build the one-band automatic-reduction fixture from aligned_dialogue.

The project has exactly one automatic speaker-mute band: a 3 s region on the
`reference` clip, which is trimmed to 20 s so a phone or tablet run selects it
without scrolling. The guest clip has no band. The fixtures that exist today
show "No automatic regions in this clip", so the inspector's band, its chooser
and Restore cannot be driven by hand without this one.

Usage:
  python3 scripts/build_bleed_band_fixture.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "tests" / "fixtures" / "aligned_dialogue"
DEST = ROOT / "tests" / "fixtures" / "bleed_band_demo"

CLIP_END_S = 20.0
BAND = {"start_s": 8.0, "end_s": 11.0, "fade_out_ms": 5, "fade_in_ms": 5}


def build(dest: Path) -> Path | None:
    """Write the fixture into `dest` and return its project file, or None if the source is missing."""
    if not (SRC / "episode.sharecut").is_file():
        print(f"missing source fixture: {SRC}", file=sys.stderr)
        return None
    if not (SRC / "raw" / "reference.wav").is_file():
        print(f"missing source audio under {SRC / 'raw'}", file=sys.stderr)
        return None

    dest.mkdir(parents=True, exist_ok=True)
    (dest / "raw").mkdir(exist_ok=True)
    (dest / ".gitignore").write_text("artifacts/\nhistory/\nexport/\n", encoding="utf-8")

    for name in ("reference.wav", "guest.wav"):
        link = dest / "raw" / name
        target = Path(os.path.relpath(SRC / "raw" / name, link.parent))
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to(target)

    data = json.loads((SRC / "episode.sharecut").read_text(encoding="utf-8"))
    data["meta"]["name"] = "ShareCut Studio automatic-reduction demo"
    data["meta"]["workspace_dir"] = "."

    clips = data["timeline"]["clips"]
    reference = next(clip for clip in clips if clip["track_id"] == "reference")
    reference["source_end"] = CLIP_END_S
    reference["off_speaker_mute_regions"] = [dict(BAND)]
    data["timeline"]["duration_sec"] = max(
        clip["timeline_start"] + clip["source_end"] - clip["source_start"] for clip in clips
    )

    out = dest / "episode.sharecut"
    out.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")

    (dest / "README.md").write_text(
        """# bleed_band_demo

One **automatic speaker-mute band** on a short clip, for driving the inspector's
"Automatic regions in this clip" list, the band's chooser and Restore on a phone,
tablet or desktop run. `sharecut_ux_demo` and `synthetic_bleed_60s` show
"No automatic regions in this clip".

Built from `aligned_dialogue` (audio symlinked, nothing duplicated). The
`reference` clip runs 0-20 s and carries exactly one band, 8-11 s; the `guest`
clip has none.

**Regenerate:**

```bash
python3 scripts/build_bleed_band_fixture.py
```

**Open the UI:**

```bash
podcast gui --project tests/fixtures/bleed_band_demo/episode.sharecut
```

Select the `reference` clip, then **Inspect automatic audio reduction**. Do not write
into this tree from mutating tests; copy it the way `e2e_workspace` copies
`aligned_dialogue`. The playback is the source audio: the band is project data, so
Restore and Undo work on it, but no bleed analysis has run.
""",
        encoding="utf-8",
    )

    return out


def main() -> int:
    out = build(DEST)
    if out is None:
        return 1
    sys.path.insert(0, str(ROOT / "src"))
    from podcast_mcp.project.store import ProjectStore

    project = ProjectStore(out).load()
    bands = [
        (clip.id, region)
        for clip in project.timeline.clips
        for region in clip.off_speaker_mute_regions
    ]
    assert len(bands) == 1, bands
    print(f"wrote {out} (1 band on {bands[0][0]})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
