#!/usr/bin/env python3
"""Merge the pieces #1088 split a bleed-lag lane into back into one timed clip (#2861).

Run ``uv run python scripts/merge_bleed_lag_pieces.py PROJECT [--apply]``. The default is a
dry run. A junction whose geometry, fades and solver artifact all match merges; any other
junction is reported with its reason and stays a plain split, and the runs on either side of
it still merge. A junction that repeats quiet source (delta > 0) now plays a room-tone hole:
a lane with one merges nothing unless ``--allow-repeat-holes`` is given, and the report
counts its holes and their seconds. Apply reloads the project under the commit lock, backs the
file up beside itself, writes through the project history (Undo restores the pieces) and exits
3 when the project is locked. A merged lane has a timing map, so ``align_tracks`` refuses it
until the timing-map aligner ships. Delete this script once the lab projects are migrated.
"""

from __future__ import annotations

import argparse
import itertools
import json
import shutil
import sys
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO / "src"))

from pydantic import ValidationError

from podcast_mcp.config.defaults import join_micro_fade_ms, load_defaults
from podcast_mcp.edits.conversation_align import align_artifact_path, ingest_alignment_meta_key
from podcast_mcp.engines.alignment_key import ingest_alignment_entry, ingest_alignment_key
from podcast_mcp.engines.clips_ops import clips_for_track, set_track_clips
from podcast_mcp.engines.mute_regions import merge_mute_regions
from podcast_mcp.models import Clip, ClipJoinMode, EpisodeProject, Track, TrackRole
from podcast_mcp.models.clip_timing import MAX_TIMING_STEPS, QuietSpan, TimingStep
from podcast_mcp.models.episode import SpeakerIngestAlignment
from podcast_mcp.project.io import resolve_project_path
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.project_state import ProjectBusyError

BAK_SUFFIX = ".pre-2861.bak"
EVIDENCE = {"bleed_lag", "bleed_lag_kept"}
EPS = 1e-6
Segments = list[dict[str, Any]]


def _artifact_lanes(project: EpisodeProject) -> dict[str, Segments] | None:
    path = align_artifact_path(project)
    if not path.is_file():
        return None
    try:
        lanes = json.loads(path.read_text(encoding="utf-8")).get("bleed_lag_segments") or {}
        return {track_id: lane.get("segments") or [] for track_id, lane in lanes.items()}
    except (OSError, ValueError, AttributeError) as error:
        raise ValueError(f"unreadable alignment artifact {path}: {error}") from error


def _shift(clip: Clip) -> float:
    return clip.timeline_start - clip.source_start


def _method(project: EpisodeProject, track: Track, clip: Clip) -> str:
    return getattr(ingest_alignment_entry(project, track, clip), "align_method", "")


def _quiet_for(segments: Segments, left: Clip, delta: float) -> tuple[QuietSpan | None, bool]:
    for before, seg in itertools.pairwise(segments):
        step = seg["shift_sec"] - before["shift_sec"]
        if (
            abs(step - delta) <= 1e-5
            and abs(seg["start_sec"] + delta / 2 - left.source_end) <= 1e-5
        ):
            gap = seg.get("gap_sec")
            return (QuietSpan(start_s=gap[0], end_s=gap[1]) if gap else None), True
    return None, False


def _merged(run: list[Clip], steps: list[TimingStep]) -> Clip:
    mutes = merge_mute_regions([m for piece in run for m in piece.mute_regions])
    off_speaker = [m for piece in run for m in piece.off_speaker_mute_regions]
    timing = {
        "steps": steps,
        "method": "bleed_lag",
        "evidence": f"merged from {len(run)} pieces (#2861)",
    }
    return Clip.model_validate(
        run[0].model_dump()
        | {
            "source_end": run[-1].source_end,
            "fade_out_ms": run[-1].fade_out_ms,
            "mute_regions": mutes,
            "timing": timing,
        }
        | ({"off_speaker_mute_regions": off_speaker} if off_speaker else {})
    )


