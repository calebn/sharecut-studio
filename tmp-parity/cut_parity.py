"""Behaviour parity probe for pure-move refactors of the cut modules (#1813).

Usage (run from the repo root of the revision under test, with the pinned FFmpeg env vars set):
    uv run --frozen python /path/to/cut_parity.py OUT.json
    uv run --frozen python /path/to/cut_parity.py OUT.json --lab-run RUNDIR [--max-each N]

With --lab-run RUNDIR (a private lab tape run from make-run.sh --prep, optionally re-timed with
the forced word aligner) the probe runs that one run instead of the committed fixtures, keeps the
real refine gate (the --prep run waives it), and approves the first N proposals singly (default
25, by start time) plus the whole set in one batch. Committed fixtures are regression pins; the
lab run is the proof.

For each committed lab tighten case it proposes tighten hits, approves every proposal through
the real cut path, then records the normalised decisions, clips, edit log and the sha256 of the
exported WAV. Run it on origin/main and on the PR head and diff the two JSON files: a pure move
must produce byte-identical output.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

REPO = Path.cwd()
sys.path.insert(0, str(REPO / "tests"))

from fixtures.lab_tighten.manifest import CASES  # noqa: E402
from podcast_mcp.edits.transcript_refine_status import REFINE_GATE  # noqa: E402
from podcast_mcp.models import load_project  # noqa: E402
from podcast_mcp.services.app import ProjectWorkspace  # noqa: E402
from podcast_mcp.services.document.edit import EditService  # noqa: E402
from podcast_mcp.services.pipeline.service import PipelineService  # noqa: E402

FIXTURES = REPO / "tests" / "fixtures" / "lab_tighten"
VOLATILE = re.compile(r"(?i)(^id$|_id$|ids$|created|updated|timestamp|uuid|workspace|path|mtime)")


def normalise(value):
    if isinstance(value, dict):
        return {k: normalise(v) for k, v in sorted(value.items()) if not VOLATILE.search(k)}
    if isinstance(value, list):
        return [normalise(v) for v in value]
    if isinstance(value, float):
        return round(value, 9)
    return value


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_case(name: str, root: Path, intensity: str, mode: str, source: Path, max_each=None) -> dict:
    workspace = root / f"{name}-{intensity}-{mode}"
    shutil.copytree(source, workspace, symlinks=True)
    project_file = workspace / "episode.project.json"
    PipelineService(ProjectWorkspace.open(project_file)).run(
        only_step="analyze_fillers_pauses",
        config={"tighten": {"enabled": True, "intensity": intensity}},
    )
    project = load_project(project_file)
    pending = [d for d in project.edit_decisions if not d.applied]
    proposals = normalise([d.model_dump(mode="json") for d in pending])
    outcomes = []
    if mode == "batch":  # every proposal in one approval, as the editor's Approve all does
        try:
            count = EditService(ProjectWorkspace.open(project_file)).approve([d.id for d in pending])
            outcomes.append({"batch": len(pending), "applied": count})
        except Exception as exc:
            outcomes.append({"batch": len(pending), "error": f"{type(exc).__name__}: {exc}"})
    else:
        pending.sort(key=lambda d: (d.start, d.end, d.id))
        for decision in pending[:max_each]:  # one at a time so a refusal is recorded, not fatal
            span = {"start": round(decision.start, 9), "end": round(decision.end, 9)}
            try:
                count = EditService(ProjectWorkspace.open(project_file)).approve([decision.id])
                outcomes.append({**span, "applied": count})
            except Exception as exc:  # the refusal text is part of the behaviour under test
                outcomes.append({**span, "error": f"{type(exc).__name__}: {exc}"})
    final = load_project(project_file)
    result = {
        "proposals": proposals,
        "outcomes": outcomes,
        "clips": normalise([c.model_dump(mode="json") for c in final.clips]),
        "decisions_after": normalise([d.model_dump(mode="json") for d in final.edit_decisions]),
    }
    try:
        exported = PipelineService(ProjectWorkspace.open(project_file)).export_audio(
            formats=[{"ext": "wav"}]
        )
        result["export_sha256"] = sorted(sha(Path(p)) for p in getattr(exported, "paths", []) or [])
    except Exception as exc:
        result["export_error"] = f"{type(exc).__name__}: {exc}"
    return result


def main() -> None:
    args = sys.argv[1:]
    out = Path(args[0])
    lab = Path(args[args.index("--lab-run") + 1]).resolve() if "--lab-run" in args else None
    max_each = int(args[args.index("--max-each") + 1]) if "--max-each" in args else 25
    report = {}
    if lab is not None:
        with tempfile.TemporaryDirectory() as tmp:
            for intensity in ("medium", "aggressive"):
                for mode in ("each", "batch"):
                    key = f"lab/{intensity}/{mode}"
                    report[key] = run_case("lab", Path(tmp), intensity, mode, lab, max_each)
        out.write_text(json.dumps(report, indent=1, sort_keys=True), encoding="utf-8")
        print(f"wrote {out}: " + ", ".join(f"{k}={len(v['proposals'])} proposals" for k, v in report.items()))
        return
    REFINE_GATE.mode = lambda defaults=None: "off"  # same gate bypass the lab fixture tests use
    with tempfile.TemporaryDirectory() as tmp:
        for case in CASES:
            for intensity in ("medium", "aggressive"):
                for mode in ("each", "batch"):
                    key = f"{case['name']}/{intensity}/{mode}"
                    report[key] = run_case(case["name"], Path(tmp), intensity, mode, FIXTURES / case["name"])
    out.write_text(json.dumps(report, indent=1, sort_keys=True), encoding="utf-8")
    print(f"wrote {out}: " + ", ".join(f"{k}={len(v['proposals'])} proposals" for k, v in report.items()))


if __name__ == "__main__":
    main()
