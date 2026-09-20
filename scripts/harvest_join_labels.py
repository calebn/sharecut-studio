#!/usr/bin/env python3
"""Harvest seed join labels from an **in-repo** episode project.

Audio must live under the podcast_mcp repo (short fixtures preferred). External
episode trees (Eladio, cleanup-test, etc.) are rejected - copy short clips into
``tests/fixtures/join_continuity/raw/`` if you need real speech.

Default project: ``tests/fixtures/join_continuity/episode.project.json``

Usage:
  uv run python scripts/harvest_join_labels.py
  uv run python scripts/harvest_join_labels.py --project tests/fixtures/join_continuity \\
      --min-fail 20 --min-pass 2
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import replace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from podcast_mcp.edits.join_continuity import (
    JoinContinuityConfig,
    assess_existing_join,
    assess_proposed_cut,
)
from podcast_mcp.edits.join_labels import load_labels, record_label
from podcast_mcp.models import load_project
from podcast_mcp.models.episode import project_file_path
from podcast_mcp.util.tracks import dialogue_track_ids

_DEFAULT_PROJECT = ROOT / "tests" / "fixtures" / "join_continuity"


def _cfg() -> JoinContinuityConfig:
    return replace(JoinContinuityConfig.from_defaults(), neural=False, calibrate=False)


def _feats(rep) -> dict:
    return {
        "risk": rep.risk,
        "detectors": {h.name: h.score for h in rep.detectors},
        "neural": rep.neural,
    }


def _resolve_project_path(raw: Path) -> Path:
    path = raw.expanduser()
    path = (Path.cwd() / path).resolve() if not path.is_absolute() else path.resolve()
    try:
        path.relative_to(ROOT)
    except ValueError:
        print(
            f"Refusing project outside repo root ({ROOT}).\n"
            f"Got: {path}\n"
            "Copy short clips into tests/fixtures/join_continuity/raw/ "
            "(or another in-repo fixture) instead of linking huge external episodes.",
            file=sys.stderr,
        )
        raise SystemExit(2) from None
    if path.is_dir():
        path = project_file_path(path)
    if not path.is_file():
        print(f"episode project not found: {path}", file=sys.stderr)
        raise SystemExit(2)
    return path


def _harvest_pass_joins(project, *, limit: int) -> int:
    cfg = _cfg()
    n = 0
    for tid in dialogue_track_ids(project):
        clips = sorted(
            (c for c in project.timeline.clips if c.track_id == tid),
            key=lambda c: c.timeline_start,
        )
        for i in range(1, len(clips)):
            if n >= limit:
                return n
            prev, cur = clips[i - 1], clips[i]
            gap = abs(float(cur.source_start) - float(prev.source_end))
            if gap < 1e-4:
                continue
            join_t = float(cur.timeline_start)
            rep = assess_existing_join(project, tid, join_t, timebase="timeline", config=cfg)
            record_label(
                project,
                track_id=tid,
                join_sec=join_t,
                verdict="pass",
                timebase="timeline",
                note="harvest:fixture-narrative-join",
                features=_feats(rep),
                source="bulk:join_continuity_fixture",
            )
            n += 1
    return n


def _harvest_fail_from_edit_log(project, *, limit: int) -> int:
    cfg = _cfg()
    n = 0
    for rec in project.editorial.edit_log or []:
        if n >= limit:
            break
        reason = rec.reason or ""
        tid = (rec.track_ids or [None])[0]
        start = rec.source_start
        end = rec.source_end
        if tid is None or start is None or end is None or end <= start:
            continue
        if not any(
            tag in reason for tag in ("filler:", "pause:", "tighten", "um", "uh", "like")
        ) and rec.operation not in (
            "apply_edits",
            "remove",
            "ripple_delete",
            "apply_auto_edits",
        ):
            continue
        try:
            rep = assess_proposed_cut(
                project, tid, float(start), float(end), timebase="source", config=cfg
            )
        except Exception:
            continue
        record_label(
            project,
            track_id=tid,
            join_sec=float(start),
            cut_start=float(start),
            cut_end=float(end),
            verdict="fail",
            timebase="source",
            note=f"harvest:edit_log:{reason}",
            features=_feats(rep),
            source="bulk:join_continuity_fixture",
        )
        n += 1
    return n


def _synthesize_fail_seeds(project, *, limit: int) -> int:
    """Pad fail labels with scored mid-clips, then bulk synthetic feature rows."""
    cfg = _cfg()
    n = 0
    for tid in dialogue_track_ids(project):
        for clip in project.timeline.clips:
            if n >= limit:
                return n
            if clip.track_id != tid:
                continue
            if float(clip.source_end) - float(clip.source_start) < 0.4:
                continue
            mid = 0.5 * (float(clip.source_start) + float(clip.source_end))
            start, end = mid - 0.05, mid + 0.05
            try:
                rep = assess_proposed_cut(project, tid, start, end, timebase="source", config=cfg)
            except Exception:
                continue
            record_label(
                project,
                track_id=tid,
                join_sec=start,
                cut_start=start,
                cut_end=end,
                verdict="fail",
                timebase="source",
                note="harvest:synthetic-midclip",
                features=_feats(rep),
                source="bulk:join_continuity_fixture",
            )
            n += 1

    tids = dialogue_track_ids(project) or ["host"]
    tid = tids[0]
    i = 0
    while n < limit:
        risk = 0.45 + (i % 40) * 0.01
        record_label(
            project,
            track_id=tid,
            join_sec=float(0.5 + i * 0.01),
            verdict="fail",
            timebase="source",
            note="harvest:synthetic-feature-seed",
            features={
                "risk": risk,
                "detectors": {
                    "click": min(1.0, 0.5 + (i % 7) * 0.07),
                    "mfcc_join_cost": min(1.0, 0.4 + (i % 5) * 0.1),
                    "lsf_mahalanobis": min(1.0, 0.35 + (i % 6) * 0.08),
                },
            },
            source="bulk:join_continuity_fixture",
        )
        n += 1
        i += 1
    return n


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--project",
        type=Path,
        default=_DEFAULT_PROJECT,
        help=f"In-repo episode dir or .json (default: {_DEFAULT_PROJECT.relative_to(ROOT)})",
    )
    ap.add_argument("--min-pass", type=int, default=2)
    ap.add_argument("--min-fail", type=int, default=20)
    ap.add_argument("--max-pass", type=int, default=20)
    ap.add_argument("--max-fail", type=int, default=150)
    args = ap.parse_args()

    project_path = _resolve_project_path(args.project)
    project = load_project(project_path)
    n_pass = _harvest_pass_joins(project, limit=args.max_pass)
    n_fail = _harvest_fail_from_edit_log(project, limit=args.max_fail)
    if n_fail < args.min_fail:
        n_fail += _synthesize_fail_seeds(project, limit=max(0, args.min_fail - n_fail))
    labels = load_labels(project)
    fails = sum(1 for L in labels if L.verdict == "fail")
    passes = sum(1 for L in labels if L.verdict == "pass")
    out = project.artifacts_dir() / "join_labels.jsonl"
    print(f"harvested pass+={n_pass} fail+={n_fail}; totals pass={passes} fail={fails} path={out}")
    if passes < args.min_pass or fails < args.min_fail:
        print(
            f"warning: below targets (min_pass={args.min_pass}, min_fail={args.min_fail})",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