def _reproduces(run: list[Clip], merged: Clip) -> bool:
    pieces = merged.virtual_pieces()
    if len(pieces) != len(run):
        return False
    for i, ((src_a, src_b, tl_a), old) in enumerate(zip(pieces, run, strict=True)):
        replays = i > 0 and _shift(old) > _shift(run[i - 1])
        src_a_old = run[i - 1].source_end if replays else old.source_start
        old_tl_b = old.timeline_start + old.source_end - old.source_start
        if max(abs(src_b - old.source_end), abs(src_a - src_a_old)) > EPS:
            return False
        if abs(tl_a + src_b - src_a - old_tl_b) > EPS:
            return False
    return True


def _junction(
    run: list[Clip], right: Clip, steps: list[TimingStep], segments: Segments, **opts: Any
) -> TimingStep | str:
    left = run[-1]
    delta = _shift(right) - _shift(left)
    if right.join_in_mode != ClipJoinMode.FADE:
        return "non_fade_join"
    if (left.fade_out_ms, right.fade_in_ms) != (opts["fade_ms"], opts["fade_ms"]):
        return "custom_fade"
    quiet, matched = _quiet_for(segments, left, delta)
    if not matched:
        return "no_artifact_match"
    if left.bleed_restore != right.bleed_restore:
        return "bleed_restore_differs"
    try:
        step = TimingStep(at=left.source_end, delta_sec=round(delta, 9), quiet=quiet)
    except ValidationError:
        return "no_quiet_span" if delta < 0 and quiet is None else "step_invalid"
    if len(steps) >= MAX_TIMING_STEPS:
        return "too_many_steps"
    try:
        ok = _reproduces([*run, right], _merged([*run, right], [*steps, step]))
    except ValidationError:
        return "step_invalid"
    return step if ok else "geometry_mismatch"


def _runs(
    project: EpisodeProject, track: Track, clips: list[Clip], segments: Segments, **opts: Any
) -> tuple[list[tuple[list[Clip], list[TimingStep]]], list[dict[str, Any]]]:
    runs: list[tuple[list[Clip], list[TimingStep]]] = []
    refused: list[dict[str, Any]] = []
    run, steps = [clips[0]], list[TimingStep]()
    for right in clips[1:]:
        left = run[-1]
        methods = (_method(project, track, left), _method(project, track, right))
        outcome: TimingStep | str | None = None
        if (
            left.source_id == right.source_id
            and left.segment_ref == right.segment_ref
            and abs(right.timeline_start - left.timeline_end) <= EPS
            and abs(_shift(right) - _shift(left)) > EPS
            and all(m in EVIDENCE for m in methods)
        ):
            outcome = _junction(run, right, steps, segments, **opts)
        if isinstance(outcome, TimingStep):
            run.append(right)
            steps.append(outcome)
            continue
        if outcome:
            delta = _shift(right) - _shift(left)
            refused.append({"pieces": [left.id, right.id], "delta": delta, "reason": outcome})
        runs.append((run, steps))
        run, steps = [right], []
    return [*runs, (run, steps)], refused


def _merge_lane(
    project: EpisodeProject, track: Track, artifact: dict[str, Segments] | None, **opts: Any
) -> dict[str, Any]:
    clips = clips_for_track(project, track.id)
    report: dict[str, Any] = {"lane": track.id, "pieces": len(clips), "refused": [], "runs": 0}
    skip = [
        reason
        for reason, hit in (
            ("not_dialogue", track.role != TrackRole.DIALOGUE),
            ("timeline_empty", track.timeline_empty),
            ("lane_has_timing", any(c.timing for c in clips)),
        )
        if hit
    ]
    if skip or len(clips) < 2:
        return report | {"skipped": skip[:1], "clips": len(clips)}
    segments = (artifact or {}).get(track.id) or []
    runs, report["refused"] = _runs(project, track, clips, segments, **opts)
    holes = [s.delta_sec for _, steps in runs for s in steps if s.delta_sec > 0]
    report["holes"] = {"junctions": len(holes), "hole_sec": round(sum(holes), 6)}
    if holes and not opts["allow_holes"]:
        return report | {"gated": True, "clips": len(clips)}
    merged = [(run, _merged(run, steps)) for run, steps in runs if steps]
    if not merged:
        return report | {"clips": len(clips)}
    out = [clip for run, steps in runs for clip in ([_merged(run, steps)] if steps else run)]
    meta = project.meta.ingest_alignment = project.meta.ingest_alignment or {}
    for run, clip in merged:
        methods = {_method(project, track, piece) for piece in run}
        for piece in run:
            meta.pop(ingest_alignment_key(track, piece, per_clip=True), None)
        key = ingest_alignment_meta_key(project, track, clip, multi_clip=len(out) > 1)
        meta[key] = SpeakerIngestAlignment.from_source_to_timeline_shift(
            _shift(clip),
            align_method="bleed_lag_kept" if methods == {"bleed_lag_kept"} else "bleed_lag",
        )
    set_track_clips(project, track.id, out)
    return report | {"clips": len(out), "runs": len(merged)}


