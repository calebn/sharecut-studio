#!/usr/bin/env python3
"""Build / refresh the Sharecut Studio UX demo fixture from aligned_dialogue.

Copies the committed smoke fixture's project shape, rewrites workspace paths,
symlinks raw WAVs (no audio duplication), and seeds UI showcase data:
pending edit, review comments, chapter, low-confidence + suppressed words,
light FX chain, and a social clip candidate.

Usage:
  python3 scripts/build_ux_demo_fixture.py
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "tests" / "fixtures" / "aligned_dialogue"
DEST = ROOT / "tests" / "fixtures" / "sharecut_ux_demo"


def _now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


def main() -> int:
    if not (SRC / "episode.project.json").is_file():
        print(f"missing source fixture: {SRC}", file=sys.stderr)
        return 1
    if not (SRC / "raw" / "reference.wav").is_file():
        print(f"missing source audio under {SRC / 'raw'}", file=sys.stderr)
        return 1

    DEST.mkdir(parents=True, exist_ok=True)
    (DEST / "raw").mkdir(exist_ok=True)
    (DEST / ".gitignore").write_text("artifacts/\nhistory/\nexport/\n", encoding="utf-8")

    for name in ("reference.wav", "guest.wav"):
        link = DEST / "raw" / name
        target = Path("..") / ".." / "aligned_dialogue" / "raw" / name
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to(target)

    data = json.loads((SRC / "episode.project.json").read_text(encoding="utf-8"))
    data["meta"]["name"] = "Sharecut Studio UX demo"
    data["meta"]["workspace_dir"] = "."
    data["meta"]["created_at"] = _now()

    # Pending cut (filler "um") - surfaces on Impact / overlay / Listen chips
    data["editorial"] = {
        "edit_decisions": [
            {
                "id": "ux_pending_um",
                "track_id": "reference",
                "type": "remove",
                "start": 22.0,
                "end": 22.2,
                "crossfade_ms": 10,
                "reason": "Filler: um",
                "review_required": True,
                "applied": False,
                "cut_confidence": 0.82,
                "boundary_mode": "inaudible",
            }
        ],
        "edit_log": [],
        "chapters": [
            {"time": 0.0, "title": "Cold open", "image_url": None},
            {"time": 21.0, "title": "Guest joins", "image_url": None},
        ],
    }

    # Low-confidence + suppressed word for Text mode chips
    for tr in data.get("transcripts", {}).get("per_track", []):
        if tr.get("track_id") != "reference":
            continue
        for w in tr.get("words", []):
            if w.get("text") == "documented":
                w["confidence"] = 0.41
            if w.get("text") == "um":
                w["suppressed"] = True
                w["audibility_status"] = "bleed_candidate"

    data["mix"] = {
        "processing_chains": [
            {
                "track_id": "reference",
                "effects": [
                    {
                        "effect": "highpass",
                        "params": {"frequency": 80},
                        "bypass": False,
                    }
                ],
            }
        ],
        "automation_envelopes": [
            {
                "track_id": "reference",
                "parameter": "volume",
                "points": [
                    {"time": 0.0, "value": 1.0},
                    {"time": 30.0, "value": 0.85},
                    {"time": 60.0, "value": 1.0},
                ],
            }
        ],
    }

    data["social"] = {
        "clip_candidates": [
            {
                "id": "ux_clip_1",
                "track_id": "reference",
                "start": 5.0,
                "end": 18.0,
                "score": 0.77,
                "reasons": ["dense dialogue", "clear hook"],
                "title_suggestion": "Why documented stories matter",
                "caption_suggestion": None,
                "transcript_excerpt": "here is why this matters for people who care about documented stories",
                "speaker": "reference",
                "review_required": True,
                "approved": False,
                "exported_path": None,
            }
        ]
    }

    ts = _now()
    data["review"] = {
        "comments": [
            {
                "id": "ux_cmt_level",
                "body": "Guest level feels low under the host here.",
                "author": "reviewer",
                "created_at": ts,
                "updated_at": None,
                "timeline_start": 22.0,
                "timeline_end": 28.0,
                "track_ids": ["guest"],
                "action_items": [
                    {
                        "id": "ux_ai_1",
                        "text": "Nudge guest gain +2 dB",
                        "done": False,
                        "completed_at": None,
                        "completed_by": None,
                    }
                ],
                "replies": [],
                "resolved": False,
                "resolved_at": None,
                "resolved_by": None,
                "review_version_id": None,
            },
            {
                "id": "ux_cmt_cut",
                "body": "Approve the filler cut after listen-through?",
                "author": "host",
                "created_at": ts,
                "updated_at": None,
                "timeline_start": 22.0,
                "timeline_end": 22.2,
                "track_ids": ["reference"],
                "action_items": [],
                "replies": [
                    {
                        "id": "ux_reply_1",
                        "body": "Playing Mix around the join first.",
                        "author": "host",
                        "created_at": ts,
                    }
                ],
                "resolved": False,
                "resolved_at": None,
                "resolved_by": None,
                "review_version_id": None,
            },
        ],
        "versions": [],
        "active_version_id": None,
    }

    # Drop duplicated top-level edit_decisions if present on older dumps
    data.pop("edit_decisions", None)

    out = DEST / "episode.project.json"
    out.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")

    (DEST / "README.md").write_text(
        """# sharecut_ux_demo

Canonical **Sharecut Studio UX showcase** fixture for the [UX Pages pack](../../../ux/README.md).

Built from `aligned_dialogue` plus seeded pending edits, comments, chapters, transcript
chips, mix/FX, and a social clip - so phone Listen / Timeline / Text / More and desktop
inspectors have something to show.

**Regenerate (keeps audio symlinked to `aligned_dialogue/raw`):**

```bash
python3 scripts/build_ux_demo_fixture.py
```

**Open the UI:**

```bash
podcast gui --project tests/fixtures/sharecut_ux_demo/episode.project.json
```

Do not write into this tree from mutating tests - copy via `e2e_workspace` patterns if needed.
Screenshots for the UX site: `make ux-demo-screens`.
""",
        encoding="utf-8",
    )

    # Validate via models when available
    try:
        sys.path.insert(0, str(ROOT / "src"))
        from podcast_mcp.project_store import ProjectStore

        proj = ProjectStore(out).load()
        assert proj.meta.name == "Sharecut Studio UX demo"
        assert any(not d.applied for d in proj.edit_decisions)
        assert proj.review and len(proj.review.comments) >= 2
        print(
            f"wrote {out} ({len(proj.edit_decisions)} pending, {len(proj.review.comments)} comments)"
        )
    except Exception as exc:
        print(f"wrote {out} (skip model validate: {exc})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