def merge_project(
    project: EpisodeProject,
    *,
    lanes: Sequence[str] = (),
    allow_holes: bool = False,
    defaults: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Merge every eligible run in ``project`` in place; one report row per lane."""
    artifact = _artifact_lanes(project)
    config = load_defaults() if defaults is None else defaults
    opts = {"allow_holes": allow_holes, "fade_ms": join_micro_fade_ms(config)}
    return [
        _merge_lane(project, track, artifact, **opts)
        for track in project.tracks
        if not lanes or track.id in lanes
    ]


def _backup(path: Path) -> Path:
    target = path.with_name(path.name + BAK_SUFFIX)
    if target.exists():
        target = path.with_name(f"{target.name}.{datetime.now(UTC):%Y%m%dT%H%M%S%f}")
    shutil.copy2(path, target)
    return target


def _print(rows: list[dict[str, Any]], note: str) -> None:
    for row in rows:
        holes = row.get("holes", {})
        if row.get("skipped"):
            print(f"lane {row['lane']}: skipped ({row['skipped'][0]})")
        elif row.get("gated"):
            print(
                f"lane {row['lane']}: repeat_hole_gated, {holes['junctions']} repeat junctions "
                f"play {holes['hole_sec']:.3f} s of room-tone hole; nothing merged "
                "(--allow-repeat-holes merges the lane)"
            )
        elif row["runs"] or row["refused"]:
            print(f"lane {row['lane']}: {row['pieces']} pieces -> {row['clips']} clips")
            if holes.get("junctions"):
                print(f"  {holes['junctions']} holes, {holes['hole_sec']:.3f} s, listen here")
        for r in row["refused"]:
            print(
                f"  refused {r['pieces'][0]}|{r['pieces'][1]} delta {r['delta']:+.3f}: {r['reason']}"
            )
    print(note)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("project", help="project folder or episode.sharecut")
    parser.add_argument("--apply", action="store_true", help="write the merge (default: dry run)")
    parser.add_argument("--lane", action="append", default=[], help="only this track id")
    parser.add_argument("--json", action="store_true", help="print the report as JSON")
    parser.add_argument("--allow-repeat-holes", action="store_true", help="also merge delta > 0")
    args = parser.parse_args(argv)
    try:
        ws = ProjectWorkspace.open(resolve_project_path(args.project))
        unknown = set(args.lane) - {t.id for t in ws.project.tracks}
        if unknown:
            raise ValueError(f"unknown lane {', '.join(sorted(unknown))}")
        options = {
            "lanes": args.lane,
            "allow_holes": args.allow_repeat_holes,
            "defaults": ws.effective_config(),
        }
        note = "dry run: nothing written, re-run with --apply"
        with ws.transaction() as project:
            rows = merge_project(project.model_copy(deep=True), **options)
            if args.apply:
                note = "nothing to merge"
                if any(r["runs"] for r in rows):
                    backup = _backup(ws.path)
                    rows = ws.mutate(
                        "before bleed-lag merge",
                        "after bleed-lag merge",
                        lambda p: merge_project(p, **options),
                        operation="merge_bleed_lag_pieces",
                    )
                    note = f"merged; backup {backup.name}; merged lanes have a timing map, so align_tracks refuses them until the timing-map aligner ships"
    except ProjectBusyError:
        print("error: the project is locked by another process; nothing written", file=sys.stderr)
        return 3
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"lanes": rows, "note": note}, indent=2)) if args.json else _print(rows, note)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
